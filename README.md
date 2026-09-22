# substore-isp-flag

Sub-Store 操作脚本，把节点名改为「入口地区+运营商 + 原节点地区旗帜」，如 `杭州电信 🇭🇰`、`美国 AWS 🇺🇸`。改名后对重名节点自动编号（从 1 开始），避免内核加载时被强制去重成 (2)(3)。

在 Sub-Store 前端「脚本/操作脚本」新建脚本，粘贴 `main.js` 后对订阅执行。查的是入口信息不是落地。

## 旗帜识别：只做关键词匹配

旗帜来自内置地区映射表（`REGION_MAP`，70+ 国家/地区）对**原节点名**的文本关键词匹配，不从名称里提取旗帜 emoji。原因：实测有机场 emoji 标错而文本是对的（如 `🇨🇳 台湾Y01`、`🇺🇲 美国Y01`、`🇨🇳 Taiwan`），关键词优先可以自动纠正。

- 覆盖中文名、英文名（Hong Kong / Taiwan / United States / Johannesburg…）、城市名（台北/东京/首尔/法兰克福…）和常见国家代码（US01 / HK2 / TW1…）。
- 匹配不到关键词的节点保留原名（`keep_original=true` 时）。

## 信息节点过滤

改名前先筛掉流量/到期类信息节点（`Traffic`/`Expire`/`剩余流量`/`套餐到期`/`官网`/`重置`/`订阅`/`失效`），不查询也不改名，避免出现 `广州电信 🇬🇧`（GB 被误当英国）这类错误。

常用参数：`concurrency` `timeout` `retries` `cache` `keep_original` `region` `resolve` `doh` `number`（重名编号，默认开）`number_sep`。默认接口 `ip-api.com`。
