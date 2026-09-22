/**
 * Sub-Store 操作脚本：入口地区+运营商 + 原节点国家国旗
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
 * - 原节点国家国旗从原节点名称中提取；没有识别到国旗时保留原名称。
 * - 默认使用 ip-api.com。该接口有频率限制，建议控制并发数。
 *
 * 可选参数：
 * - api：自定义 API 地址，必须包含 {{proxy.server}}
 * - timeout：请求超时，默认 5000 毫秒
 * - retries：失败重试次数，默认 1
 * - concurrency：并发数，默认 5
 * - keep_original：没有识别到原国家国旗时是否保留原名称，默认 true
 * - region=true：是否在运营商前加入口地区（国内=城市，境外=国家），默认 true
 * - resolve：server 为域名时是否由脚本自行解析为 IP（DoH），默认 true
 * - doh：自定义 DoH 源，逗号分隔 JSON API 地址；默认按序使用
 *   阿里(223.5.5.5) → 腾讯(doh.pub) → Cloudflare(1.1.1.1) → Google(dns.google)
 *   前两个国内直连优先，某个失败/超时自动切下一个
 * - doh_timeout：单个 DoH 源的请求超时，默认 3000 毫秒
 * - dns_cache：是否用持久缓存记录 域名→IP 解析结果，默认 true
 */
async function operator(proxies = [], targetPlatform, context) {
  const $ = $substore
  const timeout = Number($arguments.timeout || 5000)
  const retries = Number($arguments.retries ?? 1)
  const concurrency = Math.max(1, Number($arguments.concurrency || 5))
  const keepOriginal = String($arguments.keep_original ?? 'true') !== 'false'
  const regionEnabled = String($arguments.region ?? 'true') !== 'false'
  const cacheEnabled = String($arguments.cache ?? 'true') !== 'false'
  const cache = typeof scriptResourceCache !== 'undefined' ? scriptResourceCache : null
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

  return proxies

  async function checkProxy(proxy) {
    if (!proxy || !proxy.server || !proxy.name) return

    const originalName = String(proxy.name)
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
      // 没有原国旗时，keep_original=false 会使用无旗帜名称；默认配置会直接保留原名。
      proxy.name = flag ? `${region}${provider} ${flag}` : `${region}${provider}`
      $.info(`[${originalName}] ${proxy.name}`)
    } catch (error) {
      $.error(`[${originalName}] 入口运营商检测失败: ${error?.message || error}`)
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

  function getOriginalFlag(name) {
    // 先提取标准区域指示符国旗，例如 🇭🇰、🇺🇸、🇯🇵。
    const flags = name.match(/[\u{1F1E6}-\u{1F1FF}]{2}/gu)
    if (flags?.length) return flags[flags.length - 1]

    // 兼容节点名称使用国家代码或中文国家名的情况。
    const aliases = [
      [/香港|hong[\s-]*kong|\bHK\b/i, '🇭🇰'],
      [/澳门|macao|macau|\bMO\b/i, '🇲🇴'],
      [/台湾|taiwan|\bTW\b/i, '🇹🇼'],
      [/日本|japan|\bJP\b/i, '🇯🇵'],
      [/韩国|南韩|south korea|\bKR\b/i, '🇰🇷'],
      [/新加坡|singapore|\bSG\b/i, '🇸🇬'],
      [/美国|美国|united states|\bUSA?\b|\bUS\b/i, '🇺🇸'],
      [/英国|united kingdom|\bUK\b|\bGB\b/i, '🇬🇧'],
      [/德国|germany|\bDE\b/i, '🇩🇪'],
      [/法国|france|\bFR\b/i, '🇫🇷'],
      [/荷兰|netherlands|holland|\bNL\b/i, '🇳🇱'],
      [/加拿大|canada|\bCA\b/i, '🇨🇦'],
      [/澳大利亚|澳洲|australia|\bAU\b/i, '🇦🇺'],
      [/俄罗斯|russia|\bRU\b/i, '🇷🇺'],
      [/土耳其|turkey|\bTR\b/i, '🇹🇷'],
      [/印度|india|\bIN\b/i, '🇮🇳'],
      [/越南|vietnam|\bVN\b/i, '🇻🇳'],
      [/泰国|thailand|\bTH\b/i, '🇹🇭'],
      [/菲律宾|philippines|\bPH\b/i, '🇵🇭'],
      [/马来西亚|malaysia|\bMY\b/i, '🇲🇾'],
      [/印度尼西亚|印尼|indonesia|\bID\b/i, '🇮🇩'],
    ]
    for (const [rule, flag] of aliases) {
      if (rule.test(name)) return flag
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
