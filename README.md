# dsh-No-white-rice-allowed

峰时拦截器（hybrid 形态 bundle 插件，`@dsh-external/dsh-no-white-rice-allowed`）。

## 功能

在 DeepSeek Harness 向 DeepSeek 官方 API（`deepseek-official` provider 的
chat/completions）发起大模型请求之前，检测请求时刻的**北京时间**；若处于峰时
（默认 `9:00-12:00`、`14:00-18:00`），立即**打断**该请求（请求不会发往
`api.deepseek.com`），并弹出错误提示：

> **error：大肥鱼在吃白饭！**

⚠️ **峰时内安装后立即生效**：当前若处于峰时（北京时间 9:00-12:00、14:00-18:00），
安装完成后的所有 DeepSeek 请求都会被拦截（包括你自己发消息），12:00 / 18:00 后
自动放行。建议在非峰时安装，或安装后直接进入验证流程。

---

## 安装

### 方式一：dsh 内部指令（推荐，无需命令行）

在 DSH Web GUI 的会话输入框里，直接把下面的文本指令发给 agent（它会用
`dev_install_package` 完成 bundle 持久安装，免重启热装配，重启后仍由
`dsh.profile.bundles` 自动装配）：

```
请用 dev_install_package 安装插件 E:\DeepSleep\dshNoWhiteRiceAllowed\dsh-No-white-rice-allowed 到 web profile
```

或更简单的口语化指令：

```
帮我安装插件 E:\DeepSleep\dshNoWhiteRiceAllowed\dsh-No-white-rice-allowed（持久 bundle 安装）
```

### 方式二：dsh CLI 命令行

前置要求：`pnpm` 在 PATH（`npm i -g pnpm` 或 corepack 启用；本机可从
`E:\DeepSleep\dshNoWhiteRiceAllowed\tools\node_modules\.bin` 取用）。

```bash
# 从插件目录的父级执行（或直接用绝对路径）
dsh plugin --profile web add link:E:\DeepSleep\dshNoWhiteRiceAllowed\dsh-No-white-rice-allowed
```

`dsh plugin` 会：① 初始化 profile → ② 在 profile 目录转发给
`pnpm add link:<目录>`（写入 `dependencies` + 建立 node_modules junction）→
③ 自动 reconcile：识别到插件声明的 `dsh.bundle.patch`，把它追加进
`dsh.profile.bundles` 层栈。**重启 harness 后**由 bundle 装配自动加载插件行
（`cordis.patch.yml`），host + client 同时生效。

支持的其他参数形态：registry 包名（发布后 `dsh plugin --profile web add @dsh-external/dsh-no-white-rice-allowed`）、
git 地址、tgz 路径、相对路径（相对你执行命令的目录）。

### 方式三：运行时注入（免重启，适合临时试用）

在 GUI 会话里对 agent 说：

```
请用 dev_inject_plugin 注入 E:\DeepSleep\dshNoWhiteRiceAllowed\dsh-No-white-rice-allowed
```

`dev_inject_plugin` 立即注入（host+UI 同时生效，无需重启）；注入清单持久化，
重启后自动恢复。与方式一/二共存时自动去重。

---

## 验证

```bash
curl http://127.0.0.1:3080/no-white-rice/api/status
# {"ok":true,"enabled":true,"message":"error：大肥鱼在吃白饭！","peak":true,
#  "beijingTime":"09:39","peaks":[[9,12],[14,18]],"blockedCount":1,"blocked":{...}}
```

- `peak: true` = 当前处于峰时，请求将被拦截
- 峰时内发任何消息：请求被拦截，会话显示错误 + 页面弹出红色 toast
- 设置页 →「白饭禁令」面板可看实时状态（需刷新页面加载 client 端）

---

## 卸载

| 方式 | 指令 |
| --- | --- |
| dsh 内部指令 | `请用 dev_uninject_plugin 卸载 dsh-no-white-rice-allowed` |
| dsh CLI | `dsh plugin --profile web remove @dsh-external/dsh-no-white-rice-allowed`（自动从 bundles 移除，重启生效） |

---

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

## 构建与打包

```bash
# 依赖链接（junction 到运行时 node_modules）后：
npx tsc -p tsconfig.json        # host → lib/index.js（零外部 import）
npm run build:client            # client → lib/client.js（ModuleLoader 格式）
npm pack                        # 产出 dsh-external-dsh-no-white-rice-allowed-<version>.tgz
```

发布：在 GitHub 仓库 `dubykun888/dsh-No-white-rice-allowed` 创建 Release
（tag `v0.0.1`），把 tgz 作为附件上传；发布后即可用 registry 方式安装：
`dsh plugin --profile web add @dsh-external/dsh-no-white-rice-allowed`。
