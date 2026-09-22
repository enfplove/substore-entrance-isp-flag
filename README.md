# substore-isp-flag

Sub-Store 操作脚本，把节点名改为「入口运营商 + 原国旗」，如 `电信 🇭🇰`、`AWS 🇺🇸`。

在 Sub-Store 前端「脚本/操作脚本」新建脚本，粘贴 `entrance-isp-flag.js` 后对订阅执行。

可选参数：`concurrency` `timeout` `retries` `cache` `keep_original` `api`（需含 `{{proxy.server}}`）。默认接口 `ip-api.com`，查的是入口信息不是落地。
