# substore-isp-flag

Sub-Store 操作脚本，把节点名改为「入口地区+运营商 + 原国旗」，如 `杭州电信 🇭🇰`、`美国 AWS 🇺🇸`。改名后对重名节点自动编号（从 1 开始），避免内核加载时被强制去重成 (2)(3)。

在 Sub-Store 前端「脚本/操作脚本」新建脚本，粘贴 `main.js` 后对订阅执行。查的是入口信息不是落地。

常用参数：`concurrency` `timeout` `retries` `cache` `keep_original` `region` `resolve` `doh` `number`（重名编号，默认开）`number_sep`。默认接口 `ip-api.com`。
