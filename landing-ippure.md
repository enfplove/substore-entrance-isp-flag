# 落地 IP 风险检测（IPPure）

本仓库主脚本 `entrance-isp-flag.js` 查的是**入口**运营商。若想在节点名里加**落地** IP 的风险评分，用折腾鲨的落地检测脚本 `geo.js` 配合 IPPure 接口即可，无需改代码。

落地检测需请求经过节点发出，因此仅在支持 `ability=http-client-policy` 的环境有效：Loon、Surge，或 Node.js 版 Sub-Store 配合 HTTP META。

## 接口

`https://my.ippure.com/v1/info`（无需鉴权，返回 JSON）。查的是调用者出口 IP，放进落地检测后即为该节点落地信息。

返回字段：

- `fraudScore` 风险分 0-100，越高越差
- `isResidential` 是否住宅 IP（true/false）
- `isBroadcast` 是否广播 IP
- `country` / `countryCode` 落地国家
- `asOrganization` 落地 ASN 组织
- `city` 落地城市

> 注：该接口自称测试阶段，字段可能变动；评分为其主观合成，参考即可。

## 用法

在 Sub-Store 订阅的「脚本」里加操作脚本，链接后接参数：

```
https://raw.githubusercontent.com/xream/scripts/main/surge/modules/sub-store-scripts/check/geo.js#api=https%3A%2F%2Fmy.ippure.com%2Fv1%2Finfo&format={{api.countryCode}} - {{proxy.name}} {{api.fraudScore}}&concurrency=5&timeout=8000
```

`format` 支持 eval，可用三元表达式。示例（已实测渲染）：

| format | 结果 |
| --- | --- |
| `{{api.countryCode}} - {{proxy.name}} {{api.fraudScore}}` | `HK - 香港01 🇭🇰 85` |
| `{{proxy.name}} {{api.fraudScore}}` | `香港01 🇭🇰 85` |

## 注意

- 落地检测每个节点都要实际走一次代理连接，慢且耗流量，`concurrency` 别开太高。
- 这是落地检测，与入口脚本 `entrance-isp-flag.js` 用途不同，不要混用。

## Android root 模块（HTTP META）用法

若使用 Sub-Store for Android（Magisk/KernelSU 模块，自带 HTTP META），**不能用上面的 `geo.js`**，要用 `http_meta_geo.js` 并指向本机 HTTP META（默认端口 9876）。

在 Sub-Store 前端对订阅添加「操作脚本」，选「链接」类型，粘贴：

```
https://raw.githubusercontent.com/xream/scripts/main/surge/modules/sub-store-scripts/check/http_meta_geo.js#http_meta_protocol=http&http_meta_host=127.0.0.1&http_meta_port=9876&http_meta_start_delay=3000&http_meta_proxy_timeout=10000&api=https%3A%2F%2Fmy.ippure.com%2Fv1%2Finfo&format={{api.countryCode}} - {{proxy.name}} {{api.fraudScore}}&concurrency=5&timeout=8000
```

结果示例：`HK - 香港01 🇭🇰 85`。

- `http_meta_port` 要与模块 `sub_store.env` 里的 `PORT` 一致（默认 9876）。
- `geo.js` 是 Loon/Surge（需 http-client-policy 模块）用的；Android root 模块用 `http_meta_geo.js`。
