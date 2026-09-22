# 落地 IP 风险检测（IPPure）

本仓库主脚本 `entrance-isp-flag.js` 查的是**入口**运营商；`landing-isp-flag.js` 查的是节点**落地** IP，并把 IPPure 的风险评分接到节点名末尾。

`landing-isp-flag.js` fork 自折腾鲨的 `http_meta_geo.js`，已内置默认值，直接引用即可，无需再带一长串参数：

- 默认 api：`https://my.ippure.com/v1/info`
- 默认 format：`{{api.countryCode}} - {{proxy.name}} {{api.fraudScore}}`
- 结果示例：`HK - 香港01 🇭🇰 85`

## 环境要求

落地检测需请求经过节点发出，只在能配合 HTTP META 的环境有效：

- Sub-Store Node.js 版
- Android root 模块（Sub-Store for Android，自带 HTTP META，默认端口 9876）

App 版（Loon/Surge）请改用原作者 `geo.js`。

## 用法

在 Sub-Store 前端对订阅添加「脚本操作」，选「链接」类型，粘贴：

```
https://raw.githubusercontent.com/enfplove/substore-isp-flag/master/landing-isp-flag.js
```

默认 HTTP META 为 `127.0.0.1:9876`，与 Android root 模块一致，通常无需改动。若端口不同，追加参数覆盖，例如：

```
...landing-isp-flag.js#http_meta_port=9877
```

## 可覆盖参数

| 参数 | 说明 | 默认 |
| --- | --- | --- |
| `api` | 落地检测接口 | `https://my.ippure.com/v1/info` |
| `format` | 命名格式，从 `api`/`proxy` 取值 | `{{api.countryCode}} - {{proxy.name}} {{api.fraudScore}}` |
| `http_meta_host` | HTTP META 地址 | `127.0.0.1` |
| `http_meta_port` | HTTP META 端口 | `9876` |
| `concurrency` | 并发数 | `10` |
| `timeout` | 单节点超时(ms) | `5000` |

IPPure 返回可用字段：`fraudScore`（0-100，越高越差）、`isResidential`、`isBroadcast`、`country`/`countryCode`、`asOrganization`、`city`。

## 注意

- 落地检测每个节点都要实际走一次代理连接，慢且耗流量，`concurrency` 别开太高。
- IPPure 接口自称测试阶段，字段可能变动；评分为其主观合成，参考即可。
- 与入口脚本 `entrance-isp-flag.js` 用途不同，不要混用。
