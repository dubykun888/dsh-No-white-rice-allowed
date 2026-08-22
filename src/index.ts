/**
 * @dsh-external/dsh-no-white-rice-allowed — 峰时拦截器（hybrid）。
 *
 * 功能：在 DeepSeek Harness 向 DeepSeek 官方 API（deepseek-official provider 的
 * chat/completions）发起大模型请求之前，检测请求时刻的北京时间；若处于峰时
 * （默认 9:00-12:00、14:00-18:00）且为工作日（周一至周五），立即打断该请求
 * （waterfall 抛错，请求不会发往 api.deepseek.com），并弹出错误提示：
 * "error：大肥鱼在吃白饭！"。
 *
 * 实现：
 *  - `llm/stream` 是 dsh-llm 的 waterfall 事件，监听器抛错即中断整条请求链，
 *    且发生在任何 HTTP 请求发出之前——覆盖主会话、子代理、goal 循环等全部调用路径。
 *  - 拦截记录保存在内存中，并通过 webServer 路由 `/no-white-rice/api/*` 暴露：
 *    `GET /status` 返回状态；`POST /settings` 运行时开/关拦截并持久化；
 *    `GET /icon` 返回插件 media 的 DeepSeek 图标（client 指示器用）。
 *  - 每次请求经 `llm/stream` 时记录最近路由 provider/model（无论是否拦截），
 *    供 client 指示器判定"当前是否使用 DeepSeek 官方来源的模型"。
 *  - 设置档（enabled）持久化到 <DSH_HOME>/super-injector/dsh-no-white-rice-allowed.json，
 *    重启后保持；config 提供初值。依赖策略与 dsh-mode-boost 一致：仅 node 内置模块，
 *    不 import cordis / schemastery / dsh-llm（规避运行时模块解析风险）。
 */
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'

export const name = '@dsh-external/dsh-no-white-rice-allowed'

/** 需要 webServer 服务（注册 /no-white-rice/api 状态 + 设置路由）。 */
export const inject = ['webServer']

/** 默认拦截提示文案。 */
const DEFAULT_MESSAGE = 'error：大肥鱼在吃白饭！'
/** 默认峰时窗口（北京时间 [开始小时, 结束小时)，含起点、不含终点）。 */
const DEFAULT_PEAKS: [number, number][] = [[9, 12], [14, 18]]
/** 北京时间偏移（UTC+8）。 */
const BEIJING_OFFSET_MS = 8 * 3600 * 1000
/** 状态路由前缀（client 端轮询同源路径）。 */
const API_PREFIX = '/no-white-rice/api'
/** 设置档持久化文件相对 DSH_HOME 的路径。 */
const SETTINGS_REL = ['super-injector', 'dsh-no-white-rice-allowed.json']

/** 北京时间（UTC+8）的当日分钟数、HH:mm、星期几（0=周日…6=周六）与是否工作日。 */
function beijingNow(): { minutes: number; text: string; dayOfWeek: number; isWeekday: boolean } {
  const shifted = new Date(Date.now() + BEIJING_OFFSET_MS)
  const h = shifted.getUTCHours()
  const m = shifted.getUTCMinutes()
  const dayOfWeek = shifted.getUTCDay()
  return {
    minutes: h * 60 + m,
    text: `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`,
    dayOfWeek,
    isWeekday: dayOfWeek >= 1 && dayOfWeek <= 5,
  }
}

/** 当日分钟数是否落在任一峰时窗口内（含起点、不含终点）。 */
function inPeak(minutes: number, windows: [number, number][]): boolean {
  return windows.some(([startHour, endHour]) => minutes >= startHour * 60 && minutes < endHour * 60)
}

/** 校验一个 [startHour, endHour) 窗口是否合法。 */
function isValidWindow(w: unknown): w is [number, number] {
  return Array.isArray(w) && w.length === 2
    && typeof w[0] === 'number' && Number.isInteger(w[0]) && w[0] >= 0 && w[0] <= 23
    && typeof w[1] === 'number' && Number.isInteger(w[1]) && w[1] >= 0 && w[1] <= 23
    && w[1] > w[0]
}

/** 归一化插件配置（loader 可能传 {}，默认值在此兜底）。 */
function normalizeConfig(config: unknown): {
  enabled: boolean
  message: string
  peaks: [number, number][]
  weekdaysOnly: boolean
} {
  const raw = (config ?? {}) as Record<string, unknown>
  const enabled = raw.enabled !== false
  const message = typeof raw.message === 'string' && raw.message.length > 0 ? raw.message : DEFAULT_MESSAGE
  const peaks = Array.isArray(raw.peaks) && raw.peaks.length > 0
    ? raw.peaks.filter(isValidWindow)
    : DEFAULT_PEAKS
  const weekdaysOnly = raw.weekdaysOnly !== false
  return { enabled, message, peaks: peaks.length > 0 ? peaks : DEFAULT_PEAKS, weekdaysOnly }
}

/** 运行时上下文（cordis 注入的服务；类型从简避免外部类型依赖）。 */
type AppContext = {
  on(event: string, listener: (...args: any[]) => unknown): () => void
  effect(fn: () => unknown, label?: string): unknown
  inject(services: string[], callback: (ctx: any) => void): void
  webServer: {
    register(route: {
      kind: 'exact' | 'prefix' | 'upgrade'
      path: string
      handler: (req: any, res: any) => void | Promise<void>
    }): () => void
  }
  logger?: { info?(msg: string): void; warn?(msg: string): void }
}

export function apply(ctx: AppContext, config: unknown): void {
  // ═══ client 模块表自愈：host 热重载（dev_reload_package）会丢失 client-modules 行，
  // 导致 /plugins/<id>/client.js 404、浏览器拉不到 UI。插件启动时重新注册并通知浏览器。 ═══
  ctx.inject(['clientModules'], (c: any) => {
    try {
      const cm = c.clientModules
      if (cm?.processOne?.(name)) {
        if (cm.compose) cm.composed = cm.compose()
        cm.notifyGraphChanged?.()
        cm.rebuilt?.(name)
        ctx.logger?.info?.(`[${name}] client 模块表已自愈（processOne + rebuilt）`)
      }
    } catch { /* 自愈失败不阻塞插件 */ }
  })

  const { message, peaks, weekdaysOnly } = normalizeConfig(config)

  // ═══ 设置档持久化（enabled 运行时开关，重启后保持）═══
  const dshHome = process.env.DSH_HOME || join(homedir(), '.dsh')
  const settingsFile = join(dshHome, ...SETTINGS_REL)
  /** 运行时总开关（false = 全时段不拦截）。初值取 config.enabled；持久化文件有值则覆盖。 */
  let enabled = normalizeConfig(config).enabled
  try {
    if (existsSync(settingsFile)) {
      const saved = JSON.parse(readFileSync(settingsFile, 'utf8'))
      if (typeof saved.enabled === 'boolean') enabled = saved.enabled
    }
  } catch { /* 损坏则用默认 */ }
  const saveSettings = (): void => {
    try {
      mkdirSync(dirname(settingsFile), { recursive: true })
      writeFileSync(settingsFile, JSON.stringify({ enabled, updatedAt: new Date().toISOString() }, null, 2), 'utf8')
    } catch { /* 持久化失败静默 */ }
  }

  /** 最近一次拦截记录（client 端据此弹窗）。 */
  let lastBlocked: { at: number; message: string; beijingTime: string } | null = null
  let blockedCount = 0
  /** 最近一次 llm/stream 请求的实际路由（拦/放都记录；client 指示器判定 deepseek 官方来源）。 */
  let lastRoute: { provider: string; model: string; at: number } | null = null

  // ═══ 核心拦截点：llm/stream waterfall ═══
  // 监听器签名 (value, next)：不调用 next 或抛错即中断请求链（请求不会发出）。
  ctx.on('llm/stream', (options: any, next: any) => {
    if (typeof options?.provider === 'string') {
      lastRoute = { provider: options.provider, model: String(options?.model ?? ''), at: Date.now() }
    }
    const now = beijingNow()
    const shouldBlock = enabled && (!weekdaysOnly || now.isWeekday) && inPeak(now.minutes, peaks)
    if (shouldBlock) {
      lastBlocked = { at: Date.now(), message, beijingTime: now.text }
      blockedCount += 1
      ctx.logger?.warn?.(`[no-white-rice] 北京时间 ${now.text}（${now.isWeekday ? '工作日' : '周末'}）处于峰时，已拦截 provider=${options?.provider} model=${options?.model} 的 DeepSeek 请求（累计 ${blockedCount} 次）`)
      // 打断请求：错误向上抛出，请求不会发往 api.deepseek.com；会话侧显示 message 文案。
      throw new Error(message)
    }
    return next()
  })

  // ═══ 状态 + 设置路由：client 端轮询弹窗 / 运行开关 ═══
  /** 插件 media 的 DeepSeek 图标（读一次缓存；来自 media/deepseek.svg）。 */
  let iconSvg: string | null = null
  const disposeRoute = ctx.webServer.register({
    kind: 'prefix',
    path: API_PREFIX,
    handler: async (req: any, res: any) => {
      const pathname = new URL(req.url ?? '/', 'http://x').pathname
      const now = beijingNow()

      // POST /settings —— 运行时开关（关闭 = 全时段不拦截）
      if (req.method === 'POST' && pathname === `${API_PREFIX}/settings`) {
        let body = ''
        for await (const chunk of req) body += chunk
        try {
          const data = JSON.parse(body || '{}')
          if (typeof data.enabled !== 'boolean') throw new Error('enabled must be boolean')
          enabled = data.enabled
          saveSettings()
          res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
          res.end(JSON.stringify({ ok: true, enabled, savedAt: new Date().toISOString() }))
        } catch (e) {
          res.writeHead(400, { 'content-type': 'application/json; charset=utf-8' })
          res.end(JSON.stringify({ ok: false, error: String((e as Error).message ?? e) }))
        }
        return
      }

      // GET /icon —— DeepSeek 图标（client 指示器；内容来自插件 media/deepseek.svg）
      if (pathname === `${API_PREFIX}/icon`) {
        if (iconSvg === null) {
          try {
            iconSvg = readFileSync(new URL('../media/deepseek.svg', import.meta.url), 'utf8')
          } catch {
            iconSvg = ''
          }
        }
        if (iconSvg.length === 0) {
          res.writeHead(404)
          res.end()
          return
        }
        res.writeHead(200, { 'content-type': 'image/svg+xml; charset=utf-8', 'cache-control': 'max-age=3600' })
        res.end(iconSvg)
        return
      }

      // GET /status —— 状态查询
      if (pathname !== `${API_PREFIX}/status`) {
        res.writeHead(404)
        res.end()
        return
      }
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
      res.end(JSON.stringify({
        ok: true,
        enabled,
        message,
        weekdaysOnly,
        peak: inPeak(now.minutes, peaks),
        weekday: now.isWeekday,
        dayOfWeek: now.dayOfWeek,
        isBusy: enabled && (!weekdaysOnly || now.isWeekday) && inPeak(now.minutes, peaks),
        beijingTime: now.text,
        peaks,
        blockedCount,
        blocked: lastBlocked,
        lastRoute,
      }))
    },
  })
  ctx.effect(() => disposeRoute, 'no-white-rice: status route')

  ctx.logger?.info?.(`[${name}] 峰时拦截已生效：${weekdaysOnly ? '工作日（周一至周五）' : '全天'}北京时间 ${peaks.map(([s, e]) => `${s}:00-${e}:00`).join('、')} 内拦截 DeepSeek 官方请求，提示文案="${message}"`)
}
