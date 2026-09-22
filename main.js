/**
 * Sub-Store 操作脚本：入口运营商+国旗 + 落地 fraudScore（合并版）
 *
 * 合并自 enfplove/substore-isp-flag 的两个脚本：
 *   - entrance-isp-flag.js：按 proxy.server 查入口地区+运营商，名字改为「运营商 🇭🇰」
 *   - landing-isp-flag.js：用 HTTP META 拨号节点，从落地 IP 查 fraudScore
 *
 * 最终名称：入口运营商 + 原国旗 + 落地评分（评分在最后），如：
 *   杭州电信 🇭🇰 85
 *   美国 AWS 🇺🇸 12
 *
 * 执行顺序：先做入口检测重命名，再启动 HTTP META 做落地检测并把评分追加到名字末尾。
 * 适用于 Sub-Store Node.js 版 / Android root 模块（落地检测需 HTTP META 配合）。
 *
 * ========== 阶段开关 ==========
 * - [entrance] 是否做入口运营商+国旗检测. 默认 true
 * - [landing]  是否做落地 fraudScore 检测. 默认 true
 * - [cache]    是否使用缓存（两个阶段共用）. 默认 true
 *
 * ========== 入口检测参数（entrance_ 前缀） ==========
 * - [entrance_api]         自定义入口 API，必须含 {{proxy.server}}. 默认 ip-api.com
 * - [entrance_timeout]     请求超时(ms). 默认 5000
 * - [entrance_retries]     失败重试次数. 默认 1
 * - [entrance_concurrency] 并发数. 默认 5
 * - [keep_original]        没识别到原国旗时是否保留原名. 默认 true
 * - [region]               运营商前是否加入口地区(国内=城市/境外=国家). 默认 true
 * - [resolve]              server 为域名时是否用 DoH 自解析为 IP. 默认 true
 * - [doh]                  自定义 DoH 源(逗号分隔). 默认 阿里→腾讯→CF→Google
 * - [doh_timeout]          单个 DoH 源超时(ms). 默认 3000
 * - [dns_cache]            是否持久缓存 域名→IP. 默认 true
 *
 * ========== 落地检测参数（landing_ 前缀 + HTTP META） ==========
 * - [http_meta_protocol]        协议. 默认 http
 * - [http_meta_host]            服务地址. 默认 127.0.0.1
 * - [http_meta_port]            端口. 默认 9876
 * - [http_meta_authorization]   Authorization. 默认无
 * - [http_meta_start_delay]     启动延时(ms). 默认 3000
 * - [http_meta_proxy_timeout]   每节点耗时预算(ms). 默认 10000
 * - [landing_api]               落地 API. 默认 https://my.ippure.com/v1/info
 * - [landing_method]            请求方法. 默认 get
 * - [landing_timeout]           请求超时(ms). 默认 5000
 * - [landing_retries]           重试次数. 默认 1
 * - [landing_retry_delay]       重试延时(ms). 默认 1000
 * - [landing_concurrency]       并发数. 默认 10
 * - [score_field]               从落地 API 响应取评分的字段路径. 默认 fraudScore
 * - [score_prefix]              评分前缀(拼到名字前的分隔). 默认 空格
 * - [include_unsupported_proxy] 传给核心时包含官方不支持协议. 默认 false
 * - [remove_failed]             移除落地检测失败(未拿到评分)的节点. 默认 false
 */
async function operator(proxies = [], targetPlatform, context) {
  const $ = $substore
  const cacheEnabled = String($arguments.cache ?? 'true') !== 'false'
  const cache = typeof scriptResourceCache !== 'undefined' ? scriptResourceCache : null
  const doEntrance = String($arguments.entrance ?? 'true') !== 'false'
  const doLanding = String($arguments.landing ?? 'true') !== 'false'

  // ============================================================
  // 阶段一：入口地区+运营商 + 原国旗
  // ============================================================
  if (doEntrance) {
    await runEntrance()
  }

  // ============================================================
  // 阶段二：落地 fraudScore（HTTP META），追加到名字末尾
  // ============================================================
  if (doLanding) {
    await runLanding()
  }

  return proxies

  // ------------------------------------------------------------
  // 入口检测实现
  // ------------------------------------------------------------
  async function runEntrance() {
    const timeout = Number($arguments.entrance_timeout || $arguments.timeout || 5000)
    const retries = Number($arguments.entrance_retries ?? $arguments.retries ?? 1)
    const concurrency = Math.max(1, Number($arguments.entrance_concurrency || 5))
    const keepOriginal = String($arguments.keep_original ?? 'true') !== 'false'
    const regionEnabled = String($arguments.region ?? 'true') !== 'false'
    const apiTemplate =
      $arguments.entrance_api ||
      'http://ip-api.com/json/{{proxy.server}}?lang=zh-CN&fields=status,message,country,countryCode,city,regionName,isp,org,as,asname,hosting,proxy,mobile'

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
    const dnsCache = new Map()

    await runWithConcurrency(
      proxies.map(proxy => () => checkProxy(proxy)),
      concurrency
    )

    async function checkProxy(proxy) {
      if (!proxy || !proxy.server || !proxy.name) return
      const originalName = String(proxy.name)
      const flag = getOriginalFlag(originalName)
      if (!flag && keepOriginal) return
      try {
        const serverForApi = resolveEnabled ? await resolveServer(proxy.server) : proxy.server
        const cacheKey = `entrance-isp-v2:${serverForApi}`
        const cached = cacheEnabled && cache?.get(cacheKey)
        const body =
          cached ||
          parseBody(await requestWithRetry(apiTemplate.replace(/\{\{proxy\.server\}\}/g, String(serverForApi))))
        if (!cached && cacheEnabled && body && body.status !== 'fail') cache?.set(cacheKey, body)
        if (!body || body.status === 'fail') {
          throw new Error(body?.message || 'API 返回无效结果')
        }
        const provider = classifyProvider(body)
        if (!provider) return
        const region = regionPrefix(body, provider)
        proxy.name = flag ? `${region}${provider} ${flag}` : `${region}${provider}`
        $.info(`[入口][${originalName}] ${proxy.name}`)
      } catch (error) {
        $.error(`[入口][${originalName}] 检测失败: ${error?.message || error}`)
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
      if (
        /长城宽带|great wall broadband|greatwall broadband|gwbn|鹏博士|dr\.?\s*peng|drpeng|d-peng|pengnet/i.test(text)
      ) {
        return '鹏博士'
      }
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
      if (info.hosting === true || info.hosting === 'true') return '云厂商'
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
      return String(info.asname || info.org || info.isp || '').trim() || '未知运营商'
    }

    function isIPLiteral(s) {
      const str = String(s || '')
      if (/^\d{1,3}(\.\d{1,3}){3}$/.test(str)) return true
      return str.includes(':') && /^[0-9a-fA-F:]+$/.test(str)
    }

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
          return await $.http.get({ url, timeout, headers: { 'User-Agent': 'Sub-Store-Entrance-ISP-Checker' } })
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
  }

  // ------------------------------------------------------------
  // 落地检测实现（HTTP META）
  // ------------------------------------------------------------
  async function runLanding() {
    const includeUnsupportedProxy = $arguments.include_unsupported_proxy
    const remove_failed = $arguments.remove_failed
    const http_meta_host = $arguments.http_meta_host ?? '127.0.0.1'
    const http_meta_port = $arguments.http_meta_port ?? 9876
    const http_meta_protocol = $arguments.http_meta_protocol ?? 'http'
    const http_meta_authorization = $arguments.http_meta_authorization ?? ''
    const http_meta_api = `${http_meta_protocol}://${http_meta_host}:${http_meta_port}`
    const http_meta_start_delay = parseFloat($arguments.http_meta_start_delay ?? 3000)
    const http_meta_proxy_timeout = parseFloat($arguments.http_meta_proxy_timeout ?? 10000)
    const method = $arguments.landing_method || $arguments.method || 'get'
    const url = $arguments.landing_api || 'https://my.ippure.com/v1/info'
    const scoreField = $arguments.score_field || 'fraudScore'
    const scorePrefix = $arguments.score_prefix ?? ' '

    const internalProxies = []
    proxies.map((proxy, index) => {
      try {
        const node = ProxyUtils.produce([{ ...proxy }], 'ClashMeta', 'internal', {
          'include-unsupported-proxy': includeUnsupportedProxy,
        })?.[0]
        if (node) {
          for (const key in proxy) {
            if (/^_/i.test(key)) {
              node[key] = proxy[key]
            }
          }
          internalProxies.push({ ...node, _proxies_index: index })
        } else {
          proxies[index]._incompatible = true
        }
      } catch (e) {
        $.error(e)
      }
    })
    $.info(`[落地] 核心支持节点数: ${internalProxies.length}/${proxies.length}`)
    if (!internalProxies.length) return

    const http_meta_timeout = http_meta_start_delay + internalProxies.length * http_meta_proxy_timeout
    let http_meta_pid
    let http_meta_ports = []

    const res = await http({
      retries: 0,
      method: 'post',
      url: `${http_meta_api}/start`,
      headers: { 'Content-type': 'application/json', Authorization: http_meta_authorization },
      body: JSON.stringify({ proxies: internalProxies, timeout: http_meta_timeout }),
    })
    let body = res.body
    try {
      body = JSON.parse(body)
    } catch (e) {}
    const { ports, pid } = body
    if (!pid || !ports) {
      throw new Error(`======== HTTP META 启动失败 ====\n${body}`)
    }
    http_meta_pid = pid
    http_meta_ports = ports
    $.info(
      `\n======== HTTP META 启动 ====\n[端口] ${ports}\n[PID] ${pid}\n[超时] 若未手动关闭 ${
        Math.round(http_meta_timeout / 60 / 10) / 100
      } 分钟后自动关闭\n`
    )
    $.info(`等待 ${http_meta_start_delay / 1000} 秒后开始落地检测`)
    await $.wait(http_meta_start_delay)

    const concurrency = parseInt($arguments.landing_concurrency || 10)
    await executeAsyncTasks(
      internalProxies.map(proxy => () => check(proxy)),
      { concurrency }
    )

    try {
      const stopRes = await http({
        method: 'post',
        url: `${http_meta_api}/stop`,
        headers: { 'Content-type': 'application/json', Authorization: http_meta_authorization },
        body: JSON.stringify({ pid: [http_meta_pid] }),
      })
      $.info(`\n======== HTTP META 关闭 ====\n${JSON.stringify(stopRes, null, 2)}`)
    } catch (e) {
      $.error(e)
    }

    if (remove_failed) {
      proxies = proxies.filter(p => p._landing_ok || (!remove_failed && p._incompatible))
    }
    proxies.forEach(p => {
      delete p._landing_ok
      delete p._incompatible
    })

    async function check(proxy) {
      const idx = proxy._proxies_index
      const name = proxies[idx].name
      const cacheKey = cacheEnabled ? `landing-score:${url}:${scoreField}:${nodeKey(proxy)}` : undefined
      try {
        if (cacheEnabled && cacheKey) {
          const cached = cache?.get(cacheKey)
          if (cached) {
            if (cached.score !== undefined && cached.score !== null && cached.score !== '') {
              proxies[idx].name = `${name}${scorePrefix}${cached.score}`
              proxies[idx]._landing_ok = true
              $.info(`[落地][${name}] 使用缓存评分: ${cached.score}`)
            }
            return
          }
        }
        const index = internalProxies.indexOf(proxy)
        const startedAt = Date.now()
        const res = await http({
          proxy: `http://${http_meta_host}:${http_meta_ports[index]}`,
          method,
          headers: {
            'User-Agent':
              'Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.3.1 Mobile/15E148 Safari/604.1',
          },
          url,
        })
        const status = parseInt(res.status || res.statusCode || 200)
        let api = String(lodash_get(res, 'body'))
        try {
          api = JSON.parse(api)
        } catch (e) {}
        const score = lodash_get(api, scoreField)
        $.info(`[落地][${name}] status: ${status}, latency: ${Date.now() - startedAt}ms, ${scoreField}: ${score}`)
        if (status == 200 && score !== undefined && score !== null && score !== '') {
          proxies[idx].name = `${name}${scorePrefix}${score}`
          proxies[idx]._landing_ok = true
          if (cacheEnabled && cacheKey) cache?.set(cacheKey, { score })
        } else if (cacheEnabled && cacheKey) {
          cache?.set(cacheKey, {})
        }
      } catch (e) {
        $.error(`[落地][${name}] ${e.message ?? e}`)
        if (cacheEnabled && cacheKey) cache?.set(cacheKey, {})
      }
    }

    function nodeKey(proxy) {
      return JSON.stringify(
        Object.fromEntries(
          Object.entries(proxy).filter(([key]) => !/^(collectionName|subName|id|_.*)$/i.test(key))
        )
      )
    }

    async function http(opt = {}) {
      const METHOD = opt.method || 'get'
      const TIMEOUT = parseFloat(opt.timeout || $arguments.landing_timeout || $arguments.timeout || 5000)
      const RETRIES = parseFloat(opt.retries ?? $arguments.landing_retries ?? $arguments.retries ?? 1)
      const RETRY_DELAY = parseFloat(opt.retry_delay ?? $arguments.landing_retry_delay ?? 1000)
      let count = 0
      const fn = async () => {
        try {
          return await $.http[METHOD]({ ...opt, timeout: TIMEOUT })
        } catch (e) {
          if (count < RETRIES) {
            count++
            await $.wait(RETRY_DELAY * count)
            return await fn()
          } else {
            throw e
          }
        }
      }
      return await fn()
    }
  }

  // ------------------------------------------------------------
  // 公共工具
  // ------------------------------------------------------------
  function getOriginalFlag(name) {
    const flags = name.match(/[\u{1F1E6}-\u{1F1FF}]{2}/gu)
    if (flags?.length) return flags[flags.length - 1]
    const aliases = [
      [/香港|hong[\s-]*kong|\bHK\b/i, '🇭🇰'],
      [/澳门|macao|macau|\bMO\b/i, '🇲🇴'],
      [/台湾|taiwan|\bTW\b/i, '🇹🇼'],
      [/日本|japan|\bJP\b/i, '🇯🇵'],
      [/韩国|南韩|south korea|\bKR\b/i, '🇰🇷'],
      [/新加坡|singapore|\bSG\b/i, '🇸🇬'],
      [/美国|united states|\bUSA?\b|\bUS\b/i, '🇺🇸'],
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

  function lodash_get(source, path, defaultValue = undefined) {
    const paths = String(path).replace(/\[(\d+)\]/g, '.$1').split('.')
    let result = source
    for (const p of paths) {
      result = Object(result)[p]
      if (result === undefined) {
        return defaultValue
      }
    }
    return result
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

  function executeAsyncTasks(tasks, { concurrency = 1 } = {}) {
    return new Promise((resolve, reject) => {
      try {
        let running = 0
        let index = 0
        function executeNextTask() {
          while (index < tasks.length && running < concurrency) {
            const currentTask = tasks[index++]
            running++
            currentTask()
              .catch(() => {})
              .finally(() => {
                running--
                executeNextTask()
              })
          }
          if (running === 0) {
            return resolve()
          }
        }
        executeNextTask()
      } catch (e) {
        reject(e)
      }
    })
  }
}
