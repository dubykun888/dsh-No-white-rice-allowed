/**
 * @dsh-external/dsh-no-white-rice-allowed — 峰时拦截器（hybrid）。
 *
 * 功能：在 DeepSeek Harness 向 DeepSeek 官方 API（deepseek-official provider 的
 * chat/completions）发起大模型请求之前，检测请求时刻的北京时间；若处于峰时
 * （默认 9:00-12:00、14:00-18:00），立即打断该请求（waterfall 抛错，请求不会
 * 发往 api.deepseek.com），并抛出错误提示："error：大肥鱼在吃白饭！"。
 *
 * 实现：
 *  - `llm/stream` 是 dsh-llm 的 waterfall 事件（`ctx.waterfall(..., 'llm/stream',
 *    options, () => adapterStream(...))`），监听器抛错即中断整条请求链，且发生在
 *    任何 HTTP 请求发出之前 —— 覆盖主会话、子代理、goal 循环等全部调用路径。
 *  - 拦截记录保存在内存中，并通过 webServer 路由 `/no-white-rice/api/status`
 *    暴露给 client 端轮询，client 收到新的拦截记录后弹出错误提示。
 *
 * 依赖策略（与 dsh-mode-boost 一致）：零外部 import —— 不 import cordis /
 * schemastery / dsh-llm，规避运行时模块解析风险；Config 默认值在 apply 内兜底。
 */
export const name = '@dsh-external/dsh-no-white-rice-allowed'

/** 需要 webServer 服务（注册 /no-white-rice/api 状态路由）。 */
export const inject = ['webServer']

/** 默认拦截提示文案。 */
const DEFAULT_MESSAGE = 'error：大肥鱼在吃白饭！'
/** 默认峰时窗口（北京时间 [开始小时, 结束小时)，含起点、不含终点）。 */
const DEFAULT_PEAKS: [number, number][] = [[9, 12], [14, 18]]
/** 北京时间偏移（UTC+8）。 */
const BEIJING_OFFSET_MS = 8 * 3600 * 1000
/** 状态路由前缀（client 端轮询同源路径）。 */
const API_PREFIX = '/no-white-rice/api'

/** 北京时间（UTC+8）的当日分钟数（0-1439）与 HH:mm 文本。 */
function beijingNow(): { minutes: number; text: string } {
  const shifted = new Date(Date.now() + BEIJING_OFFSET_MS)
  const h = shifted.getUTCHours()
  const m = shifted.getUTCMinutes()
  return { minutes: h * 60 + m, text: `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}` }
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
function normalizeConfig(config: unknown): { enabled: boolean; message: string; peaks: [number, number][] } {
  const raw = (config ?? {}) as Record<string, unknown>
  const enabled = raw.enabled !== false
  const message = typeof raw.message === 'string' && raw.message.length > 0 ? raw.message : DEFAULT_MESSAGE
  const peaks = Array.isArray(raw.peaks) && raw.peaks.length > 0
    ? raw.peaks.filter(isValidWindow)
    : DEFAULT_PEAKS
  return { enabled, message, peaks: peaks.length > 0 ? peaks : DEFAULT_PEAKS }
}

/** 运行时上下文（cordis 注入的服务；类型从简避免外部类型依赖）。 */
type AppContext = {
  on(event: string, listener: (...args: any[]) => unknown): () => void
  effect(fn: () => unknown, label?: string): unknown
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
  const { enabled, message, peaks } = normalizeConfig(config)
  /** 最近一次拦截记录（client 端据此弹窗）。 */
  let lastBlocked: { at: number; message: string; beijingTime: string } | null = null
  let blockedCount = 0

  // ═══ 核心拦截点：llm/stream waterfall ═══
  // 监听器签名 (value, next)：不调用 next 或抛错即中断请求链（请求不会发出）。
  ctx.on('llm/stream', (options: any, next: any) => {
    if (enabled && inPeak(beijingNow().minutes, peaks)) {
      const now = beijingNow()
      lastBlocked = { at: Date.now(), message, beijingTime: now.text }
      blockedCount += 1
      ctx.logger?.warn?.(`[no-white-rice] 北京时间 ${now.text} 处于峰时，已拦截 provider=${options?.provider} model=${options?.model} 的 DeepSeek 请求（累计 ${blockedCount} 次）`)
      // 打断请求：错误向上抛出，请求不会发往 api.deepseek.com；会话侧显示 message 文案。
      throw new Error(message)
    }
    return next()
  })

  // ═══ 状态查询：client 端轮询弹窗 ═══
  const disposeRoute = ctx.webServer.register({
    kind: 'prefix',
    path: API_PREFIX,
    handler: async (req: any, res: any) => {
      const pathname = new URL(req.url ?? '/', 'http://x').pathname
      if (pathname !== `${API_PREFIX}/status`) {
        res.writeHead(404)
        res.end()
        return
      }
      const now = beijingNow()
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
      res.end(JSON.stringify({
        ok: true,
        enabled,
        message,
        peak: inPeak(now.minutes, peaks),
        beijingTime: now.text,
        peaks,
        blockedCount,
        blocked: lastBlocked,
      }))
    },
  })
  ctx.effect(() => disposeRoute, 'no-white-rice: status route')

  ctx.logger?.info?.(`[${name}] 峰时拦截已生效：北京时间 ${peaks.map(([s, e]) => `${s}:00-${e}:00`).join('、')} 内拦截 DeepSeek 官方请求，提示文案="${message}"`)
}
