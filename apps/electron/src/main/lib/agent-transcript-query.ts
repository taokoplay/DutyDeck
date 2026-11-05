import { open, stat } from 'node:fs/promises'
import { createSearchSnippet, findBestSearchMatch, MAX_SEARCH_QUERY_SOURCE_LENGTH } from '@dutydeck/shared'
import type { SDKMessage, SessionMessageSearchResponse, SessionMessageSearchResult, AgentTranscriptDetailRequest } from '@dutydeck/shared'
import { scanJsonlRecords } from './agent-jsonl-reader'
import { getTranscriptIndex, transcriptFileStamp } from './agent-transcript-index'

/** 独立流式搜索授权的权威正文，不把当前展示窗口当作全部历史。 */
export async function searchTranscript(path: string, query: string): Promise<SessionMessageSearchResponse> {
  if (typeof query !== 'string' || query.length > MAX_SEARCH_QUERY_SOURCE_LENGTH) return { results: [], truncated: false, queryTooLong: true }
  if (query.trim().length < 2) return { results: [], truncated: false, queryTooLong: false }
  let index
  try { index = await getTranscriptIndex(path) }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { results: [], truncated: false, queryTooLong: false }; throw error }
  const results: Array<SessionMessageSearchResult & { score: number }> = []
  const limit = Math.min(index.observedEnd, 64 * 1024 * 1024)
  let truncated = limit < index.observedEnd
  let count = 0
  for await (const record of scanJsonlRecords(path, { end: limit })) {
    if (++count % 256 === 0) await new Promise<void>((resolve) => setImmediate(resolve))
    if (!record.text) { truncated = true; continue }
    try {
      const value = JSON.parse(record.text) as { type?: string; role?: string; uuid?: string; content?: string; message?: { content?: unknown } }
      const role = value.type ?? value.role
      if (role !== 'user' && role !== 'assistant') continue
      const content = value.message?.content ?? value.content
      const text = typeof content === 'string' ? content : Array.isArray(content)
        ? content.filter((block: { type?: string; text?: string }) => block?.type === 'text' && typeof block.text === 'string')
          .map((block: { text: string }) => block.text).join('\n') : ''
      const match = findBestSearchMatch(text, query)
      if (!match) continue
      results.push({ messageId: value.uuid || `@${index.generation}:${record.offset}`, role,
        ...createSearchSnippet(text, match.matchStart, match.matchLength), score: match.score })
      results.sort((a, b) => b.score - a.score)
      if (results.length > 50) { results.length = 50; truncated = true }
    } catch { /* 坏记录不是可搜索的正文。 */ }
  }
  if (transcriptFileStamp(await stat(path)) !== index.stamp) throw new Error('历史在搜索期间发生变化，请重试')
  return { results: results.map(({ score: _score, ...result }) => result), truncated, queryTooLong: false }
}

/** 单条按需投影：输出分片有界，仍剥离内嵌图片，不把原始JSONL直接交给Renderer。 */
export async function readTranscriptDetail(
  path: string, input: Omit<AgentTranscriptDetailRequest, 'sessionId'>, project: (value: unknown) => SDKMessage,
): Promise<{ text: string; nextOffset?: number }> {
  if (!input || typeof input.generation !== 'string' || !((typeof input.recordId === 'string' && input.recordId.length > 0 && input.recordId.length <= 200 && input.toolUseId === undefined)
      || (typeof input.toolUseId === 'string' && input.toolUseId.length > 0 && input.toolUseId.length <= 200 && input.recordId === undefined))
    || !Number.isSafeInteger(input.offset) || input.offset < 0 || input.offset > 32 * 1024 * 1024) throw new Error('历史详情参数非法')
  const index = await getTranscriptIndex(path)
  if (index.generation !== input.generation) throw new Error('历史版本已变化，请重新定位')
  let row: { offset: number; end: number } | undefined = index.records.find((record) => record.id === input.recordId)
  if (input.toolUseId) {
    let count = 0
    for await (const record of scanJsonlRecords(path, { end: Math.min(index.observedEnd, 64 * 1024 * 1024), maxLineBytes: 4 * 1024 * 1024 })) {
      if (++count % 256 === 0) await new Promise<void>(resolve => setImmediate(resolve))
      if (!record.text) continue
      try {
        const value = JSON.parse(record.text) as { type?: string; message?: { content?: Array<{ type?: string; tool_use_id?: string }> } }
        if (value.type === 'user' && Array.isArray(value.message?.content)
          && value.message.content.some(block => block?.type === 'tool_result' && block.tool_use_id === input.toolUseId)) { row = record; break }
      } catch { /* 损坏行不能作为工具关联的证据。 */ }
    }
    if (!row) throw new Error('在64MiB检索/4MiB单条预算内未找到工具结果；可能未产生、超限或已删除，请通过历史分段或完整导出检查')
  }
  if (!row) throw new Error('历史记录已不存在')
  if (row.end - row.offset > 16 * 1024 * 1024) throw new Error('单条历史超过16MiB详情读取预算，请使用完整会话导出')
  const file = await open(path, 'r')
  try {
    if (transcriptFileStamp(await file.stat()) !== index.stamp) throw new Error('历史版本已变化')
    const buffer = Buffer.allocUnsafe(row.end - row.offset)
    const { bytesRead } = await file.read(buffer, 0, buffer.length, row.offset)
    if (bytesRead !== buffer.length) throw new Error('历史记录不完整')
    const text = JSON.stringify(project(JSON.parse(buffer.toString('utf8'))), null, 2)
    if (transcriptFileStamp(await stat(path)) !== index.stamp) throw new Error('历史版本已变化')
    const end = Math.min(text.length, input.offset + 16000)
    return { text: text.slice(input.offset, end), ...(end < text.length ? { nextOffset: end } : {}) }
  } finally { await file.close() }
}

/** 重试是显式操作，独立读取权威输入，不依赖有界展示窗；未知超长记录后禁止猜测旧输入。 */
export async function readTranscriptRetryInput(path: string, project: (value: unknown) => SDKMessage): Promise<SDKMessage | null> {
  let before
  try { before = await stat(path) } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error }
  if (before.size > 256 * 1024 * 1024) throw new Error('重试输入检索超过256MiB预算，请在新会话继续')
  let result: SDKMessage | null = null
  let unknown = false; let count = 0
  for await (const record of scanJsonlRecords(path, { end: before.size, maxLineBytes: 4 * 1024 * 1024 })) {
    if (++count % 256 === 0) await new Promise<void>((resolve) => setImmediate(resolve))
    if (!record.text) { unknown = true; continue }
    let value: SDKMessage
    try { value = project(JSON.parse(record.text)) } catch { unknown = true; continue }
    const user = value as { type?: string; parent_tool_use_id?: string; isSynthetic?: boolean; message?: { content?: unknown } }
    const content = user.message?.content
    if (user.type !== 'user' || user.parent_tool_use_id || user.isSynthetic || !Array.isArray(content)) continue
    if (content.some(block => block?.type === 'tool_result') || !content.some(block => block?.type === 'text' && typeof block.text === 'string')) continue
    result = value; unknown = false
  }
  if (transcriptFileStamp(await stat(path)) !== transcriptFileStamp(before)) throw new Error('历史在读取重试输入期间变化，请重试')
  if (unknown) throw new Error('最新历史存在超出读取预算或无法解析的记录，不能安全推断重试输入')
  return result
}

/** 小批量精准持久化确认；仅返回身份/位置，不向Renderer传输页外正文。 */
export async function acknowledgeTranscriptRecords(path: string, generation: string, ids: string[]): Promise<Array<{ uuid: string; offset: number }>> {
  if (typeof generation !== 'string' || !Array.isArray(ids) || ids.length > 512
    || ids.some(id => typeof id !== 'string' || !id || id.length > 200)) throw new Error('历史确认参数非法')
  const index = await getTranscriptIndex(path)
  if (index.generation !== generation) throw new Error('历史版本已变化')
  const requested = new Set(ids)
  const result = index.records.filter(row => !row.id.startsWith('@') && requested.has(row.id)).map(row => ({ uuid: row.id, offset: row.offset }))
  if (transcriptFileStamp(await stat(path)) !== index.stamp) throw new Error('历史版本已变化')
  return result
}
