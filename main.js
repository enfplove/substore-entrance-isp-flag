/**
 * Sub-Store 操作脚本：入口地区+运营商 + 原节点国家/地区旗帜
 *
 * 示例结果：
 *   杭州电信 🇭🇰
 *   美国 AWS 🇺🇸
 *   CF 🇭🇰（Cloudflare 等 anycast 入口地区不可信，只显示厂商）
 *
 * 说明：
 * - 入口地区+运营商根据 proxy.server 查询，不检测落地/出口运营商。
 * - 国内入口显示「城市+运营商」（如 杭州电信）；境外入口显示「国家+运营商」（如 美国 AWS）。
 * - anycast CDN（Cloudflare/Akamai/Fastly/CloudFront/Gcore）不加地区前缀。
 * - 旗帜识别只用地区映射表（REGION_MAP）的文本关键词匹配：
 *   实测有机场把台湾标成 🇨🇳、把美国标成 🇺🇲（emoji 错、文本对），
 *   因此不再从名称里提取旗帜 emoji，一律以关键词为准；匹配不到则保留原名称。
 * - 流量/到期/官网等信息节点（Traffic/Expire/剩余流量/套餐到期/官网…）先过滤，跳过不改名。
 * - 默认使用 ip-api.com。该接口有频率限制，建议控制并发数。
 * - 改名后对重名节点自动编号（从 1 开始），避免内核加载时被强制去重成 (2)(3)。
 *
 * 可选参数：
 * - api：自定义 API 地址，必须包含 {{proxy.server}}
 * - timeout：请求超时，默认 5000 毫秒
 * - retries：失败重试次数，默认 1
 * - concurrency：并发数，默认 5
 * - keep_original：没有匹配到地区关键词时是否保留原名称，默认 true
 * - region=true：是否在运营商前加入口地区（国内=城市，境外=国家），默认 true
 * - resolve：server 为域名时是否由脚本自行解析为 IP（DoH），默认 true
 * - doh：自定义 DoH 源，逗号分隔 JSON API 地址；默认按序使用
 *   阿里(223.5.5.5) → 腾讯(doh.pub) → Cloudflare(1.1.1.1) → Google(dns.google)
 *   前两个国内直连优先，某个失败/超时自动切下一个
 * - doh_timeout：单个 DoH 源的请求超时，默认 3000 毫秒
 * - dns_cache：是否用持久缓存记录 域名→IP 解析结果，默认 true
 * - number=true：是否对重名节点自动编号（从 1 开始），默认 true
 * - number_sep：编号与名字之间的分隔符，默认空格
 */

// ---------------------------------------------------------------------------
// 地区映射表：文本关键词 → 旗帜。顺序敏感：越靠前优先级越高，
// 大意相近的地区（印度尼西亚/印度、美英、朝韩）务必把更具体的放前面。
// 已覆盖实际订阅中出现过的全部地区词（含纯英文命名 Hong Kong/Taiwan/
// United States/Johannesburg 等）。
// ---------------------------------------------------------------------------
const REGION_MAP = [
  // ---- 东亚 ----
  { cc: 'HK', flag: '🇭🇰', re: /香港|hong[\s-]*kong|\bHK\d*\b/i },
  { cc: 'MO', flag: '🇲🇴', re: /澳门|macao|macau|\bMO\d*\b/i },
  { cc: 'TW', flag: '🇹🇼', re: /台湾|taiwan|taipei|台北|新北|台中|台南|高雄|彰化|中华电信|中華電信|hinet|chunghwa|\bTW\d*\b/i },
  { cc: 'CN', flag: '🇨🇳', re: /中国(?!香港|澳门|台湾)|大陆|内地|\bCN\d*\b/i },
  { cc: 'JP', flag: '🇯🇵', re: /日本|东京|大阪|埼玉|tokyo|osaka|japan|\bJP\d*\b/i },
  { cc: 'KR', flag: '🇰🇷', re: /韩国|南韩|首尔|korea|seoul|한국|\bKR\d*\b/i },
  { cc: 'KP', flag: '🇰🇵', re: /朝鲜|北韩|north korea|\bKP\b/i },
  { cc: 'MN', flag: '🇲🇳', re: /蒙古|mongolia|\bMN\b/i },

  // ---- 东南亚 ----
  { cc: 'SG', flag: '🇸🇬', re: /新加坡|狮城|singapore|\bSG\d*\b/i },
  { cc: 'MY', flag: '🇲🇾', re: /马来西亚|大马|malaysia|\bMY\d*\b/i },
  { cc: 'TH', flag: '🇹🇭', re: /泰国|thailand|bangkok|曼谷|\bTH\b/i },
  { cc: 'ID', flag: '🇮🇩', re: /印度尼西亚|印尼|indonesia|\bID\d*\b/i },
  { cc: 'PH', flag: '🇵🇭', re: /菲律宾|philippines|\bPH\b/i },
  { cc: 'VN', flag: '🇻🇳', re: /越南|vietnam|\bVN\b/i },
  { cc: 'MM', flag: '🇲🇲', re: /缅甸|myanmar|burma|\bMM\b/i },
  { cc: 'KH', flag: '🇰🇭', re: /柬埔寨|cambodia|\bKH\b/i },
  { cc: 'LA', flag: '🇱🇦', re: /老挝|寮国|laos/i },
  { cc: 'BN', flag: '🇧🇳', re: /文莱|brunei|\bBN\b/i },

  // ---- 南亚 ----
  { cc: 'IN', flag: '🇮🇳', re: /印度(?!尼西亚)|india(?!nesia)|mumbai|孟买|\bIN\d*\b/i },
  { cc: 'PK', flag: '🇵🇰', re: /巴基斯坦|pakistan|\bPK\b/i },
  { cc: 'BD', flag: '🇧🇩', re: /孟加拉|bangladesh|\bBD\b/i },
  { cc: 'LK', flag: '🇱🇰', re: /斯里兰卡|sri lanka|\bLK\b/i },
  { cc: 'NP', flag: '🇳🇵', re: /尼泊尔|nepal|\bNP\b/i },
  { cc: 'MV', flag: '🇲🇻', re: /马尔代夫|maldives|\bMV\b/i },

  // ---- 中东 ----
  { cc: 'AE', flag: '🇦🇪', re: /阿联酋|阿拉伯联合酋长国|迪拜|dubai|emirates|u\.?a\.?e\.?|\bAE\b/i },
  { cc: 'SA', flag: '🇸🇦', re: /沙特|saudi|\bSA\b/i },
  { cc: 'QA', flag: '🇶🇦', re: /卡塔尔|qatar|\bQA\b/i },
  { cc: 'KW', flag: '🇰🇼', re: /科威特|kuwait|\bKW\b/i },
  { cc: 'BH', flag: '🇧🇭', re: /巴林|bahrain|\bBH\b/i },
  { cc: 'OM', flag: '🇴🇲', re: /阿曼|oman|\bOM\b/i },
  { cc: 'IQ', flag: '🇮🇶', re: /伊拉克|iraq|\bIQ\b/i },
  { cc: 'IR', flag: '🇮🇷', re: /伊朗|iran|\bIR\b/i },
  { cc: 'IL', flag: '🇮🇱', re: /以色列|israel|tel[\s-]*aviv|\bIL\b/i },
  { cc: 'JO', flag: '🇯🇴', re: /约旦|jordan|\bJO\b/i },
  { cc: 'TR', flag: '🇹🇷', re: /土耳其|turkey|turkiye|istanbul|伊斯坦布尔|\bTR\b/i },

  // ---- 中亚 ----
  { cc: 'KZ', flag: '🇰🇿', re: /哈萨克斯坦|哈萨克|kazakhstan|almaty|阿拉木图|\bKZ\b/i },
  { cc: 'UZ', flag: '🇺🇿', re: /乌兹别克斯坦|乌兹别克|uzbekistan|tashkent|塔什干|\bUZ\b/i },

  // ---- 欧洲 ----
  { cc: 'GB', flag: '🇬🇧', re: /英国|伦敦|united[\s-]*kingdom|britain|england|london|\bUK\d*\b/i },
  { cc: 'DE', flag: '🇩🇪', re: /德国|法兰克福|germany|frankfurt|berlin|\bDE\d*\b/i },
  { cc: 'FR', flag: '🇫🇷', re: /法国|巴黎|france|paris|\bFR\d*\b/i },
  { cc: 'NL', flag: '🇳🇱', re: /荷兰|阿姆斯特丹|netherlands|holland|amsterdam|\bNL\d*\b/i },
  { cc: 'IT', flag: '🇮🇹', re: /意大利|罗马(?!尼亚)|米兰|italy|rome(?!nia)|milan|\bIT\b/i },
  { cc: 'ES', flag: '🇪🇸', re: /西班牙|马德里|spain|madrid|\bES\b/i },
  { cc: 'PT', flag: '🇵🇹', re: /葡萄牙|portugal|lisbon|\bPT\b/i },
  { cc: 'CH', flag: '🇨🇭', re: /瑞士|苏黎世|switzerland|zurich|\bCH\b/i },
  { cc: 'SE', flag: '🇸🇪', re: /瑞典|斯德哥尔摩|sweden|stockholm|\bSE\b/i },
  { cc: 'NO', flag: '🇳🇴', re: /挪威|norway|oslo|\bNO\b/i },
  { cc: 'FI', flag: '🇫🇮', re: /芬兰|finland|helsinki|\bFI\b/i },
  { cc: 'DK', flag: '🇩🇰', re: /丹麦|denmark|copenhagen|\bDK\b/i },
  { cc: 'IS', flag: '🇮🇸', re: /冰岛|iceland|reykjavik|\bIS\b/i },
  { cc: 'IE', flag: '🇮🇪', re: /爱尔兰|ireland|dublin|\bIE\b/i },
  { cc: 'AT', flag: '🇦🇹', re: /奥地利|维也纳|austria|vienna|\bAT\b/i },
  { cc: 'BE', flag: '🇧🇪', re: /比利时|brussels|belgium|\bBE\b/i },
  { cc: 'PL', flag: '🇵🇱', re: /波兰|华沙|poland|warsaw|\bPL\b/i },
  { cc: 'CZ', flag: '🇨🇿', re: /捷克|prague|czech|\bCZ\b/i },
  { cc: 'HU', flag: '🇭🇺', re: /匈牙利|hungary|budapest|\bHU\b/i },
  { cc: 'RO', flag: '🇷🇴', re: /罗马尼亚|romania|bucharest|\bRO\b/i },
  { cc: 'BG', flag: '🇧🇬', re: /保加利亚|bulgaria|sofia|\bBG\b/i },
  { cc: 'GR', flag: '🇬🇷', re: /希腊|greece|athens|\bGR\b/i },
  { cc: 'LU', flag: '🇱🇺', re: /卢森堡|luxembourg|\bLU\b/i },
  { cc: 'MD', flag: '🇲🇩', re: /摩尔多瓦|moldova|\bMD\b/i },
  { cc: 'LT', flag: '🇱🇹', re: /立陶宛|lithuania|vilnius|\bLT\b/i },
  { cc: 'LV', flag: '🇱🇻', re: /拉脱维亚|latvia|riga|\bLV\b/i },
  { cc: 'EE', flag: '🇪🇪', re: /爱沙尼亚|estonia|tallinn|\bEE\b/i },
  { cc: 'RS', flag: '🇷🇸', re: /塞尔维亚|serbia|belgrade|\bRS\b/i },
  { cc: 'HR', flag: '🇭🇷', re: /克罗地亚|croatia|zagreb|\bHR\b/i },
  { cc: 'SI', flag: '🇸🇮', re: /斯洛文尼亚|slovenia|\bSI\b/i },
  { cc: 'MK', flag: '🇲🇰', re: /北马其顿|马其顿|macedonia|\bMK\b/i },
  { cc: 'AL', flag: '🇦🇱', re: /阿尔巴尼亚|albania|tirana|\bAL\b/i },
  { cc: 'GE', flag: '🇬🇪', re: /格鲁吉亚|georgia|tbilisi|\bGE\b/i },
  { cc: 'AM', flag: '🇦🇲', re: /亚美尼亚|armenia|yerevan|\bAM\b/i },
  { cc: 'UA', flag: '🇺🇦', re: /乌克兰|ukraine|kyiv|kiev|\bUA\b/i },
  { cc: 'RU', flag: '🇷🇺', re: /俄罗斯|莫斯科|圣彼得堡|russia|moscow|saint[\s-]*petersburg|\bRU\b/i },

  // ---- 北美 ----
  { cc: 'US', flag: '🇺🇸', re: /美国|美东|美西|united[\s-]*states|los[\s-]*angeles|san[\s-]*jose|san[\s-]*diego|seattle|chicago|dallas|miami|houston|new[\s-]*york|phoenix|硅谷|洛杉矶|圣何塞|西雅图|纽约|达拉斯|芝加哥|凤凰城|\bUS\d*\b|\bUSA\b|u\.s\.a\.?/i },
  { cc: 'CA', flag: '🇨🇦', re: /加拿大|canada|toronto|vancouver|montreal|多伦多|温哥华|\bCA\d*\b/i },
  { cc: 'MX', flag: '🇲🇽', re: /墨西哥|mexico|\bMX\b/i },
  { cc: 'PA', flag: '🇵🇦', re: /巴拿马|panama|\bPA\b/i },

  // ---- 南美 ----
  { cc: 'BR', flag: '🇧🇷', re: /巴西|brazil|sao[\s-]*paulo|rio|圣保罗|\bBR\b/i },
  { cc: 'AR', flag: '🇦🇷', re: /阿根廷|argentina|buenos[\s-]*aires|\bAR\b/i },
  { cc: 'CL', flag: '🇨🇱', re: /智利|chile|santiago|\bCL\b/i },
  { cc: 'CO', flag: '🇨🇴', re: /哥伦比亚|colombia|bogota|\bCO\b/i },
  { cc: 'PE', flag: '🇵🇪', re: /秘鲁|peru|lima|\bPE\b/i },
  { cc: 'EC', flag: '🇪🇨', re: /厄瓜多尔|ecuador|quito|\bEC\b/i },
  { cc: 'CR', flag: '🇨🇷', re: /哥斯达黎加|costa[\s-]*rica|\bCR\b/i },
  { cc: 'UY', flag: '🇺🇾', re: /乌拉圭|uruguay|montevideo|\bUY\b/i },

  // ---- 大洋洲 ----
  { cc: 'AU', flag: '🇦🇺', re: /澳大利亚|澳洲|悉尼|墨尔本|australia|sydney|melbourne|\bAU\d*\b/i },
  { cc: 'NZ', flag: '🇳🇿', re: /新西兰|new[\s-]*zealand|auckland|奥克兰|\bNZ\b/i },
  { cc: 'FJ', flag: '🇫🇯', re: /斐济|fiji|\bFJ\b/i },

  // ---- 非洲 ----
  { cc: 'ZA', flag: '🇿🇦', re: /南非|south[\s-]*africa|johannesburg|约翰内斯堡|开普敦|capetown|\bZA\b/i },
  { cc: 'EG', flag: '🇪🇬', re: /埃及|egypt|cairo|开罗|\bEG\b/i },
  { cc: 'NG', flag: '🇳🇬', re: /尼日利亚|nigeria|lagos|\bNG\b/i },
  { cc: 'MA', flag: '🇲🇦', re: /摩洛哥|morocco|casablanca|\bMA\b/i },
  { cc: 'DZ', flag: '🇩🇿', re: /阿尔及利亚|algeria|\bDZ\b/i },
  { cc: 'TN', flag: '🇹🇳', re: /突尼斯|tunisia|\bTN\b/i },
  { cc: 'KE', flag: '🇰🇪', re: /肯尼亚|kenya|nairobi|\bKE\b/i },
  { cc: 'MU', flag: '🇲🇺', re: /毛里求斯|mauritius|\bMU\b/i },
  { cc: 'AO', flag: '🇦🇴', re: /安哥拉|angola|\bAO\b/i },
  { cc: 'CY', flag: '🇨🇾', re: /塞浦路斯|cyprus|\bCY\b/i },
]

// 流量/到期/官网等信息节点：先筛掉，跳过不处理
const INFO_NODE_RE = /traffic|expire|剩余|到期|重置|官网|订阅|invalid|失效|失効/i

async function operator(proxies = [], targetPlatform, context) {
  const $ = $substore
  const timeout = Number($arguments.timeout || 5000)
  const retries = Number($arguments.retries ?? 1)
  const concurrency = Math.max(1, Number($arguments.concurrency || 5))
  const keepOriginal = String($arguments.keep_original ?? 'true') !== 'false'
  const regionEnabled = String($arguments.region ?? 'true') !== 'false'
  const cacheEnabled = String($arguments.cache ?? 'true') !== 'false'
  const cache = typeof scriptResourceCache !== 'undefined' ? scriptResourceCache : null
  const numberEnabled = String($arguments.number ?? 'true') !== 'false'
  const numberSep = $arguments.number_sep ?? ' '
  const apiTemplate =
    $arguments.api ||
    'http://ip-api.com/json/{{proxy.server}}?lang=zh-CN&fields=status,message,country,countryCode,city,regionName,isp,org,as,asname,hosting,proxy,mobile'

  // ---- DNS 自解析：域名节点先经多 DoH 源解析为 IP，再交给入口 API ----
  const resolveEnabled = String($arguments.resolve ?? 'true') !== 'false'
  const dohTimeout = Number($arguments.doh_timeout || 3000)
  const dnsCacheEnabled = String($arguments.dns_cache ?? 'true') !== 'false'
  const DOH_SOURCES = ($arguments.doh
    ? String($arguments.doh).split(',').map(u => ({ url: u.trim() }))
    : [
        { name: 'aliyun', url: 'https://223.5.5.5/resolve?name={{domain}}&type=1' },
        { name: 'tencent', url: 'https://120.53.53.53/dns-query?name={{domain}}&type=1' },
        { name: 'cloudflare', url: 'https://1.1.1.1/dns-query?name={{domain}}&type=A' },
        { name: 'google', url: 'https://dns.google/resolve?name={{domain}}&type=1' },
      ]
  ).filter(s => s.url)
  const dnsCache = new Map() // 本次运行内的 域名→IP 缓存

  await runWithConcurrency(
    proxies.map(proxy => () => checkProxy(proxy)),
    concurrency
  )

  // 改名完成后统一编号：对最终重名的节点从 1 开始追加序号
  if (numberEnabled) numberDuplicates()

  return proxies

  async function checkProxy(proxy) {
    if (!proxy || !proxy.server || !proxy.name) return

    const originalName = String(proxy.name)
    // 信息节点（流量/到期/官网等）先筛掉，不查询不改名
    if (INFO_NODE_RE.test(originalName)) return

    // 旗帜只靠地区映射表的关键词匹配，不做 emoji 提取
    const flag = getOriginalFlag(originalName)
    if (!flag && keepOriginal) return

    try {
      const serverForApi = resolveEnabled ? await resolveServer(proxy.server) : proxy.server
      const cacheKey = `entrance-isp-v2:${serverForApi}` // v2: 响应含 city/country 地区字段，与旧缓存隔离
      const cached = cacheEnabled && cache?.get(cacheKey)
      const body = cached || parseBody(await requestWithRetry(
        apiTemplate.replace(/\{\{proxy\.server\}\}/g, String(serverForApi))
      ))

      if (!cached && cacheEnabled && body && body.status !== 'fail') cache?.set(cacheKey, body)

      if (!body || body.status === 'fail') {
        throw new Error(body?.message || 'API 返回无效结果')
      }

      const provider = classifyProvider(body)
      if (!provider) return

      const region = regionPrefix(body, provider)
      proxy.name = flag ? `${region}${provider} ${flag}` : `${region}${provider}`
      $.info(`[${originalName}] ${proxy.name}`)
    } catch (error) {
      $.error(`[${originalName}] 入口运营商检测失败: ${error?.message || error}`)
    }
  }

  // 对重名节点从 1 开始编号；只出现一次的名字保持不变
  function numberDuplicates() {
    const counts = new Map()
    for (const p of proxies) {
      if (!p || !p.name) continue
      counts.set(p.name, (counts.get(p.name) || 0) + 1)
    }
    const seen = new Map()
    for (const p of proxies) {
      if (!p || !p.name) continue
      if (counts.get(p.name) > 1) {
        const base = p.name
        const n = (seen.get(base) || 0) + 1
        seen.set(base, n)
        p.name = `${base}${numberSep}${n}`
      }
    }
  }

  function parseBody(response) {
    const raw = response?.body ?? response?.data ?? response
    if (raw && typeof raw === 'object') return raw
    try {
      return JSON.parse(String(raw || '{}'))
    } catch (_) {
      return null
    }
  }

  // 入口地区前缀：国内=城市（去掉省市区县后缀），境外=国家；anycast CDN 地区不可信不加
  function regionPrefix(info, provider) {
    if (!regionEnabled) return ''
    const asText = [info.isp, info.org, info.as, info.asname].filter(Boolean).join(' ')
    if (/cloudflare|akamai|fastly|cloudfront|\bgcore\b/i.test(asText)) return ''
    // 百度云 IP 的 ip-api 城市常错记成北京西城（实际多在广东），按需只显示“百度云”不写城市
    if (provider === '百度云') return ''
    const cc = String(info.countryCode || '').toUpperCase()
    if (cc === 'CN' || info.country === '中国') {
      const city = String(info.city || info.regionName || '')
        .replace(/(特别行政区|自治区|省|市|区|县)$/i, '')
        .trim()
      return city
    }
    return info.country ? `${info.country} ` : ''
  }

  function classifyProvider(info) {
    const text = [info.isp, info.org, info.as, info.asname].filter(Boolean).join(' ')
    const normalized = text.toLowerCase()

    // 鹏博士旗下/相关宽带名称优先判断，避免被宽泛的 broadband 规则覆盖。
    if (
      /长城宽带|great wall broadband|greatwall broadband|gwbn|鹏博士|dr\.?\s*peng|drpeng|d-peng|pengnet/i.test(text)
    ) {
      return '鹏博士'
    }

    // 云厂商优先于普通 ISP。返回统一、简短的厂商名称。
    const cloudRules = [
      [/amazon web services|amazon aws|\baws\b|amazon-?com|amazon technologies/i, 'AWS'],
      [/microsoft azure|\bazure\b|microsoft corporation/i, 'Azure'],
      [/google cloud|google llc|google inc|google asia/i, 'Google Cloud'],
      [/oracle cloud|oracle corporation|oracle public cloud/i, 'Oracle Cloud'],
      [/alibaba cloud|aliyun|阿里云/i, '阿里云'],
      [/tencent cloud|腾讯云/i, '腾讯云'],
      [/huawei cloud|华为云/i, '华为云'],
      [/百度|baidu/i, '百度云'],
      [/digitalocean/i, 'DigitalOcean'],
      [/vultr|choopa/i, 'Vultr'],
      [/linode|akamai connected cloud/i, 'Linode'],
      [/hetzner/i, 'Hetzner'],
      [/ovh/i, 'OVH'],
      [/contabo/i, 'Contabo'],
      [/rackspace/i, 'Rackspace'],
      [/leaseweb/i, 'Leaseweb'],
      [/cloudflare/i, 'Cloudflare'],
      [/upcloud/i, 'UpCloud'],
      [/scaleway/i, 'Scaleway'],
      // 国内云厂商
      [/金山云|kingsoft cloud|ksyun/i, '金山云'],
      [/京东云|jd\s*cloud|jdcloud/i, '京东云'],
      [/火山引擎|volcengine|volcano engine|bytedance|字节跳动/i, '火山引擎'],
      [/ucloud|优刻得/i, 'UCloud'],
      [/青云|qingcloud/i, '青云'],
      [/天翼云|ctyun/i, '天翼云'],
      [/移动云|china mobile cloud/i, '移动云'],
      [/联通云|沃云|unicom cloud/i, '联通云'],
      [/世纪互联|21vianet/i, '世纪互联'],
      [/网宿|wangsu/i, '网宿'],
      // 国际云/主机商
      [/\bibm\b|softlayer/i, 'IBM Cloud'],
      [/\bg-?core\b|gcorelabs/i, 'Gcore'],
      [/zenlayer/i, 'Zenlayer'],
      [/racknerd/i, 'RackNerd'],
      [/\bbuyvm\b|frantech/i, 'BuyVM'],
      [/greencloud/i, 'GreenCloud'],
      [/hosthatch/i, 'HostHatch'],
      [/kamatera/i, 'Kamatera'],
      [/\bnetcup\b/i, 'netcup'],
      [/\bm247\b/i, 'M247'],
      [/\bakamai\b/i, 'Akamai'],
      [/\bfastly\b/i, 'Fastly'],
      [/腾讯云|阿里云|华为云/i, '云厂商'],
    ]
    for (const [rule, name] of cloudRules) {
      if (rule.test(text)) return name
    }

    // hosting=true 但没有命中具体厂商时，也直接标记为云厂商。
    if (info.hosting === true || info.hosting === 'true') return '云厂商'

    // 运营商归一化。
    const ispRules = [
      [/中国电信|china telecom|chinanet|ctgnet|telecom argentina/i, '电信'],
      [/中国联通|china unicom|cncgroup|cucc|unicom/i, '联通'],
      [/中国移动|china mobile|cmnet|cmcc/i, '移动'],
      [/中国广电|china broadcasting/i, '广电'],
      [/中国铁通|china tietong|china railcom/i, '铁通'],
      [/中国教育和科研计算机网|china education and research|\bcernet\b/i, '教育网'],
    ]
    for (const [rule, name] of ispRules) {
      if (rule.test(text)) return name
    }

    // 其他地区常见宽带/运营商，可按需要继续补充。
    const otherRules = [
      [/comcast/i, 'Comcast'],
      [/\batt\b|at&t/i, 'AT&T'],
      [/verizon/i, 'Verizon'],
      [/\btelefonica\b/i, 'Telefonica'],
      [/\bdeutsche telekom\b/i, 'Deutsche Telekom'],
      [/\borange\b/i, 'Orange'],
      [/\bbt\b|british telecommunications/i, 'BT'],
    ]
    for (const [rule, name] of otherRules) {
      if (rule.test(normalized)) return name
    }

    // 未知 ISP 返回 asname/组织名，避免把有效入口全部标成“未知”。
    return String(info.asname || info.org || info.isp || '').trim() || '未知运营商'
  }

  // 旗帜识别：只用地区映射表的文本关键词匹配（机场 emoji 常标错，不提取 emoji）
  function getOriginalFlag(name) {
    for (const entry of REGION_MAP) {
      if (entry.re.test(name)) return entry.flag
    }
    return ''
  }

  // 判断是否为 IP 字面量（v4 或 v6），避免依赖运行环境的 ProxyUtils
  function isIPLiteral(s) {
    const str = String(s || '')
    if (/^\d{1,3}(\.\d{1,3}){3}$/.test(str)) return true
    return str.includes(':') && /^[0-9a-fA-F:]+$/.test(str)
  }

  // 域名 → IP：依次尝试多个 DoH 源（JSON API），命中即返回；全部失败回退原域名
  async function resolveServer(server) {
    try {
      if (!server) return server
      if (isIPLiteral(server)) return server

      const domain = String(server)
      if (dnsCache.has(domain)) return dnsCache.get(domain)

      if (dnsCacheEnabled && cache) {
        const cachedIp = cache.get(`entrance-dns:${domain}`)
        if (cachedIp && isIPLiteral(cachedIp)) {
          dnsCache.set(domain, cachedIp)
          $.info(`[DNS] ${domain} -> ${cachedIp}（持久缓存）`)
          return cachedIp
        }
      }

      for (const source of DOH_SOURCES) {
        try {
          const res = await $.http.get({
            url: source.url.replace(/\{\{domain\}\}/g, encodeURIComponent(domain)),
            timeout: dohTimeout,
            headers: { accept: 'application/dns-json' },
          })
          const raw = res?.body ?? res?.data ?? res
          let data = {}
          try {
            data = typeof raw === 'object' ? raw : JSON.parse(String(raw || '{}'))
          } catch (_) {}
          const answers = data.Answer || []
          const record = answers.find(a => a && Number(a.type) === 1 && isIPLiteral(a.data) && a.data !== '0.0.0.0')
          if (record) {
            const ip = record.data
            dnsCache.set(domain, ip)
            if (dnsCacheEnabled && cache) cache.set(`entrance-dns:${domain}`, ip)
            $.info(`[DNS] ${domain} -> ${ip}（${source.name || 'custom'}）`)
            return ip
          }
          $.info(`[DNS] ${source.name || 'custom'} 未返回 ${domain} 的 A 记录，切换下一源`)
        } catch (e) {
          $.info(`[DNS] ${source.name || 'custom'} 解析 ${domain} 失败: ${e?.message || e}，切换下一源`)
        }
      }
      $.error(`[DNS] ${domain} 所有 DoH 源均失败，回退原域名`)
    } catch (e) {
      $.error(`[DNS] ${server} 解析异常: ${e?.message || e}`)
    }
    return server
  }

  function requestWithRetry(url) {
    let attempt = 0
    const run = async () => {
      try {
        return await $.http.get({
          url,
          timeout,
          headers: { 'User-Agent': 'Sub-Store-Entrance-ISP-Checker' },
        })
      } catch (error) {
        if (attempt++ < retries) {
          await $.wait(1000 * attempt)
          return run()
        }
        throw error
      }
    }
    return run()
  }

  function runWithConcurrency(tasks, limit) {
    return new Promise(resolve => {
      let next = 0
      let running = 0

      const schedule = () => {
        while (running < limit && next < tasks.length) {
          running++
          tasks[next++]()
            .catch(() => {})
            .finally(() => {
              running--
              if (next >= tasks.length && running === 0) resolve()
              else schedule()
            })
        }
      }
      schedule()
      if (!tasks.length) resolve()
    })
  }
}
