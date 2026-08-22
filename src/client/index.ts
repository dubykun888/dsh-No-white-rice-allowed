/**
 * @dsh-external/dsh-no-white-rice-allowed — client 弹窗端。
 *
 * 职责：
 *  - 轮询 host 的 `/no-white-rice/api/status`，发现"新的"峰时拦截记录时立即弹出
 *    错误提示（红色 toast："error：大肥鱼在吃白饭！"）。
 *  - 设置页「白饭禁令」面板：启用/关闭开关（POST /no-white-rice/api/settings，
 *    运行时生效并持久化）+ 实时状态（工作日/当前时段/拦截次数/最近拦截）。
 *
 * 构建：npm run build:client（tsdown，产物 lib/client.js，ModuleLoader.load 注册）。
 * ⚠️ 必坑（2026-08 实测）：① apply 用 ctx.slots 必须 export const inject
 * = ['slots']；② register 必须带 name 字段（= slot 名）。
 */
import type { SlotsService } from '@deepseek-ai/dsh-client-ui-slots'

type ClientContext = {
  slots: SlotsService
  effect(fn: () => unknown, label?: string): unknown
}

/** host 端状态路由（与 src/index.ts 的 API_PREFIX 一致）。 */
const API_STATUS = '/no-white-rice/api/status'
const API_SETTINGS = '/no-white-rice/api/settings'
/** 轮询间隔。 */
const POLL_MS = 2000
/** 弹窗自动消失时长。 */
const TOAST_MS = 8000

/** 已弹过窗的拦截时间戳（去重游标）。 */
let lastSeenAt = 0
/** 当前挂着的弹窗元素。 */
let activeToast: HTMLElement | null = null

/** 弹出错误提示（红色居中 toast，可点击关闭，8s 自动消失）。 */
function showToast(message: string): void {
  if (activeToast) activeToast.remove()

  const overlay = document.createElement('div')
  overlay.setAttribute('role', 'alert')
  overlay.style.cssText = [
    'position:fixed',
    'top:28px',
    'left:50%',
    'transform:translateX(-50%)',
    'z-index:2147483647',
    'max-width:min(560px,calc(100vw - 32px))',
    'animation:nwr-pop .25s ease-out',
    'cursor:pointer',
  ].join(';')

  const box = document.createElement('div')
  box.style.cssText = [
    'display:flex',
    'gap:10px',
    'align-items:flex-start',
    'padding:14px 16px',
    'border-radius:10px',
    'background:var(--theme-input-bg,#18181b)',
    'border:1.5px solid #e5484d',
    'box-shadow:0 8px 32px rgba(0,0,0,.45)',
    'color:var(--theme-text,#e4e4e7)',
    'font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace',
    'font-size:13px',
    'line-height:1.5',
  ].join(';')

  const icon = document.createElement('div')
  icon.textContent = '⛔'
  icon.style.cssText = 'font-size:18px;line-height:1.3;color:#e5484d;flex:none'

  const body = document.createElement('div')
  const title = document.createElement('div')
  title.textContent = '峰时拦截：DeepSeek 请求被拒绝'
  title.style.cssText = 'font-weight:700;color:#e5484d;margin-bottom:4px;font-size:13px'
  const text = document.createElement('div')
  text.textContent = message
  text.style.cssText = 'color:var(--theme-text,#e4e4e7);word-break:break-all;white-space:pre-wrap'
  body.append(title, text)

  box.append(icon, body)
  overlay.append(box)
  document.body.appendChild(overlay)
  activeToast = overlay

  const dismiss = (): void => {
    overlay.remove()
    if (activeToast === overlay) activeToast = null
  }
  overlay.addEventListener('click', dismiss)
  window.setTimeout(dismiss, TOAST_MS)

  // 样式表（动画）一次性挂载
  if (!document.getElementById('nwr-toast-style')) {
    const style = document.createElement('style')
    style.id = 'nwr-toast-style'
    style.textContent = '@keyframes nwr-pop{from{opacity:0;transform:translate(-50%,-8px)}to{opacity:1;transform:translate(-50%,0)}}'
    document.head.appendChild(style)
  }
}

/** 轮询 host 状态；发现新拦截记录即弹窗。 */
async function poll(): Promise<void> {
  try {
    const resp = await fetch(API_STATUS, { headers: { accept: 'application/json' } })
    if (!resp.ok) return
    const data = await resp.json()
    if (data?.ok && data.blocked && typeof data.blocked.at === 'number' && data.blocked.at > lastSeenAt) {
      lastSeenAt = data.blocked.at
      showToast(String(data.blocked.message ?? 'error：大肥鱼在吃白饭！'))
    }
  } catch {
    /* 静默：host 路由尚未就绪或插件已被卸载 */
  }
}

/** 设置页「白饭禁令」面板：开关（稳定结构）+ 状态行（每秒刷新）。 */
function renderStatusPanel(container: HTMLElement): () => void {
  // ═══ 开关行（静态结构，不被刷新重建）═══
  const switchRow = document.createElement('label')
  switchRow.style.cssText = 'display:flex;align-items:center;gap:8px;margin-bottom:10px;cursor:pointer;user-select:none'
  const toggle = document.createElement('input')
  toggle.type = 'checkbox'
  toggle.style.cssText = 'width:16px;height:16px;accent-color:#e5484d;cursor:pointer'
  const toggleLabel = document.createElement('span')
  toggleLabel.textContent = '启用峰时拦截（关闭：全时段不生效）'
  toggleLabel.style.cssText = 'font-weight:600;color:var(--theme-text,#ddd)'
  const toggleState = document.createElement('span')
  toggleState.style.cssText = 'font-size:11px;color:var(--theme-text-secondary,#999)'
  switchRow.append(toggle, toggleLabel, toggleState)

  toggle.addEventListener('change', () => {
    toggle.disabled = true
    toggleState.textContent = '保存中…'
    void fetch(API_SETTINGS, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ enabled: toggle.checked }),
    })
      .then((r) => r.json())
      .then((d) => {
        toggleState.textContent = d?.ok ? '已保存' : '保存失败'
        if (d?.ok) toggle.checked = d.enabled === true
      })
      .catch(() => {
        toggleState.textContent = '保存失败'
        toggle.checked = !toggle.checked
      })
      .finally(() => {
        toggle.disabled = false
        window.setTimeout(() => { toggleState.textContent = '' }, 2500)
      })
  })

  // ═══ 状态行（每秒刷新）═══
  const rowsBox = document.createElement('div')
  const refresh = (): void => {
    void fetch(API_STATUS, { headers: { accept: 'application/json' } })
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (!d?.ok) return
        toggle.checked = d.enabled === true
        const weekdaysOnly = d.weekdaysOnly === true
        const today = d.weekday ? '工作日（周一至周五）' : '周末（全天谷价，放行）'
        const busy = d.isBusy === true
        const rows: [string, string][] = [
          ['当前北京时间', `${String(d.beijingTime ?? '--:--')}（${today}）`],
          ['当前时段', busy ? '峰时 ⚠️ 请求将被拦截' : '非峰时 / 周末 / 已关闭（放行）'],
          ['生效范围', weekdaysOnly ? '仅工作日（周末全天谷价放行）' : '全天'],
          ['峰时窗口', Array.isArray(d.peaks) ? d.peaks.map((p: number[]) => `${p[0]}:00-${p[1]}:00`).join('、') : '9:00-12:00、14:00-18:00'],
          ['拦截次数', String(d.blockedCount ?? 0)],
          ['最近拦截', d.blocked ? `${d.blocked.beijingTime}（${new Date(d.blocked.at).toLocaleTimeString()}）` : '无'],
          ['提示文案', String(d.message ?? '')],
        ]
        rowsBox.textContent = ''
        for (const [k, v] of rows) {
          const row = document.createElement('div')
          row.style.cssText = 'display:flex;gap:8px;padding:3px 0'
          const key = document.createElement('span')
          key.textContent = k + ':'
          key.style.cssText = 'flex:none;width:110px;color:var(--theme-text-secondary,#999)'
          const val = document.createElement('span')
          val.textContent = v
          val.style.cssText = 'flex:1;color:var(--theme-text,#ddd);word-break:break-all'
          row.append(key, val)
          rowsBox.appendChild(row)
        }
      })
      .catch(() => {})
  }

  container.append(switchRow, rowsBox)
  refresh()
  const timer = window.setInterval(refresh, 1000)
  return () => window.clearInterval(timer)
}

export const inject = ['slots']

export function apply(ctx: ClientContext): void {
  // 设置页面板
  ctx.effect(() => ctx.slots.inject('settings.section', () =>
    ctx.slots.register({
      name: 'settings.section',
      id: '@dsh-external/dsh-no-white-rice-allowed-status',
      order: 60,
      label: () => '白饭禁令',
      component: () => ({
        render() {
          const page = document.createElement('div')
          page.style.cssText = 'font-family:ui-monospace,monospace;font-size:12px;line-height:1.6;padding:4px 2px;max-width:640px'
          const title = document.createElement('h3')
          title.textContent = '峰时拦截（dsh-no-white-rice-allowed）'
          title.style.cssText = 'margin:0 0 10px;font-size:13px'
          const panel = document.createElement('div')
          panel.style.cssText = 'border:1px solid var(--theme-border,#333);border-radius:8px;padding:10px 12px'
          page.append(title, panel)
          return { dispose: renderStatusPanel(panel) }
        },
      }),
    }),
  ), 'no-white-rice: settings page')

  // 弹窗轮询
  void poll()
  const timer = window.setInterval(poll, POLL_MS)
  ctx.effect(() => () => window.clearInterval(timer), 'no-white-rice: poll')
}
