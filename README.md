# dsh-No-white-rice-allowed

峰时拦截器（hybrid 形态 bundle 插件，`@dsh-external/dsh-no-white-rice-allowed`）。

## 功能

在 DeepSeek Harness 向 DeepSeek 官方 API（`deepseek-official` provider 的
chat/completions）发起大模型请求之前，检测请求时刻的**北京时间**；若处于峰时
（默认 `9:00-12:00`、`14:00-18:00`），立即**打断**该请求（请求不会发往
`api.deepseek.com`），并弹出错误提示：

> **error：大肥鱼在吃白饭！**

## 实现原理

| 层 | 机制 |
| --- | --- |
| Host 拦截 | 监听 `llm/stream` waterfall 事件（`ctx.waterfall(..., 'llm/stream', options, () => adapterStream(...))`）。监听器抛错即中断整条请求链，且发生在任何 HTTP 请求发出之前——覆盖主会话、子代理、goal 循环等全部调用路径。 |
| 峰时判定 | `Date.now() + 8h` 取 UTC 字段换算北京时间（UTC+8），窗口 `[start, end)` 含起点不含终点。 |
| 状态路由 | `GET /no-white-rice/api/status` 返回 `{ ok, enabled, message, peak, beijingTime, peaks, blockedCount, blocked }`。 |
| Client 弹窗 | 每 2s 轮询状态路由，发现新的拦截记录即弹出红色错误 toast（8s 自动消失，可点击关闭）。 |
| 设置面板 | 设置页新增「白饭禁令」面板：总开关、当前北京时间、当前时段、峰时窗口、拦截次数、最近拦截、提示文案。 |

## 配置（cordis 插件行 config）

| 字段 | 默认 | 说明 |
| --- | --- | --- |
| `enabled` | `true` | 总开关；`false` 放行所有请求 |
| `message` | `error：大肥鱼在吃白饭！` | 拦截时抛出的错误提示文案 |
| `peaks` | `[[9,12],[14,18]]` | 峰时窗口（北京时间 `[开始小时, 结束小时)`，可多个） |

未配置时默认值在 `apply` 内兜底（loader 可能传空 config）。

## 构建与注入

```bash
# 依赖链接（junction 到运行时 node_modules）后：
npx tsc -p tsconfig.json        # host → lib/index.js（零外部 import）
npm run build:client            # client → lib/client.js（ModuleLoader 格式）
```

注入器环境内：`dev_inject_plugin E:\DeepSleep\dshNoWhiteRiceAllowed\dsh-No-white-rice-allowed`
（运行时注入：junction + loader.create，免重启；host+UI 同时生效）。

## 验证

```bash
curl http://127.0.0.1:3080/no-white-rice/api/status
# {"ok":true,"enabled":true,"message":"error：大肥鱼在吃白饭！","peak":true,
#  "beijingTime":"09:39","peaks":[[9,12],[14,18]],"blockedCount":1,"blocked":{...}}
```

峰时内发任何消息：请求被拦截，会话显示错误 + 页面弹出红色 toast。非峰时自动放行。

卸载：`dev_uninject_plugin dsh-no-white-rice-allowed`
