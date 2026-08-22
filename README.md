# dsh-No-white-rice-allowed

峰时拦截器（hybrid 形态 bundle 插件，`@dsh-external/dsh-no-white-rice-allowed`）。

## 功能

在 DeepSeek Harness 向 DeepSeek 官方 API（`deepseek-official` provider 的
chat/completions）发起大模型请求之前，检测请求时刻的**北京时间**；若处于峰时
（默认 `9:00-12:00`、`14:00-18:00`）且为**工作日（周一至周五）**，立即**打断**该请求
（请求不会发往 `api.deepseek.com`），并弹出错误提示：

> **error：大肥鱼在吃白饭！**

- **周末（周六、周日）全天谷价，自动放行**（不拦截）
- 设置页「白饭禁令」面板提供**总开关**：关闭时全时段不生效（运行时生效并持久化，重启保持）

⚠️ **峰时内安装后立即生效**：工作日若处于峰时（北京时间 9:00-12:00、14:00-18:00），
安装完成后的所有 DeepSeek 请求都会被拦截（包括你自己发消息），12:00 / 18:00 后
自动放行。可在「白饭禁令」面板关闭开关临时放行。

---

## 安装（GitHub Release 直装，无需构建）

**安装来源**：GitHub Release 附件 tgz（已包含构建好的 `lib/` + `cordis.patch.yml`
+ bundle 声明，解压即用，**不需要重新构建**）：

```
https://github.com/dubykun888/dsh-No-white-rice-allowed/releases/download/v0.0.1/dsh-external-dsh-no-white-rice-allowed-0.0.1.tgz
```

> 🌐 网络提示：GitHub 直连失败时，给下载命令加上代理（本机常用
> `-Proxy http://127.0.0.1:7892`），或直接在浏览器下载 tgz 后按"方式三"安装。

### 方式一：dsh 内部指令（推荐，无需命令行）

在 DSH Web GUI 的会话输入框里，直接把下面的文本指令发给 agent（它会下载
Release tgz → 解压 → 用 `dev_install_package` 完成 bundle 持久安装，免重启
热装配，重启后仍由 `dsh.profile.bundles` 自动装配）：

```
请从 https://github.com/dubykun888/dsh-No-white-rice-allowed/releases/download/v0.0.1/dsh-external-dsh-no-white-rice-allowed-0.0.1.tgz 下载插件包并解压到工作区（注意 tgz 内是 package/ 目录），然后用 dev_install_package 安装解压出的 package 目录，安装到 web profile
```

或更简单的口语化指令（agent 会自动完成下载→解压→安装）：

```
帮我从 GitHub Release 下载并安装 dsh-no-white-rice-allowed 插件（v0.0.1，tgz 直装，无需构建）
```

### 方式二：dsh CLI 命令行（从 Release 附件直接安装）

前置要求：`pnpm` 在 PATH（`npm i -g pnpm` 或 corepack 启用）。

```bash
dsh plugin --profile web add https://github.com/dubykun888/dsh-No-white-rice-allowed/releases/download/v0.0.1/dsh-external-dsh-no-white-rice-allowed-0.0.1.tgz
```

`dsh plugin` 会：① 初始化 profile → ② 在 profile 目录转发给 `pnpm add <tgz URL>`
（下载 tgz → 解压 → 写入 `dependencies` + 建立 node_modules junction）→
③ 自动 reconcile：识别到插件声明的 `dsh.bundle.patch`，把它追加进
`dsh.profile.bundles` 层栈。**重启 harness 后**由 bundle 装配自动加载插件行
（`cordis.patch.yml`），host + client 同时生效。

> 已手动下载了 tgz 的，也可以用本地文件：`dsh plugin --profile web add link:E:\path\to\dsh-external-dsh-no-white-rice-allowed-0.0.1.tgz`

### 方式三：手动下载 + 运行时注入（免重启，适合临时试用）

1. 浏览器下载上面 URL 的 tgz（或用 PowerShell：`Invoke-WebRequest -Uri <URL> -Proxy http://127.0.0.1:7892 -OutFile dsh-no-white-rice-allowed.tgz`）
2. 解压：`tar -xf dsh-no-white-rice-allowed.tgz`（得到 `package/` 目录）
3. 在 GUI 会话里对 agent 说：

```
请用 dev_inject_plugin 注入 <解压出的 package 目录路径>
```

`dev_inject_plugin` 立即注入（host+UI 同时生效，无需重启）；注入清单持久化，
重启后自动恢复。与方式一/二共存时自动去重。

---

## 验证

```bash
curl http://127.0.0.1:3080/no-white-rice/api/status
# {"ok":true,"enabled":true,"message":"error：大肥鱼在吃白饭！","weekdaysOnly":true,"peak":true,
#  "weekday":true,"dayOfWeek":1,"isBusy":true,"beijingTime":"09:39","peaks":[[9,12],[14,18]],...}
```

- `isBusy: true` = 当前（开关开 + 工作日 + 峰时）会被拦截
- `weekday: false`（周末）= 全天谷价放行，即使处于峰时也不拦截
- 峰时内发任何消息：请求被拦截，会话显示错误 + 页面弹出红色 toast
- 设置页 →「白饭禁令」面板可开关拦截、看实时状态（需刷新页面加载 client 端）

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
| 工作日判定 | 同一北京时间计算星期几（`getUTCDay()`，0=周日…6=周六），仅工作日（周一至周五）拦截；周末全天谷价放行。 |
| 状态路由 | `GET /no-white-rice/api/status` 返回 `{ ok, enabled, message, weekdaysOnly, peak, weekday, dayOfWeek, isBusy, beijingTime, peaks, blockedCount, blocked }`。 |
| 设置路由 | `POST /no-white-rice/api/settings`（JSON `{ enabled }`）运行时开/关拦截，持久化到 `<DSH_HOME>/super-injector/dsh-no-white-rice-allowed.json`。 |
| Client 弹窗 | 每 2s 轮询状态路由，发现新的拦截记录即弹出红色错误 toast（8s 自动消失，可点击关闭）。 |
| 设置面板 | 设置页「白饭禁令」面板：启用/关闭开关 + 实时状态（北京时间/星期、生效范围、峰时窗口、拦截次数、最近拦截、提示文案）。 |

## 配置（cordis 插件行 config）

| 字段 | 默认 | 说明 |
| --- | --- | --- |
| `enabled` | `true` | 总开关初值；`false` 全时段放行（设置页开关可运行时修改并持久化） |
| `weekdaysOnly` | `true` | 仅工作日（周一至周五）拦截；周末全天谷价放行 |
| `message` | `error：大肥鱼在吃白饭！` | 拦截时抛出的错误提示文案 |
| `peaks` | `[[9,12],[14,18]]` | 峰时窗口（北京时间 `[开始小时, 结束小时)`，可多个） |

未配置时默认值在 `apply` 内兜底（loader 可能传空 config）。

## 构建与打包（仅维护者需要）

```bash
npm install --legacy-peer-deps   # 安装 typescript / tsdown / @types/node
npx tsc -p tsconfig.json         # host → lib/index.js（零外部 import，自包含构建）
npm run build:client             # client → lib/client.js（ModuleLoader 格式）
npm pack                         # 产出 dsh-external-dsh-no-white-rice-allowed-<version>.tgz
```

发布：在 GitHub 仓库 `dubykun888/dsh-No-white-rice-allowed` 创建 Release
（tag `v0.0.1`），把 tgz 作为附件上传。用户安装时直接使用 Release 附件 URL
（见上文「安装」章节），**无需重新构建**。
