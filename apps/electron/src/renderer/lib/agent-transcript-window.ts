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
