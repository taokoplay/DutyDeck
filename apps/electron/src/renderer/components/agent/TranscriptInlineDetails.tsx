import * as React from 'react'
import { createPortal } from 'react-dom'

/** 一次 IPC/保留缓冲切片的有界响应。 */
export interface TranscriptDetailSlice { text: string; nextOffset?: number }
/** 附带绝对字符位置的可回读片段。 */
interface DetailSegment extends TranscriptDetailSlice { offset: number }
/** 输入字符位置，异步返回最多16k字符的只读投影。 */
type DetailLoader = (offset: number) => Promise<TranscriptDetailSlice>

/** 归属明确的详情入口：锚点按消息优先、所属回合兜底依次匹配。 */
export interface TranscriptInlineRecord {
  /** 同一版本内稳定的详情身份。 */
  id: string
  /** 原始消息/关联工具调用的 DOM 身份。 */
  anchors: string[]
  /** 用户可见入口文字。 */
  label: string
  /** 尚未确认持久化等状态说明。 */
  description?: string
  /** 未进入主消息窗的留存记录允许在自己的留存卡片内阅读。 */
  fallback?: boolean
  /** 经现有权限链路读取切片。 */
  load: DetailLoader
}

/** 把入口和正文挂在所属消息下；虚拟行离开视口时卸载，不在列表头集中展示。 */
export function TranscriptInlineRecords({ records }: { records: TranscriptInlineRecord[] }): React.ReactElement {
  /** 零高度定位点只用于确定当前会话容器，避免命中其他标签页消息。 */
  const marker = React.useRef<HTMLSpanElement>(null)
  /** 当前已挂载消息锚点；仅 DOM 身份改变时刷新。 */
  const [targets, setTargets] = React.useState(new Map<string, HTMLElement>())
  /** 整个详情入口集合最多展开一个正文阅读器。 */
  const [active, setActive] = React.useState<string | null>(null)
  /** 无锚点记录只提供一个序号选择器和一张卡片，避免恢复成无界列表。 */
  const [fallbackIndex, setFallbackIndex] = React.useState(0)
  React.useLayoutEffect(() => {
    const root = marker.current?.closest('[role="log"]') ?? marker.current?.parentElement
    if (!root) return
    /** 使用等值比较而非 CSS 插值，支持包含特殊字符的合法记录 ID。 */
    const locate = () => {
      const nodes = new Map<string, HTMLElement>()
      for (const node of root.querySelectorAll<HTMLElement>('[data-message-id]')) {
        if (node.dataset.messageId && !nodes.has(node.dataset.messageId)) nodes.set(node.dataset.messageId, node)
      }
      const next = new Map<string, HTMLElement>()
      for (const record of records) {
        const target = record.anchors.map(anchor => nodes.get(anchor)).find(Boolean)
        if (target) next.set(record.id, target)
      }
      setTargets(previous => previous.size === next.size && [...next].every(([id, node]) => previous.get(id) === node) ? previous : next)
    }
    locate()
    /** 虚拟消息挂载/卸载时同步 Portal，忽略详情内部的字符和状态更新。 */
    const observer = new MutationObserver(changes => {
      if (changes.some(change => [...change.addedNodes, ...change.removedNodes].some(node => node instanceof Element
        && (node.matches('[data-message-id]') || node.querySelector('[data-message-id]'))))) locate()
    })
    observer.observe(root, { subtree: true, childList: true })
    return () => observer.disconnect()
  }, [records])
  /** 无当前 DOM 锚点也必须可访问，但只挂载选中的一条。 */
  const fallbacks = records.filter(record => record.fallback && !targets.has(record.id))
  const selectedFallback = fallbacks[Math.min(fallbackIndex, Math.max(0, fallbacks.length - 1))]
  return <><span ref={marker} aria-hidden="true" />{fallbacks.length > 1 && <label className="text-xs">窗外详情（共 {fallbacks.length} 条）
    <input type="number" aria-label="选择窗外详情序号" min={1} max={fallbacks.length}
      value={Math.min(fallbackIndex + 1, fallbacks.length)} className="mx-2 w-24 rounded border bg-background px-2"
      onChange={event => {
        const value = event.currentTarget.valueAsNumber
        if (Number.isSafeInteger(value)) { setFallbackIndex(Math.max(0, Math.min(fallbacks.length - 1, value - 1))); setActive(null) }
      }} />
  </label>}{records.map(record => {
    const target = targets.get(record.id)
    if (!target && selectedFallback !== record) return null
    const content = <div key={record.id} className="my-2 text-xs text-muted-foreground" data-transcript-detail-owner={record.id}>
      {record.description && <p>{record.description}</p>}
      <button type="button" className="rounded border px-2 py-1 hover:bg-accent" aria-expanded={active === record.id}
        onClick={() => setActive(active === record.id ? null : record.id)}>{active === record.id ? '收起详情' : record.label}</button>
      {active === record.id && <TranscriptInlineDetails key={record.id} load={record.load} />}
    </div>
    return target ? createPortal(content, target, record.id) : content
  })}</>
}

/** 单阅读器最多保留三个片段；收起/切换后拒绝迟到响应。 */
export class TranscriptDetailWindow {
  /** 当前连续正文窗口，最多48k字符。 */
  segments: DetailSegment[] = []
  /** 正在读取时合并重复滚动请求。 */
  loading = false
  /** 显式重试保留原位置，不自动循环错误请求。 */
  error: string | null = null
  /** 最近失败/请求的位置。 */
  offset = 0
  /** 关闭阅读器后的生命周期标记。 */
  private disposed = false
  /** StrictMode 重挂载也生成新的请求代次。 */
  private epoch = 0
  /** 接收已有权限链路提供的读取函数。 */
  constructor(private readonly read: DetailLoader) {}

  /** 请求指定位置，失败保留正文；成功按方向淘汰远端片段。 */
  async load(offset: number): Promise<void> {
    if (this.disposed || this.loading || this.segments.some(segment => segment.offset === offset)) return
    this.loading = true
    this.error = null
    this.offset = offset
    /** 旧生命周期的 finally 也不能覆盖新请求的 loading。 */
    const epoch = this.epoch
    try {
      const result = await this.read(offset)
      if (this.disposed || epoch !== this.epoch) return
      if (result.text.length > 16000 || (result.nextOffset !== undefined
        && (result.nextOffset !== offset + 16000 || result.nextOffset > 32 * 1024 * 1024))) {
        throw new Error('详情分段超过读取预算，请使用完整会话导出')
      }
      const backwards = offset < (this.segments[0]?.offset ?? 0)
      const merged = [...this.segments, { offset, ...result }].sort((a, b) => a.offset - b.offset)
      this.segments = backwards ? merged.slice(0, 3) : merged.slice(-3)
    } catch (cause) {
      if (!this.disposed && epoch === this.epoch) this.error = cause instanceof Error ? cause.message : '详情读取失败'
    } finally { if (epoch === this.epoch) this.loading = false }
  }

  /** 丢弃本地正文并阻止异步结果重新填充。 */
  dispose(): void { this.epoch++; this.disposed = true; this.segments = [] }

  /** React 开发模式重挂载时重新开启空窗口，不接收上一代请求。 */
  restart(): void { this.epoch++; this.disposed = false; this.loading = false; this.error = null; this.segments = [] }
}

/** 原位阅读正文：滚动自动补入前后段，以测量过的空白占位维持位置。 */
export function TranscriptInlineDetails({ load }: { load: DetailLoader }): React.ReactElement {
  /** 回调可由父组件重建；当前读者仍使用最新授权参数。 */
  const loader = React.useRef(load)
  loader.current = load
  /** 组件由父级以会话/版本/记录身份设置 key，切换时销毁旧请求。 */
  const [reader] = React.useState(() => new TranscriptDetailWindow(offset => loader.current(offset)))
  /** 仅用于刷新控制器的同步快照。 */
  const [, refresh] = React.useReducer(value => value + 1, 0)
  /** 独立可聚焦滚动区，键盘 PageDown/Home/End 均走同一读取逻辑。 */
  const viewport = React.useRef<HTMLDivElement>(null)
  /** 只保存各段像素高度，正文淘汰后不残留文本副本。 */
  const heights = React.useRef(new Map<number, number>())
  /** 记录上次滚动位置，避免向下读取时被上边界重复拉回。 */
  const lastScroll = React.useRef(0)
  /** 补齐被拖动跨过的占位区域时持续沿最后一次用户滚动方向读取。 */
  const direction = React.useRef(false)
  /** 挂载状态用于阻止已关闭组件刷新。 */
  const mounted = React.useRef(true)

  /** 加载前记录当前段高度，供下一次窗口移动保留滚动坐标。 */
  const request = React.useCallback(async (offset: number) => {
    viewport.current?.querySelectorAll<HTMLElement>('[data-detail-offset]').forEach(element => {
      heights.current.set(Number(element.dataset.detailOffset), element.getBoundingClientRect().height)
    })
    const pending = reader.load(offset)
    refresh()
    await pending
    if (mounted.current) refresh()
  }, [reader])

  React.useEffect(() => {
    mounted.current = true
    reader.restart()
    void request(0)
    /** 外层使用原生 keydown 监听；在内层原生阶段截住阅读键，保留浏览器默认滚动。 */
    const element = viewport.current
    const keepReadingKey = (event: KeyboardEvent) => {
      if (['ArrowUp', 'ArrowDown', 'PageUp', 'PageDown', 'Home', 'End', ' '].includes(event.key)) event.stopPropagation()
    }
    element?.addEventListener('keydown', keepReadingKey)
    return () => { mounted.current = false; reader.dispose(); element?.removeEventListener('keydown', keepReadingKey) }
  }, [reader, request])

  /** 被淘汰段只占据原有高度；总字符位置预算同时限制高度表大小。 */
  const first = reader.segments[0]
  const last = reader.segments.at(-1)
  let before = 0
  let after = 0
  for (const [offset, height] of heights.current) {
    if (first && offset < first.offset) before += height
    if (last && offset > last.offset) after += height
  }

  /** 靠近任一窗口边界时自动补载；错误等待明确重试，避免请求风暴。 */
  const checkScroll = () => {
    const element = viewport.current
    if (!element || reader.loading || reader.error || !first || !last) return
    if (element.scrollTop !== lastScroll.current) direction.current = element.scrollTop < lastScroll.current
    const backwards = direction.current
    lastScroll.current = element.scrollTop
    if (backwards && first.offset > 0 && element.scrollTop <= before + 120) {
      void request(Math.max(0, first.offset - 16000))
    } else if (!backwards && last.nextOffset !== undefined
      && element.scrollTop + element.clientHeight >= element.scrollHeight - after - 120) {
      void request(last.nextOffset)
    }
  }

  React.useLayoutEffect(() => {
    /** 首段不足一屏或拖动进入占位区时继续补齐，直到视口落入真实正文。 */
    checkScroll()
  })

  return <section aria-label="历史记录详情（只读展示投影）" className="my-2 min-w-0 rounded border p-2">
    <div ref={viewport} role="region" data-transcript-inner-scroll aria-label="滚动阅读完整记录" tabIndex={0} onScroll={checkScroll}
      className="h-80 overflow-auto text-xs" style={{ overflowAnchor: 'none', overscrollBehavior: 'contain' }}>
      <div aria-hidden="true" style={{ height: before }} />
      {reader.segments.map(segment => <pre key={segment.offset} data-detail-offset={segment.offset}
        className="m-0 whitespace-pre-wrap break-all">{segment.text}</pre>)}
      <div aria-hidden="true" style={{ height: after }} />
    </div>
    {reader.loading && <p role="status">正在读取…</p>}
    {reader.error && <p role="alert">{reader.error} <button type="button" className="underline" onClick={() => void request(reader.offset)}>重试读取</button></p>}
  </section>
}
