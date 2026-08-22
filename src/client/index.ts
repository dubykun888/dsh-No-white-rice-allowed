/**
 * @dsh-external/dsh-no-white-rice-allowed — client 弹窗端（React 组件）。
 *
 * 职责：
 *  - 对话框右上角指示器（conversation.input.right）：DeepSeek 图标 + 文本
 *    「现在是：梁文峰！」（梁文峰标红，被阻止）/「现在是：梁文谷！」（放行）；
 *    仅当最近请求使用 DeepSeek 官方来源模型时显示；文本+图标整体右对齐。
 *  - 设置页「白饭禁令」面板：启用/关闭开关（POST /no-white-rice/api/settings，
 *    运行时生效并持久化）+ 实时状态。
 *  - 全局轮询 host 状态，发现新的拦截记录即弹出红色错误 toast。
 *
 * 构建：npm run build:client（tsdown，产物 lib/client.js，ModuleLoader.load 注册）。
 * ⚠️ 必坑（2026-08 实测）：① slots 渲染器是纯 React——组件必须用 React
 * createElement（无 JSX 转换）；② apply 用 ctx.slots 必须 export const inject
 * = ['slots']；③ register 必须带 name 字段（= slot 名）。
 */
import { createElement, useEffect, useState } from 'react'

const h = createElement

type ClientContext = {
  slots: {
    inject(key: string, callback: () => unknown): () => void
    register(options: Record<string, unknown>, component?: unknown): () => void
  }
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

/** 弹出错误提示（红色居中 toast，可点击关闭，8s 自动消失；纯 DOM，不依赖 React）。 */
function showToast(message: string): void {
  const existing = document.getElementById('nwr-toast')
  if (existing) existing.remove()

  const overlay = document.createElement('div')
  overlay.id = 'nwr-toast'
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

  const dismiss = (): void => overlay.remove()
  overlay.addEventListener('click', dismiss)
  window.setTimeout(dismiss, TOAST_MS)

  if (!document.getElementById('nwr-toast-style')) {
    const style = document.createElement('style')
    style.id = 'nwr-toast-style'
    style.textContent = '@keyframes nwr-pop{from{opacity:0;transform:translate(-50%,-8px)}to{opacity:1;transform:translate(-50%,0)}}'
    document.head.appendChild(style)
  }
}

/** 全局轮询：新拦截记录 → 弹窗（apply 时启动，纯 DOM，不依赖 React）。 */
function startToastPoll(): () => void {
  const poll = (): void => {
    void fetch(API_STATUS, { headers: { accept: 'application/json' } })
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (d?.ok && d.blocked && typeof d.blocked.at === 'number' && d.blocked.at > lastSeenAt) {
          lastSeenAt = d.blocked.at
          showToast(String(d.blocked.message ?? 'error：大肥鱼在吃白饭！'))
        }
      })
      .catch(() => { /* host 路由未就绪或插件被卸载 */ })
  }
  poll()
  const timer = window.setInterval(poll, POLL_MS)
  return () => window.clearInterval(timer)
}

/** 拉取 status 快照（失败返回 null）。 */
async function fetchStatus(): Promise<any | null> {
  try {
    const r = await fetch(API_STATUS, { headers: { accept: 'application/json' } })
    return r.ok ? r.json() : null
  } catch {
    return null
  }
}

/** 模块级共享缓存：apply 预取一次，组件挂载即有值（避免首次渲染等待/闪隐）。 */
let cachedStatus: any = null
let cachedAt = 0
async function fetchStatusShared(force = false): Promise<any | null> {
  if (!force && cachedStatus !== null && Date.now() - cachedAt < 1500) return cachedStatus
  const d = await fetchStatus()
  if (d !== null) {
    cachedStatus = d
    cachedAt = Date.now()
  }
  return cachedStatus
}

/** ═══ 对话框右上角指示器：仅 DeepSeek 官方模型时显示；图标+文本整体右对齐 ═══
 *  显示条件优先用"当前选定模型"的 provider（props.directory，来自 modelDirectories）——
 *  用户切换模型到非 DeepSeek 供应商时立即隐藏（不再依赖"最近一次请求"的 lastRoute）。 */
function BadgeComponent(props: any) {
  const directory = props?.directory
  const [state, setState] = useState<any>(() => ({
    currentProvider: directory?.store?.getSnapshot()?.current?.provider ?? null,
    busy: false,
    lastProvider: null,
  }))
  useEffect(() => {
    let alive = true
    const poll = (): void => {
      // 当前选定模型 provider（快照，切换模型即时更新）
      const currentProvider = directory?.store?.getSnapshot()?.current?.provider ?? null
      void fetchStatusShared(true).then((d) => {
        if (!alive) return
        setState({
          currentProvider,
          busy: d?.isBusy === true,
          lastProvider: d?.lastRoute?.provider ?? null,
        })
      })
    }
    poll()
    const timer = window.setInterval(poll, 1000)
    return () => {
      alive = false
      window.clearInterval(timer)
    }
  }, [directory])
  // provider 优先级：当前选定模型 > 最近一次请求。仅 deepseek-official 显示。
  const provider = state.currentProvider ?? state.lastProvider
  const visible = provider === 'deepseek-official'
  if (!visible) return null
  const busy = state.busy
  const hint = `current-provider=${state.currentProvider ?? '?'} last-provider=${state.lastProvider ?? '?'} model=${directory?.store?.getSnapshot()?.current?.model ?? '?'} isBusy=${busy}`
  return h('div', {
    style: {
      display: 'flex', alignItems: 'center', gap: 5,
      fontSize: 11, lineHeight: 1.2, whiteSpace: 'nowrap', userSelect: 'none',
      color: 'var(--theme-text-secondary,#999)', marginLeft: 'auto',
    },
    title: hint,
  },
    h('img', { src: '/no-white-rice/api/icon', alt: '', style: { width: 16, height: 16, borderRadius: 3, flex: 'none', display: 'block' } }),
    h('span', { style: { display: 'inline-flex', alignItems: 'baseline', gap: 2, fontWeight: 600, fontSize: 11 } },
      '现在是：',
      h('span', { style: { color: busy ? '#e5484d' : 'var(--theme-accent,#4a9eff)', fontWeight: 700 } },
        busy ? '梁文峰！' : '梁文谷！'),
    ),
  )
}

/** ═══ 设置页「白饭禁令」面板：开关 + 实时状态 ═══ */
function StatusPanel() {
  const [snap, setSnap] = useState<any>(null)
  const [saving, setSaving] = useState(false)
  useEffect(() => {
    let alive = true
    const refresh = (): void => {
      void fetchStatus().then((d) => {
        if (alive && d?.ok) setSnap(d)
      })
    }
    refresh()
    const timer = window.setInterval(refresh, 1000)
    return () => {
      alive = false
      window.clearInterval(timer)
    }
  }, [])

  const onToggle = (e: any): void => {
    const next = e.target.checked
    setSaving(true)
    void fetch(API_SETTINGS, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ enabled: next }),
    })
      .then((r) => r.json())
      .then((d) => {
        if (d?.ok) setSnap((old: any) => (old ? { ...old, enabled: d.enabled === true } : old))
      })
      .catch(() => {})
      .finally(() => setSaving(false))
  }

  const rows: [string, string][] = snap
    ? [
        ['当前北京时间', `${String(snap.beijingTime ?? '--:--')}（${snap.weekday === true ? '工作日（周一至周五）' : '周末（全天谷价，放行）'}）`],
        ['当前时段', snap.isBusy === true ? '峰时 ⚠️ 请求将被拦截' : '非峰时 / 周末 / 已关闭（放行）'],
        ['生效范围', snap.weekdaysOnly === true ? '仅工作日（周末全天谷价放行）' : '全天'],
        ['峰时窗口', Array.isArray(snap.peaks) ? snap.peaks.map((p: number[]) => `${p[0]}:00-${p[1]}:00`).join('、') : '9:00-12:00、14:00-18:00'],
        ['拦截次数', String(snap.blockedCount ?? 0)],
        ['最近拦截', snap.blocked ? `${snap.blocked.beijingTime}（${new Date(snap.blocked.at).toLocaleTimeString()}）` : '无'],
        ['提示文案', String(snap.message ?? '')],
      ]
    : [['（加载中…）', '']]

  const row = (k: string, v: string): any => h('div', { style: { display: 'flex', gap: 8, padding: '3px 0' } },
    h('span', { style: { flex: 'none', width: 110, color: 'var(--theme-text-secondary,#999)' } }, k + ':'),
    h('span', { style: { flex: 1, color: 'var(--theme-text,#ddd)', wordBreak: 'break-all' } }, v))

  return h('div', { style: { fontFamily: 'ui-monospace,monospace', fontSize: 12, lineHeight: 1.6, padding: '4px 2px', maxWidth: 640 } },
    h('h3', { style: { margin: '0 0 10px', fontSize: 13 } }, '峰时拦截（dsh-no-white-rice-allowed）'),
    h('div', { style: { border: '1px solid var(--theme-border,#333)', borderRadius: 8, padding: '10px 12px' } },
      h('label', { style: { display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10, cursor: 'pointer', userSelect: 'none' } },
        h('input', { type: 'checkbox', checked: snap?.enabled === true, disabled: saving, onChange: onToggle, style: { width: 16, height: 16, accentColor: '#e5484d', cursor: 'pointer' } }),
        h('span', { style: { fontWeight: 600, color: 'var(--theme-text,#ddd)' } }, '启用峰时拦截（关闭：全时段不生效）'),
        saving ? h('span', { style: { fontSize: 11, color: 'var(--theme-text-secondary,#999)' } }, '保存中…') : null,
      ),
      rows.map(([k, v]) => row(k, v)),
    ),
  )
}

export const inject = ['slots']

export function apply(ctx: any): void {
  // 预取状态：组件挂载前即有快照（指示器无首包等待）
  void fetchStatusShared(true)

  // ═══ 对话框右上角指示器（仅 DeepSeek 官方模型显示；React 组件经 slots 渲染）═══
  // 优先用「当前选定模型」的 provider（modelDirectories 服务，切换模型即时隐藏）；
  // 服务缺失时回退到最近一次请求的 lastRoute（host status）。
  ctx.effect(() => ctx.slots.inject('conversation.input.right', () =>
    ctx.slots.register({
      name: 'conversation.input.right',
      id: '@dsh-external/dsh-no-white-rice-allowed-badge',
      order: 70,
      label: () => '白饭指示器',
      inject: (sessionId: string) => {
        const models = ctx.get?.('modelDirectories')
        const directory = models?.directoryFor?.(sessionId) ?? null
        return { directory }
      },
    }, BadgeComponent),
  ), 'no-white-rice: input badge')

  // ═══ 设置页面板（React 组件）═══
  ctx.effect(() => ctx.slots.inject('settings.section', () =>
    ctx.slots.register({
      name: 'settings.section',
      id: '@dsh-external/dsh-no-white-rice-allowed-status',
      order: 60,
      label: () => '白饭禁令',
    }, StatusPanel),
  ), 'no-white-rice: settings page')

  // ═══ 弹窗轮询（纯 DOM，全局）═══
  ctx.effect(() => startToastPoll(), 'no-white-rice: toast poll')
}
