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
https://raw.githubusercontent.com/xream/scripts/main/surge/modules/sub-store-scripts/check/geo.js#api=https%3A%2F%2Fmy.ippure.com%2Fv1%2Finfo&format={{api.countryCode}} {{api.asOrganization}} 风险{{api.fraudScore}} - {{proxy.name}}&concurrency=5&timeout=8000
```

`format` 支持 eval，可用三元表达式。示例（已实测渲染）：

| format | 结果 |
| --- | --- |
| `{{api.countryCode}} {{api.asOrganization}} 风险{{api.fraudScore}} - {{proxy.name}}` | `HK Kirino LLC 风险85 - 香港01 🇭🇰` |
| `{{proxy.name}} 险{{api.fraudScore}}{{api.isResidential ? "住宅" : "机房"}}` | `香港01 🇭🇰 险85机房` |
| `{{api.country}} {{api.asOrganization}} [{{api.fraudScore}}]` | `Hong Kong SAR China Kirino LLC [85]` |

## 注意

- 落地检测每个节点都要实际走一次代理连接，慢且耗流量，`concurrency` 别开太高。
- 这是落地检测，与入口脚本 `entrance-isp-flag.js` 用途不同，不要混用。
