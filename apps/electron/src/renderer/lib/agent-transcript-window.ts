import type { AgentTranscriptPage, AgentTranscriptPageRequest } from '@dutydeck/shared'
/** 多Pane引用计数，不以当前主Tab推断embedded会话是否挂载。 */
export function createMountedTranscriptRegistry() {
  const counts = new Map<string, number>()
  return {
    mount(id: string): () => void {
      counts.set(id, (counts.get(id) ?? 0) + 1)
      let active = true
      return () => {
        if (!active) return
        active = false
        const count = (counts.get(id) ?? 1) - 1
        if (count > 0) counts.set(id, count)
        else counts.delete(id)
      }
    },
    has(id: string): boolean { return counts.has(id) },
  }
}
export const mountedTranscriptViews = createMountedTranscriptRegistry()

/** 同一用户请求分批续扫巨型 JSONL 行。保留原方向和授权游标；切会话立即停止，期间不拿空页覆盖已读内容。 */
export async function readAdjacentTranscript(
  input: AgentTranscriptPageRequest, read: (request: AgentTranscriptPageRequest) => Promise<AgentTranscriptPage>, isCurrent: () => boolean,
): Promise<AgentTranscriptPage> {
  let request = input
  while (isCurrent()) {
    const page = await read(request)
    if (!page.indexRequired || page.status === 'resetRequired') return page
    if (!Number.isSafeInteger(page.indexBytes) || page.indexBytes <= 0) throw new Error('历史读取没有进展，请重试')
    if (input.mode === 'tail' && !request.cursor) {
      // 冷尾扫必须绑定本次观察的文件代次；没有可靠游标不能重新发起无条件 tail。
      const cursor = page.after
      if (!cursor || cursor.sessionId !== input.sessionId || cursor.generation !== page.generation) throw new Error('历史续读游标无效，请重试')
      request = { ...input, cursor }
    }
    // 每批之间释放事件循环；丢弃过期调用，不在用户离开后启动下一批 I/O。
    await new Promise<void>(resolve => setTimeout(resolve, 0))
  }
  throw new Error('历史读取已取消')
}
// 只保存进行中的Promise；完成/失败均清理，不缓存正文或延长历史生命周期。
const inflight = new WeakMap<(input: AgentTranscriptPageRequest) => Promise<AgentTranscriptPage>, Map<string, Promise<AgentTranscriptPage>>>()
export async function readTranscriptPageOnce(input: AgentTranscriptPageRequest, read: (input: AgentTranscriptPageRequest) => Promise<AgentTranscriptPage>, freshness = ''): Promise<AgentTranscriptPage> {
  let requests = inflight.get(read)
  if (!requests) { requests = new Map(); inflight.set(read, requests) }
  const key = JSON.stringify([freshness, input.sessionId, input.mode, input.cursor?.generation, input.cursor?.offset,
    input.messageId, input.maxTurns, input.maxRecords, input.maxBytes])
  const pending = requests.get(key)
  if (pending) return pending
  if (requests.size >= 32) throw new Error('历史请求过多，请稍后重试')
  const work = read(input)
  requests.set(key, work)
  try { return await work } finally { if (requests.get(key) === work) requests.delete(key) }
}
