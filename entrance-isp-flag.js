/**
 * Sub-Store 操作脚本：入口运营商 + 原节点国家国旗
 *
 * 示例结果：
 *   电信 🇭🇰
 *   AWS 🇺🇸
 *   鹏博士 🇭🇰
 *
 * 说明：
 * - 入口运营商根据 proxy.server 查询，不检测落地/出口运营商。
 * - 原节点国家国旗从原节点名称中提取；没有识别到国旗时保留原名称。
 * - 默认使用 ip-api.com。该接口有频率限制，建议控制并发数。
 *
 * 可选参数：
 * - api：自定义 API 地址，必须包含 {{proxy.server}}
 * - timeout：请求超时，默认 5000 毫秒
 * - retries：失败重试次数，默认 1
 * - concurrency：并发数，默认 5
 * - keep_original：没有识别到原国家国旗时是否保留原名称，默认 true
 */
async function operator(proxies = [], targetPlatform, context) {
  const $ = $substore
  const timeout = Number($arguments.timeout || 5000)
  const retries = Number($arguments.retries ?? 1)
  const concurrency = Math.max(1, Number($arguments.concurrency || 5))
  const keepOriginal = String($arguments.keep_original ?? 'true') !== 'false'
  const cacheEnabled = String($arguments.cache ?? 'true') !== 'false'
  const cache = typeof scriptResourceCache !== 'undefined' ? scriptResourceCache : null
  const apiTemplate =
    $arguments.api ||
    'http://ip-api.com/json/{{proxy.server}}?lang=zh-CN&fields=status,message,countryCode,isp,org,as,asname,hosting,proxy,mobile'

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
      const cacheKey = `entrance-isp:${proxy.server}`
      const cached = cacheEnabled && cache?.get(cacheKey)
      const body = cached || parseBody(await requestWithRetry(
        apiTemplate.replace(/\{\{proxy\.server\}\}/g, String(proxy.server))
      ))

      if (!cached && cacheEnabled && body) cache?.set(cacheKey, body)

      if (!body || body.status === 'fail') {
        throw new Error(body?.message || 'API 返回无效结果')
      }

      const provider = classifyProvider(body)
      if (!provider) return

      // 没有原国旗时，keep_original=false 会使用无旗帜名称；默认配置会直接保留原名。
      proxy.name = flag ? `${provider} ${flag}` : provider
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
