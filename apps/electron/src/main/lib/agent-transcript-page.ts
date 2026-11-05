import { projectDeferredTranscriptMessage } from '@dutydeck/shared'
import { open, stat } from 'node:fs/promises'
import type { AgentTranscriptEntry, AgentTranscriptPage, AgentTranscriptPageRequest, SDKMessage } from '@dutydeck/shared'
import { getTranscriptIndex, transcriptFileStamp, type TranscriptRecordLocation, type TranscriptIndex } from './agent-transcript-index'
import { agentHistoryPerformance } from './agent-history-performance'

function budget(value: number | undefined, fallback: number, max: number, min = 1): number {
  const result = value ?? fallback
  if (!Number.isSafeInteger(result) || result < min || result > max) throw new Error('历史页预算非法')
  return result
}
function lowerBound(records: readonly TranscriptRecordLocation[], offset: number): number {
  let low = 0; let high = records.length
  while (low < high) {
    const middle = (low + high) >>> 1
    if (records[middle]!.offset < offset) low = middle + 1
    else high = middle
  }
  return low
}
function deferredMessage(record: TranscriptRecordLocation, message?: SDKMessage): SDKMessage {
  return projectDeferredTranscriptMessage(message ?? record.deferredEnvelope,
    `此条历史记录超出单页展示预算（${record.end - record.offset} 字节）。原始记录未修改，可通过分段详情查看。`)
}

/** 仅返回展示投影；不用于模型恢复、编辑、fork/rewind 或导出。 */
export async function readTranscriptPage(
  path: string, request: AgentTranscriptPageRequest, project: (message: unknown) => SDKMessage,
): Promise<AgentTranscriptPage> {
  if (!request || typeof request.sessionId !== 'string' || !['tail', 'before', 'after', 'around', 'rebuild'].includes(request.mode)) throw new Error('历史页请求非法')
  const maxTurns = budget(request.maxTurns, 30, 60)
  const maxRecords = budget(request.maxRecords, 500, 1000)
  const maxBytes = budget(request.maxBytes, 1024 * 1024, 2 * 1024 * 1024, 4096)
  const cursor = request.cursor
  if (cursor && (cursor.sessionId !== request.sessionId || typeof cursor.generation !== 'string'
    || !Number.isSafeInteger(cursor.offset) || cursor.offset < 0)) throw new Error('历史游标不属于当前会话或格式非法')
  if ((request.mode === 'before' || request.mode === 'after') && !cursor) throw new Error('历史游标必填')
  if (request.mode === 'around' && (typeof request.messageId !== 'string' || request.messageId.length > 200)) throw new Error('消息定位ID非法')
  const started = performance.now()
  let index: TranscriptIndex
  try { index = await getTranscriptIndex(path, request.mode === 'tail' || request.mode === 'after') }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    return { sessionId: request.sessionId, status: cursor ? 'resetRequired' : 'page', generation: 'empty',
      revision: 'empty:0', observedEnd: 0, entries: [], hasBefore: false, hasAfter: false,
      startsMidTurn: false, endsMidTurn: false, ioBytes: 0, indexBytes: 0, turnNumbersRelative: false, returnedBytes: 0 }
  }
  if (cursor && cursor.generation === index.generation && cursor.offset < index.coverageStart) index = await getTranscriptIndex(path)
  const records = index.records
  const page: AgentTranscriptPage = { sessionId: request.sessionId, status: 'page', generation: index.generation,
    revision: `${index.generation}:${index.observedEnd}`, observedEnd: index.observedEnd,
    entries: [], hasBefore: false, hasAfter: false, startsMidTurn: false, endsMidTurn: false,
    ioBytes: 0, indexBytes: index.scannedBytes, turnNumbersRelative: !index.complete, returnedBytes: 0 }
  if (!index.complete && records.length === 0) {
    return { ...page, indexRequired: true, hasBefore: true }
  }
  if (cursor && (cursor.generation !== index.generation || cursor.offset > index.observedEnd
    || (cursor.offset !== index.observedEnd && cursor.offset !== 0 && records[lowerBound(records, cursor.offset)]?.offset !== cursor.offset))) {
    return { ...page, status: 'resetRequired' }
  }
  let position: number
  const backwards = request.mode === 'tail' || request.mode === 'rebuild' || request.mode === 'before'
  if (request.mode === 'tail' || request.mode === 'rebuild') position = records.length - 1
  else if (request.mode === 'before') position = lowerBound(records, cursor!.offset) - 1
  else if (request.mode === 'after') position = lowerBound(records, cursor!.offset)
  else {
    position = records.findIndex((row) => row.id === request.messageId)
    if (position < 0) return { ...page, status: 'resetRequired' }
    page.targetRecordId = records[position]!.id

  }
  if (request.mode === 'after' && position >= records.length) {
    const endCursor = { sessionId: request.sessionId, generation: index.generation, offset: index.observedEnd }
    return { ...page, status: 'unchanged', before: endCursor, after: endCursor, hasBefore: index.observedEnd > 0 }
  }
  const initialTurn = records[position]?.turn
  // 定位页先读取目标，再向前补同回合上下文；只读一次，不能失败后隐式叠加第二页IO。
  const positions: number[] = []
  if (request.mode === 'around') {
    positions.push(position)
    for (let previous = position - 1; previous >= 0 && records[previous]!.turn === initialTurn
      && positions.length <= Math.floor(maxRecords / 2); previous--) positions.push(previous)
    for (let next = position + 1; next < records.length && positions.length < maxRecords; next++) positions.push(next)
  } else {
    for (let next = position; next >= 0 && next < records.length && positions.length < maxRecords;
      next += backwards ? -1 : 1) positions.push(next)
  }
  let first = position; let last = position
  let projectionMs = 0
  let parsedRecords = 0
  const handle = await open(path, 'r')
  try {
    if (transcriptFileStamp(await handle.stat()) !== index.stamp) throw new Error('历史版本已变化，请重试')
    for (position of positions) {
      const record = records[position]!
      if (initialTurn !== undefined && Math.abs(record.turn - initialTurn) >= maxTurns) break
      const length = record.end - record.offset
      const oversized = length > Math.min(256 * 1024, maxBytes / 2)
      if (!oversized && page.ioBytes + length > maxBytes) break
      let message: SDKMessage
      let deferred = oversized
      if (oversized) message = deferredMessage(record)
      else {
        const buffer = Buffer.allocUnsafe(length)
        const { bytesRead } = await handle.read(buffer, 0, length, record.offset)
        page.ioBytes += bytesRead
        if (bytesRead !== length) throw new Error('历史已被截短，请重试')
        const projectStart = performance.now()
        try { parsedRecords++; message = project(JSON.parse(buffer.toString('utf8'))) }
        catch { message = deferredMessage(record); deferred = true }
        projectionMs += performance.now() - projectStart
      }
      let entry: AgentTranscriptEntry = { recordId: record.id, offset: record.offset, end: record.end, turn: record.turn, message,
        ...(deferred ? { deferred: true } : {}) }
      let bytes = Buffer.byteLength(JSON.stringify(entry)) + 1
      if (bytes > maxBytes - 1024) {
        entry = { ...entry, message: deferredMessage(record, message), deferred: true }
        bytes = Buffer.byteLength(JSON.stringify(entry)) + 1
      }
      if (bytes > maxBytes - 1024) {
        entry = { ...entry, message: projectDeferredTranscriptMessage(message, '此条记录及关联已分段；请查看记录详情。', 1), deferred: true }
        bytes = Buffer.byteLength(JSON.stringify(entry)) + 1
      }
      if (page.returnedBytes + bytes > maxBytes - 1024) break // 给游标、状态等控制字段预留固定空间。
      page.returnedBytes += bytes
      page.entries.push(entry)
      first = Math.min(first, position); last = Math.max(last, position)
    }
    if (transcriptFileStamp(await stat(path)) !== index.stamp) throw new Error('历史在读取期间发生变化，请重试')
  } finally { await handle.close() }
  page.entries.sort((left, right) => left.offset - right.offset)
  const firstRecord = page.entries.length > 0 ? records[first] : undefined
  const lastRecord = page.entries.length > 0 ? records[last] : undefined
  page.hasBefore = firstRecord !== undefined && (first > 0 || index.coverageStart > 0)
  page.hasAfter = lastRecord !== undefined && last < records.length - 1
  page.startsMidTurn = firstRecord !== undefined && ((first > 0 && records[first - 1]!.turn === firstRecord.turn)
    || (first === 0 && index.coverageStart > 0 && !firstRecord.turnStart))
  page.endsMidTurn = lastRecord !== undefined && last + 1 < records.length && records[last + 1]!.turn === lastRecord.turn
  page.before = { sessionId: request.sessionId, generation: index.generation, offset: firstRecord?.offset ?? 0 }
  page.after = { sessionId: request.sessionId, generation: index.generation, offset: lastRecord?.end ?? 0 }
  page.returnedBytes = Buffer.byteLength(JSON.stringify(page))
  if (agentHistoryPerformance.enabled) {
    const durationMs = performance.now() - started
    agentHistoryPerformance.record({ operation: 'page', durationMs, readMs: Math.max(0, durationMs - projectionMs),
      projectionMs, ioBytes: page.ioBytes + page.indexBytes, parsedRecords, returnedBytes: page.returnedBytes })
  }
  return page
}
