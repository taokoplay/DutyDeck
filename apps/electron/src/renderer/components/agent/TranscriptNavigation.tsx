import * as React from 'react'
import { ArrowDown, RotateCw } from 'lucide-react'
import { useStickToBottomContext } from 'use-stick-to-bottom'
import type { AgentTranscriptPage, AgentTranscriptPageRequest } from '@dutydeck/shared'
import { Button } from '@/components/ui/button'
import { LoadingIndicator } from '@/components/ui/loading-indicator'
import { getTranscriptScrollAction, shouldReleaseTranscriptNavigation } from '@/lib/agent-transcript-scroll'

/** 页码只存在于存储层；此组件依靠滚动方向与窗口边缘决定何时补读。 */
interface NavigationProps {
  page?: AgentTranscriptPage
  reading: boolean
  loading: boolean
  error?: string | null
  ready?: boolean
  onNavigate?: (mode: AgentTranscriptPageRequest['mode'], messageId?: string, canCommit?: () => boolean) => Promise<boolean>
}
type Move = 'before' | 'after' | 'tail'
/** 记录当前屏幕内稳定的消息与相对位置；元素可能在提交新窗口时重新挂载。 */
interface ViewportAnchor { id: string; offset: number }

/** 记录一次分页导航及其锚点恢复状态，成功请求必须等对齐完成才释放。 */
interface ActiveNavigation {
  key: string
  mode: Move
  page?: AgentTranscriptPage
  anchor?: ViewportAnchor
  aligned?: boolean
}

/** 只在换页或用户在读取期间移动时测量，不为流式 token 或普通滚动反复遍历。 */
function visibleAnchor(root: HTMLElement): ViewportAnchor | undefined {
  const bounds = root.getBoundingClientRect()
  for (const item of root.querySelectorAll<HTMLElement>('[data-message-id]')) {
    const rect = item.getBoundingClientRect()
    if (item.dataset.messageId && rect.bottom > bounds.top && rect.top < bounds.bottom) {
      return { id: item.dataset.messageId, offset: rect.top - bounds.top }
    }
  }
  return undefined
}

/** 选择正文、在交互内容中使用键盘时，不能因滚动裁掉该内容。 */
function interactionPinned(root: HTMLElement): boolean {
  const selection = window.getSelection()
  if (selection && !selection.isCollapsed && root.contains(selection.anchorNode)) return true
  const focused = document.activeElement
  return focused instanceof HTMLElement && root.contains(focused) && !focused.closest('[data-transcript-navigation]')
    && focused.matches('textarea,input,button,a,summary,[contenteditable="true"]')
}

/** 对稳定游标去重；显式重试可再次进入同一游标，重新渲染不能重复读取。 */
function requestKey(page: AgentTranscriptPage | undefined, mode: Move): string {
  return JSON.stringify([page?.sessionId, page?.generation, mode,
    mode === 'before' ? page?.before?.offset : page?.after?.offset, page?.revision])
}

export function TranscriptNavigation(props: NavigationProps): React.ReactElement | null {
  const context = useStickToBottomContext()
  const { scrollRef, stopScroll, scrollToBottom } = context
  const current = React.useRef(props)
  const active = React.useRef<ActiveNavigation | null>(null)
  const lastRequest = React.useRef<string | undefined>(undefined)
  const lastMode = React.useRef<Move>('tail')
  const ignoredTop = React.useRef<number | undefined>(undefined)
  const mounted = React.useRef(false)

  // 阅读窗口的物理下边缘不是会话末尾。库的 ResizeObserver 会在高度变化时重新粘底；
  // 此时把它的目标限定为视口当前位置，不允许它覆盖消息锚点。返回实时窗后还原目标。
  React.useLayoutEffect(() => {
    const priorTarget = context.targetScrollTop
    context.targetScrollTop = (bottom, elements) => current.current.reading || (active.current && active.current.mode !== 'tail')
      ? elements.scrollElement.scrollTop : priorTarget?.(bottom, elements) ?? bottom
    return () => { context.targetScrollTop = priorTarget }
  }, [context])

  /** 新页已提交后再按 ID 恢复；补载期间的滚动事件会刷新 anchor。 */
  const align = React.useCallback((): void => {
    const request = active.current
    const root = scrollRef.current
    if (!root || !request || !mounted.current || request.aligned || current.current.loading || current.current.error) return
    if (request.page === current.current.page) {
      // unchanged 页没有新的 DOM 可恢复，但请求已经完成，必须释放边缘锁。
      request.aligned = true
      if (active.current === request) active.current = null
      return
    }
    if (request.mode === 'tail') {
      // transition 可能还未提交新页；页面身份变化后本 effect 会再次校准。
      request.aligned = true
      if (!current.current.page?.indexRequired) void scrollToBottom('instant')
      if (active.current === request) active.current = null
    } else if (request.anchor) {
      const target = root.querySelector<HTMLElement>(`[data-message-id="${CSS.escape(request.anchor.id)}"]`)
      // 锚点尚未挂载时不能提前标记完成，否则 transition 提交后无法再次恢复位置。
      if (!target) return
      request.aligned = true
      const delta = target.getBoundingClientRect().top - root.getBoundingClientRect().top - request.anchor.offset
      if (Math.abs(delta) > 0.5) root.scrollTop += delta
      ignoredTop.current = root.scrollTop
      if (active.current === request) active.current = null
    } else {
      request.aligned = true
      ignoredTop.current = root.scrollTop
      if (active.current === request) active.current = null
    }
  }, [scrollRef, scrollToBottom])
  React.useLayoutEffect(() => { current.current = props; align() }, [props, align])
  React.useLayoutEffect(() => {
    mounted.current = true
    return () => { mounted.current = false; active.current = null }
  }, [])

  /** 一次只有一条导航进行中；失败停在原页，只有显式重试才重发。 */
  const move = React.useCallback(async (mode: Move, retry = false): Promise<void> => {
    const { page, loading, onNavigate, error } = current.current
    const root = scrollRef.current
    if (!root || !onNavigate || loading || active.current || (error && !retry) || interactionPinned(root)) return
    const key = requestKey(page, mode)
    if (!retry && key === lastRequest.current) return
    const focused = document.activeElement
    if (focused instanceof HTMLElement && focused.closest('[data-transcript-navigation]')) focused.blur()
    const request: ActiveNavigation = { key, mode, page, anchor: mode === 'tail' ? undefined : visibleAnchor(root) }
    lastRequest.current = key; lastMode.current = mode; active.current = request
    stopScroll()
    let succeeded = false
    try {
      succeeded = await onNavigate(mode, undefined, () => mounted.current && !interactionPinned(root))
      if (!succeeded && !current.current.error) lastRequest.current = undefined
      if (succeeded) {
        await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
        if (active.current === request) align()
      }
    } finally {
      // 成功请求必须等新页真正挂载并恢复锚点后才释放；否则触顶事件会连续推进多个页面。
      if (active.current === request && shouldReleaseTranscriptNavigation({ succeeded, aligned: request.aligned === true })) {
        active.current = null
      }
    }
  }, [align, scrollRef, stopScroll])

  React.useEffect(() => {
    const root = scrollRef.current
    if (!root || props.ready === false) return
    let previousTop = root.scrollTop
    /** 普通滚动按实际方向判断；已在物理最顶/底时还须识别滚轮或键盘的意图。 */
    const decide = (direction: 'up' | 'down' | 'initial'): void => {
      const { page, reading } = current.current
      if (!page || root.clientHeight <= 0) return
      const remaining = root.scrollHeight - root.clientHeight - root.scrollTop
      const mode = getTranscriptScrollAction({ direction, top: root.scrollTop, remaining,
        short: root.scrollHeight <= root.clientHeight + 2, reading, loading: current.current.loading,
        pendingNavigation: active.current !== null, hasBefore: page.hasBefore, hasAfter: page.hasAfter, indexRequired: Boolean(page.indexRequired) })
      if (mode) void move(mode)
    }
    const scrolled = (): void => {
      const top = root.scrollTop
      const previous = previousTop; previousTop = top
      if (ignoredTop.current !== undefined && Math.abs(ignoredTop.current - top) < 1) return
      ignoredTop.current = undefined
      if (active.current && active.current.page === current.current.page) {
        active.current.anchor = visibleAnchor(root)
        return
      }
      if (top !== previous) decide(top < previous ? 'up' : 'down')
    }
    const atEdge = (up: boolean): void => {
      if (up ? root.scrollTop <= 1 : root.scrollHeight - root.clientHeight - root.scrollTop <= 2) decide(up ? 'up' : 'down')
    }
    const wheel = (event: WheelEvent): void => {
      if (event.deltaY && !event.ctrlKey && !(event.target instanceof Element && event.target.closest('[data-transcript-inner-scroll]'))) atEdge(event.deltaY < 0)
    }
    const keydown = (event: KeyboardEvent): void => {
      if (event.defaultPrevented || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey
        || (event.target instanceof Element && event.target.closest('[data-transcript-inner-scroll], input, textarea, select, [contenteditable="true"]'))) return
      if (['ArrowUp', 'PageUp', 'Home'].includes(event.key)) atEdge(true)
      else if (['ArrowDown', 'PageDown', 'End'].includes(event.key)) atEdge(false)
    }
    root.addEventListener('scroll', scrolled, { passive: true })
    root.addEventListener('wheel', wheel, { passive: true })
    root.addEventListener('keydown', keydown)
    return () => {
      root.removeEventListener('scroll', scrolled); root.removeEventListener('wheel', wheel); root.removeEventListener('keydown', keydown)
    }
  }, [move, scrollRef, props.ready])

  // 首次布局不足一屏时逐页补齐；切换、失败或不再有进展时停止，绝不轮询完整历史。
  React.useEffect(() => {
    if (!props.page || props.loading || props.error || props.ready === false) return
    const frame = requestAnimationFrame(() => {
      const root = scrollRef.current
      if (!root || !root.clientHeight || root.scrollHeight > root.clientHeight + 2) return
      if (props.page?.indexRequired) void move('tail')
      else if (props.page?.hasBefore) void move('before')
    })
    return () => cancelAnimationFrame(frame)
  }, [move, props.page, props.loading, props.error, props.ready, scrollRef])

  if (!props.onNavigate) return null
  return <div data-transcript-navigation="" className={`flex min-h-6 items-center justify-center gap-2 text-xs text-muted-foreground${props.error ? ' sticky top-0 z-10 bg-background' : ''}`} aria-live="polite" aria-busy={props.loading || undefined}>
    {props.error ? <><span role="alert">{props.error}</span><Button size="sm" variant="ghost" onClick={() => void move(lastMode.current, true)}><RotateCw className="size-3" />重试</Button></>
      : props.loading ? <LoadingIndicator label="正在读取历史" size="sm" /> : props.page && !props.page.hasBefore && props.page.entries.length > 0 ? <span>已到会话开头</span> : null}
    {(props.reading || (props.error && lastMode.current !== 'tail')) && <Button size="sm" variant="ghost" disabled={props.loading} onClick={() => void move('tail', true)}><ArrowDown className="size-3" />回到最新</Button>}
  </div>
}
