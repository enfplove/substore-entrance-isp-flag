# substore-isp-flag

Sub-Store 操作脚本，把节点名改为「入口运营商 + 原国旗 + 落地评分」，如 `杭州电信 🇭🇰 85`、`美国 AWS 🇺🇸 12`。

在 Sub-Store 前端「脚本/操作脚本」新建脚本，粘贴 `main.js` 后对订阅执行。该脚本合并了入口运营商检测与落地 fraudScore 检测两个阶段，评分置于名称末尾。

- 入口阶段：按 `proxy.server` 查入口地区+运营商，从原名提取国旗。
- 落地阶段：通过 HTTP META 拨号节点，从落地 IP 查 fraudScore，追加到名字末尾（Sub-Store Node.js 版 / Android root 模块）。

常用参数：`entrance` `landing`（阶段开关）`cache` `keep_original` `region` `remove_failed` `score_field` `score_prefix`，以及入口/落地各自的 `entrance_*` / `landing_*` 前缀参数。落地默认接口 `my.ippure.com`。详细参数见 `main.js` 头部注释与 `landing-ippure.md`。
