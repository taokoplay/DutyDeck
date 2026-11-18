import * as React from 'react'
import { createRoot } from 'react-dom/client'
import { useStickToBottomContext } from 'use-stick-to-bottom'
import type { AgentTranscriptPage } from '@dutydeck/shared'
import { TranscriptNavigation } from '../src/renderer/components/agent/TranscriptNavigation'
import { Conversation, ConversationContent } from '../src/renderer/components/ai-elements/conversation'
import '../src/renderer/styles/globals.css'

/** 测试观测状态，仅含合成消息和像素测量，不暴露真实 IPC。 */
interface SmokeState {
  start: number; end: number; total: number; calls: string[]; anchors: number[]; anchorDetails: object[]; missingAnchors: number
  reading: boolean; blockedCommits: number; selectDuringLoad: boolean; failNext: boolean; loading: boolean; error: string | null
}
/** 内存观测桥；驱动通过 DOM 与 Chromium 输入操作，桥仅用于失败注入和结果读取。 */
const state: SmokeState = { start: 560, end: 720, total: 720, calls: [], anchors: [], anchorDetails: [], missingAnchors: 0, reading: false, blockedCommits: 0, selectDuringLoad: false, failNext: false, loading: false, error: null }
Object.defineProperty(window, '__historySmoke', { value: state })
Object.defineProperty(window, 'electronAPI', { value: new Proxy({}, {
  get: (_target, property) => property === 'platform' ? 'darwin' : () => { throw new Error(`禁止真实 IPC：${String(property)}`) },
}) })

/** 导航夹具使用生产滚动上下文；仅模拟数据页传输，保留 80 条重叠供双向锚点恢复。 */
function Timeline(): React.ReactElement {
  /** 版本触发合成页重绘；错误、加载状态与业务契约一致。 */
  const [revision, refresh] = React.useReducer((value: number) => value + 1, 0)
  /** 生产上下文的真实滚动容器。 */
  const { scrollRef } = useStickToBottomContext()
  React.useEffect(() => { scrollRef.current?.setAttribute('data-smoke-scroll', '') }, [scrollRef])
  /** 返回当前首条可见记录及相对容器的像素偏移，用于独立验证恢复结果。 */
  const anchor = (): { id: string | undefined; offset: number } | undefined => {
    const root = scrollRef.current
    if (!root) return
    const top = root.getBoundingClientRect().top
    const element = Array.from(root.querySelectorAll<HTMLElement>('[data-message-id]')).find(item => item.getBoundingClientRect().bottom > top)
    return element ? { id: element.dataset.messageId, offset: element.getBoundingClientRect().top - top } : undefined
  }
  /** 模拟异步前后页；输入方向，返回成功状态；绝不替组件执行滚动恢复。 */
  const navigate = React.useCallback(async (mode: 'before' | 'after' | 'tail' | 'rebuild' | 'around', _messageId?: string, canCommit?: () => boolean): Promise<boolean> => {
    const requestAnchor = anchor()
    state.calls.push(mode)
    state.loading = true
    state.error = null
    refresh()
    if (state.selectDuringLoad) {
      state.selectDuringLoad = false
      const element = scrollRef.current?.querySelector('[data-message-id]')
      if (element) { const range = document.createRange(); range.selectNodeContents(element); window.getSelection()?.removeAllRanges(); window.getSelection()?.addRange(range) }
    }
    await new Promise(resolve => setTimeout(resolve, 70))
    if (canCommit && !canCommit()) { state.blockedCommits++; state.loading = false; refresh(); return false }
    if (state.failNext) {
      state.failNext = false
      state.loading = false
      state.error = '合成历史读取失败，请重试'
      refresh()
      return false
    }
    const previous = requestAnchor ?? anchor()
    state.reading = mode === 'before' || mode === 'after'
    if (mode === 'before') { state.start = Math.max(0, state.start - 80); state.end = Math.min(720, state.start + 160) }
    else if (mode === 'after') { state.end = Math.min(720, state.end + 80); state.start = Math.max(0, state.end - 160) }
    else { state.end = state.total; state.start = Math.max(0, state.total - 160) }
    state.loading = false
    refresh()
    if (mode === 'before' || mode === 'after') setTimeout(() => {
      const root = scrollRef.current
      const element = root?.querySelector<HTMLElement>(`[data-message-id="${previous?.id}"]`)
      if (!root || !element || !previous) state.missingAnchors++
      else {
        const actual = element.getBoundingClientRect().top - root.getBoundingClientRect().top
        state.anchors.push(Math.abs(actual - previous.offset))
        state.anchorDetails.push({ mode, requestAnchor, previous, actual, start: state.start, end: state.end })
      }
    }, 50)
    return true
  }, [scrollRef])
  /** 生产导航所需分页元数据，所有记录均为可辨识合成数据。 */
  const page: AgentTranscriptPage = React.useMemo(() => ({
    sessionId: 'synthetic-only', generation: 'smoke', revision: String(revision), status: 'page', observedEnd: state.total,
    entries: Array.from({ length: state.end - state.start }, (_, index) => {
      const ordinal = state.start + index
      return { recordId: `synthetic-${ordinal}`, offset: ordinal, end: ordinal + 1, turn: ordinal + 1, message: { type: 'user', content: `合成消息 ${ordinal}` } }
    }),
    before: { sessionId: 'synthetic-only', generation: 'smoke', offset: state.start },
    after: { sessionId: 'synthetic-only', generation: 'smoke', offset: state.end },
    hasBefore: state.start > 0, hasAfter: state.end < 720,
    startsMidTurn: false, endsMidTurn: false, ioBytes: 0, indexBytes: 0, returnedBytes: 0, turnNumbersRelative: false,
  }), [state.start, state.end, state.total])
  return <>
    <button data-smoke-append onClick={() => { state.total++; if (!state.reading) state.end++; refresh() }} style={{ position: 'fixed', top: 0, right: 0, zIndex: 100 }}>追加合成消息</button>
    <ConversationContent>
      <TranscriptNavigation page={page} reading={state.reading} loading={state.loading} error={state.error} onNavigate={navigate} />
      {page.entries.map((entry, index) => <article key={entry.recordId} data-message-id={entry.recordId}
        style={{ minHeight: 62 + ((state.start + index) % 3) * 11, padding: 12, borderBottom: '1px solid #777' }}>
        {entry.recordId} — 合成消息；仅用于连续滚动验收。
      </article>)}
    </ConversationContent>
  </>
}
/** 使用同源生产容器，不挂载应用主进程、数据 locator 或会话服务。 */
function Fixture(): React.ReactElement {
  return <main style={{ height: '100vh', display: 'flex' }}><Conversation resize="instant"><Timeline /></Conversation></main>
}
createRoot(document.getElementById('root')!).render(<Fixture />)
