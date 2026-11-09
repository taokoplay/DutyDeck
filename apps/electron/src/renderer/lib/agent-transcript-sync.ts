import { projectDeferredTranscriptMessage } from '@dutydeck/shared'
import type { AgentTranscriptEntry, AgentTranscriptPage, SDKMessage } from '@dutydeck/shared'
import { shouldAcceptLiveSdkMessageForRun, type LiveSdkMessageRunIdentity } from './live-sdk-message-run'
import { estimateSDKMessageCacheBytes } from './agent-message-cache-budget'

// 与既有20会话/64MiB数组缓存共享对象及生命周期，不另建持有正文的全局Map。
const windows = new WeakMap<SDKMessage[], AgentTranscriptPage>()
const WINDOW_BYTES = 4 * 1024 * 1024
export function getTranscriptWindow(messages: SDKMessage[] | undefined): AgentTranscriptPage | undefined {
  return messages ? windows.get(messages) : undefined
}
export function bindTranscriptMessages(page: AgentTranscriptPage): SDKMessage[] {
  const messages = page.entries.map((entry) => {
    // 展示身份不能冒充权威uuid；老格式消息重载也能使用稳定React key。
    const message = entry.message as SDKMessage & { _promaTranscriptId?: string }
    message._promaTranscriptId = entry.recordId
    return message
  })
  windows.set(messages, page)
  return messages
}
/** 仅合并连续同代窗口。硬条数与内存预算先于完整回合软目标。 */
export function mergeTranscriptPage(
  previous: AgentTranscriptPage | undefined, page: AgentTranscriptPage,
  direction: 'before' | 'after' | 'replace', limit = 500,
): AgentTranscriptPage {
  if (previous && previous.sessionId !== page.sessionId) throw new Error('历史页不属于当前会话')
  if (page.status === 'resetRequired') throw new Error('历史版本已变化，请重新加载')
  if (page.status === 'unchanged' && previous?.generation === page.generation) return previous
  const contiguous = previous?.generation === page.generation && (direction === 'after'
    ? previous.after?.offset === page.before?.offset
    : direction === 'before' && page.after?.offset === previous.before?.offset)
  // 冷尾页编号从局部起点计数，补全索引后不可直接混入绝对编号。
  if (contiguous && previous && previous.turnNumbersRelative !== page.turnNumbersRelative && previous.entries.length && page.entries.length) {
    const previousBoundary = direction === 'before' ? previous.entries[0]! : previous.entries.at(-1)!
    const newBoundary = direction === 'before' ? page.entries.at(-1)! : page.entries[0]!
    const sameTurn = direction === 'before' ? page.endsMidTurn : page.startsMidTurn
    const shift = direction === 'before'
      ? newBoundary.turn + (sameTurn ? 0 : 1) - previousBoundary.turn
      : newBoundary.turn - (sameTurn ? 0 : 1) - previousBoundary.turn
    previous = { ...previous, turnNumbersRelative: page.turnNumbersRelative,
      entries: previous.entries.map(entry => ({ ...entry, turn: entry.turn + shift })) }
  }
  const source = contiguous && previous
    ? direction === 'before' ? [...page.entries, ...previous.entries] : [...previous.entries, ...page.entries]
    : page.entries
  let bytes = 0
  const selected: AgentTranscriptEntry[] = []
  const ordered = direction === 'before' ? source : source.toReversed()
  for (const entry of ordered) {
    const weight = estimateSDKMessageCacheBytes(entry.message) + 128
    if (selected.length >= limit || (selected.length > 0 && bytes + weight > WINDOW_BYTES)) break
    bytes += weight
    selected.push(entry)
  }
  if (direction !== 'before') selected.reverse()
  const first = selected[0]; const last = selected.at(-1)
  const originalFirst = contiguous && direction === 'after' ? previous! : page
  const originalLast = contiguous && direction === 'before' ? previous! : page
  return { ...page, entries: selected,
    before: first ? { sessionId: page.sessionId, generation: page.generation, offset: first.offset } : page.before,
    after: last ? { sessionId: page.sessionId, generation: page.generation, offset: last.end } : page.after,
    hasBefore: originalFirst.hasBefore || first?.offset !== source[0]?.offset,
    hasAfter: originalLast.hasAfter || last?.end !== source.at(-1)?.end,
    startsMidTurn: first?.offset === originalFirst.entries[0]?.offset ? originalFirst.startsMidTurn : true,
    endsMidTurn: last?.end === originalLast.entries.at(-1)?.end ? originalLast.endsMidTurn : true,
  }
}
/** 不以窗口之外的未知范围确认消息；新run、partial和deferred均保留。 */
export function acknowledgeTranscriptMessages(live: SDKMessage[], page: AgentTranscriptPage, run?: LiveSdkMessageRunIdentity): SDKMessage[] {
  const uuid = (message: SDKMessage): string | undefined => (message as { uuid?: string }).uuid
  const ids = new Set(page.entries.filter((entry) => !entry.deferred)
    .map((entry) => uuid(entry.message)).filter((id): id is string => typeof id === 'string'))
  const firstConfirmed = live.findIndex(message => !!uuid(message) && ids.has(uuid(message)!) && shouldAcceptLiveSdkMessageForRun(message, run))
  for (let index = 0; index < firstConfirmed; index++) precedingPage.add(live[index]!)
  const next = live.filter((message) => !uuid(message) || !ids.has(uuid(message)!)
    || (message as { _partial?: boolean })._partial === true || !shouldAcceptLiveSdkMessageForRun(message, run))
  return next.length === live.length ? live : next
}

/** 覆盖层保留控制游标，但绝不把乐观消息加入权威entries或持久化确认集合。 */
export function inheritTranscriptWindow(source: SDKMessage[], target: SDKMessage[]): SDKMessage[] {
  const page = windows.get(source)
  if (page) windows.set(target, page)
  return target
}
export function canAcceptTranscriptPage(current: AgentTranscriptPage | undefined, page: AgentTranscriptPage, requestEpoch: number, currentEpoch: number): boolean {
  return requestEpoch === currentEpoch && (!current || current.generation !== page.generation || page.observedEnd >= current.observedEnd)
}
// 已确认页内消息之前的live缓冲不能倒挂到页尾；不据此删除未确认正文。
const precedingPage = new WeakSet<SDKMessage>()

/** 读取持久化或实时消息的创建时间；只接受有限数字，缺失时不参与顺序判定。 */
function messageCreatedAt(message: SDKMessage): number | undefined {
  const value = (message as { _createdAt?: unknown })._createdAt
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

/** 页首记录的时间基准；缺失时退回既有的追加行为，不引入新的不确定性。 */
function pageHeadCreatedAt(page: AgentTranscriptPage | undefined): number | undefined {
  const first = page?.entries[0]
  if (!first) return undefined
  return messageCreatedAt(first.message)
}

export function selectTranscriptDisplay(persisted: SDKMessage[], live: SDKMessage[], page?: AgentTranscriptPage): { messages: SDKMessage[]; omitted: number; retained: SDKMessage[] } {
  const id = (message: SDKMessage): string | undefined => { const value = message as { uuid?: unknown; _promaTranscriptId?: string }; return typeof value.uuid === 'string' ? value.uuid : value._promaTranscriptId }
  const persistedIds = new Map(persisted.flatMap((message, index) => id(message) ? [[id(message)!, index] as const] : []))
  const firstOverlap = live.findIndex(message => !!id(message) && persistedIds.has(id(message)!))
  /** 尾部页起点时间：无重叠的实时缓冲早于它时属于更早历史，必须排在页前而不是页尾。 */
  const headCreatedAt = pageHeadCreatedAt(page)
  /** 判断无重叠的实时消息是否明确早于当前尾部页；未完成消息始终属于当前运行。 */
  const precedesPage = (message: SDKMessage): boolean => {
    if (firstOverlap >= 0 || headCreatedAt === undefined) return false
    if ((message as { _partial?: boolean })._partial === true) return false
    const createdAt = messageCreatedAt(message)
    return createdAt !== undefined && createdAt < headCreatedAt
  }
  const before: SDKMessage[] = []; const after: SDKMessage[] = []
  const merged = persisted.slice()
  for (let index = 0; index < live.length; index++) {
    const message = live[index]!
    const match = id(message) ? persistedIds.get(id(message)!) : undefined
    if (match !== undefined) merged[match] = message
    else if (precedingPage.has(message) || (firstOverlap >= 0 && index < firstOverlap) || precedesPage(message)) before.push(message)
    else after.push(message)
  }
  const source = [...before, ...merged, ...after]
  let bytes = 0; let start = source.length
  while (start > 0 && source.length - start < 500) {
    const weight = estimateSDKMessageCacheBytes(source[start - 1]!)
    if (start < source.length && bytes + weight > WINDOW_BYTES) break
    bytes += weight; start--
  }
  const retained = source.slice(0, start)
  let blocksLeft = 1000
  const selected = source.slice(start)
  const projected: SDKMessage[] = []
  for (const message of selected.toReversed()) {
    const content = (message as { message?: { content?: unknown } }).message?.content
    const blocks = Array.isArray(content) ? content.length : 1
    const oversized = estimateSDKMessageCacheBytes(message) > 256 * 1024 || blocks > 200 || blocks > blocksLeft
    const candidate = oversized ? projectOversizedMessage(message) : message
    const candidateContent = (candidate as { message?: { content?: unknown[] } }).message?.content
    const projectedBlocks = candidateContent?.length ?? 1
    if (oversized || projectedBlocks > blocksLeft) retained.push(message)
    if (projectedBlocks > blocksLeft) continue
    blocksLeft -= projectedBlocks
    projected.unshift(candidate)
  }

  const calls = new Set(projected.flatMap(message => {
    const content = (message as { message?: { content?: Array<{type:string;id?:string}> } }).message?.content
    return Array.isArray(content) ? content.filter(block => block.type === 'tool_use').map(block => block.id) : []
  }))
  for (const message of projected) {
    const content = (message as { message?: { content?: Array<{type:string;tool_use_id?:string}> } }).message?.content
    if (Array.isArray(content) && content.some(block => block.type === 'tool_result' && !calls.has(block.tool_use_id)) && !retained.includes(message)) retained.push(message)
  }
  return { messages: projected, omitted: start, retained }
}
const oversizedProjections = new WeakMap<SDKMessage, SDKMessage>()
function projectOversizedMessage(message: SDKMessage): SDKMessage {
  const existing = oversizedProjections.get(message)
  if (existing) return existing
  const projected = projectDeferredTranscriptMessage(message, '此条记录超出展示预算；完整内容保留，可用“查看保留记录”分段查看。')
  oversizedProjections.set(message, projected)
  return projected
}

/** 判断实时消息是否带有与当前 run 明确不同的运行身份；缺标记或当前 run 未知时不下结论。 */
function isSupersededLiveRunMessage(message: SDKMessage, run?: LiveSdkMessageRunIdentity): boolean {
  if (!run) return false
  const scoped = message as { _promaLiveRunGeneration?: number; _promaLiveRunStartedAt?: number }
  if (run.runGeneration != null && scoped._promaLiveRunGeneration != null) {
    return scoped._promaLiveRunGeneration !== run.runGeneration
  }
  if (run.startedAt != null && scoped._promaLiveRunStartedAt != null) {
    return scoped._promaLiveRunStartedAt !== run.startedAt
  }
  return false
}

/**
 * 只清除同run且实际返回的UUID；deferred和未完成消息继续保留。
 * 读到尾部页时，页外且属于更早run的实时缓冲已经完整落盘，一并丢弃以免长期累积；
 * 无run标记的旧格式消息不据此删除，避免误伤导入或迁移数据。
 */
export function acknowledgeTranscriptReceipts(live: SDKMessage[], receipts: Array<{ uuid: string; offset: number }>, page: AgentTranscriptPage, run?: LiveSdkMessageRunIdentity): SDKMessage[] {
  const deferredIds = new Set(page.entries.filter(entry => entry.deferred).map(entry => entry.recordId))
  const ids = new Set(receipts.filter(receipt => !deferredIds.has(receipt.uuid)).map(receipt => receipt.uuid))
  /** 尾部页之前的记录必然已落盘；非尾部页不据此删除未确认正文。 */
  const discardSupersededOutsidePage = page.hasBefore === true
  const result = live.filter(message => {
    const value = message as {uuid?: string; _partial?: boolean}
    if (value.uuid && ids.has(value.uuid) && value._partial !== true && shouldAcceptLiveSdkMessageForRun(message, run)) return false
    if (value._partial === true) return true
    return !(discardSupersededOutsidePage && isSupersededLiveRunMessage(message, run))
  })
  return result.length === live.length ? live : result
}

export function preserveInteractingTranscript<T>(previous: T | undefined, next: T, interacting: boolean, previousIdentity: string, identity: string): T {
  return interacting && previous !== undefined && previousIdentity === identity ? previous : next
}

/** 回退只清理发起时的旧缓冲，不能误删期间新run（即使它已结束）。 */
export function discardTranscriptSnapshot(live: SDKMessage[], snapshot: ReadonlySet<SDKMessage>): SDKMessage[] {
  return live.filter(message => !snapshot.has(message))
}
