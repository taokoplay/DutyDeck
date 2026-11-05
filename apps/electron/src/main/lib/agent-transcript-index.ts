import { projectDeferredTranscriptMessage, type SDKMessage } from '@dutydeck/shared'
import { lstatSync, mkdirSync, readFileSync, rmSync, statSync, type Stats } from 'node:fs'
import { createHmac, randomBytes, randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { scanJsonlRecords } from './agent-jsonl-reader'
import { readJsonlTail } from './agent-jsonl-tail-reader'
import { writeJsonFileAtomicSecure } from './safe-file'

export interface TranscriptRecordLocation {
  offset: number
  end: number
  id: string
  turn: number
  turnStart: boolean
  deferredEnvelope?: SDKMessage
}
export interface TranscriptIndex {
  generation: string
  stamp: string
  size: number
  observedEnd: number
  records: TranscriptRecordLocation[]
  scannedBytes: number
  /** 冷启动尾页可先返回局部索引；需要前页/定位时再异步补全。 */
  complete: boolean
  coverageStart: number
}
interface CachedIndex { index: TranscriptIndex; acceptedStamp: string }
interface IndexManifest {
  version: 1
  generation: string
  stamp: string
  size: number
  observedEnd: number
  count: number
  authentication?: string
  chunks?: string[]
}
// 派生索引不具备权威性。认证只在本进程有效；重启后从JSONL重建，不能信任本地可编辑sidecar。
const indexKey = randomBytes(32)
function authenticate(value: unknown): string { return createHmac('sha256', indexKey).update(JSON.stringify(value)).digest('hex') }
const CHUNK_SIZE = 1024
const MAX_RECORDS = 250_000
const MAX_CACHE_RECORDS = 300_000
const indexChunkDigests = new WeakMap<TranscriptRecordLocation[], string[]>()
const cache = new Map<string, CachedIndex>()
const pending = new Map<string, Promise<TranscriptIndex>>()
const epochs = new Map<string, number>()
let activeBuilds = 0
const buildQueue: Array<() => void> = []
async function acquireBuild(): Promise<() => void> {
  if (activeBuilds >= 2) {
    if (buildQueue.length >= 16) throw new Error('历史索引构建繁忙，请稍后重试')
    await new Promise<void>((resolve) => buildQueue.push(resolve))
  } else activeBuilds++
  return () => { const next = buildQueue.shift(); if (next) next(); else activeBuilds-- }
}

export function transcriptFileStamp(stat: Stats): string {
  return `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`
}

function putCache(path: string, entry: CachedIndex): void {
  cache.delete(path)
  cache.set(path, entry)
  let records = [...cache.values()].reduce((sum, item) => sum + item.index.records.length, 0)
  for (const [key, value] of cache) {
    if (cache.size <= 8 && records <= MAX_CACHE_RECORDS) break
    records -= value.index.records.length
    cache.delete(key)
  }
}

/** sidecar 只有受管数字分片，不接收其中的路径，也不跟随目录链接。 */
function indexDirectory(path: string, create: boolean): string | undefined {
  const directory = `${path}.display-index`
  try {
    const stat = lstatSync(directory)
    return stat.isDirectory() && !stat.isSymbolicLink() ? directory : undefined
  } catch {
    if (!create) return undefined
    try { mkdirSync(directory); return directory } catch { return undefined }
  }
}
function readIndexJson(path: string, maxBytes: number): unknown {
  const stat = lstatSync(path)
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > maxBytes) throw new Error('索引文件非法')
  return JSON.parse(readFileSync(path, 'utf8'))
}
function validRecord(value: unknown, previousEnd: number, size: number): value is TranscriptRecordLocation {
  if (!value || typeof value !== 'object') return false
  const row = value as TranscriptRecordLocation
  return Number.isSafeInteger(row.offset) && row.offset === previousEnd
    && Number.isSafeInteger(row.end) && row.end > row.offset && row.end <= size
    && Number.isSafeInteger(row.turn) && row.turn >= 0 && typeof row.turnStart === 'boolean'
    && typeof row.id === 'string' && row.id.length > 0 && row.id.length <= 200
}
async function restoreIndex(path: string, stamp: string, size: number): Promise<TranscriptIndex | undefined> {
  const directory = indexDirectory(path, false)
  if (!directory) return undefined
  try {
    const meta = readIndexJson(join(directory, 'manifest.json'), 32768) as IndexManifest
    const { authentication, ...body } = meta
    if (!authentication || authentication !== authenticate(body) || !Array.isArray(meta.chunks)) return undefined
    let readBytes = Buffer.byteLength(JSON.stringify(meta))
    if (meta.version !== 1 || meta.stamp !== stamp || !/^[a-f0-9-]{36}$/.test(meta.generation)
      || !Number.isSafeInteger(meta.count) || meta.count < 0 || meta.count > MAX_RECORDS
      || !Number.isSafeInteger(meta.size) || meta.size < 0 || !Number.isSafeInteger(meta.observedEnd)
      || meta.observedEnd < 0 || meta.observedEnd > meta.size || meta.size !== size) return undefined
    const records: TranscriptRecordLocation[] = []
    for (let chunk = 0; chunk < Math.ceil(meta.count / CHUNK_SIZE); chunk++) {
      const rows = readIndexJson(join(directory, `${chunk}.json`), CHUNK_SIZE * 2048)
      if (!Array.isArray(rows) || rows.length > CHUNK_SIZE || authenticate(rows) !== meta.chunks[chunk]) return undefined
      readBytes += Buffer.byteLength(JSON.stringify(rows))
      await new Promise<void>((resolve) => setImmediate(resolve))
      for (const row of rows) {
        if (!validRecord(row, records.at(-1)?.end ?? 0, meta.observedEnd)
          || row.turn !== (records.at(-1)?.turn ?? 0) + (row.turnStart ? 1 : 0)) return undefined
        records.push(row)
      }
    }
    if (records.length !== meta.count || (records.at(-1)?.end ?? 0) !== meta.observedEnd) return undefined
    indexChunkDigests.set(records, meta.chunks)
    return { generation: meta.generation, stamp, size: meta.size, observedEnd: meta.observedEnd, records, scannedBytes: readBytes, complete: true, coverageStart: 0 }
  } catch { return undefined }
}
function persistIndex(path: string, index: TranscriptIndex, firstChanged: number): void {
  const directory = indexDirectory(path, true)
  if (!directory) return
  try {
    for (let start = Math.floor(firstChanged / CHUNK_SIZE) * CHUNK_SIZE; start < index.records.length; start += CHUNK_SIZE) {
      writeJsonFileAtomicSecure(join(directory, `${start / CHUNK_SIZE}.json`), index.records.slice(start, start + CHUNK_SIZE))
    }
    const chunks = indexChunkDigests.get(index.records) ?? []
    for (let start = Math.floor(firstChanged / CHUNK_SIZE) * CHUNK_SIZE; start < index.records.length; start += CHUNK_SIZE) {
      chunks[start / CHUNK_SIZE] = authenticate(index.records.slice(start, start + CHUNK_SIZE))
    }
    indexChunkDigests.set(index.records, chunks)
    const meta: IndexManifest = { version: 1, generation: index.generation, stamp: index.stamp,
      size: index.size, observedEnd: index.observedEnd, count: index.records.length, chunks }
    writeJsonFileAtomicSecure(join(directory, 'manifest.json'), { ...meta, authentication: authenticate(meta) })
  } catch { /* 派生缓存失败不能改变权威正文的成功状态。 */ }
}
function identifyRecord(text: string | undefined): { id?: string; turnStart: boolean; deferredEnvelope?: SDKMessage } {
  if (text === undefined) return { turnStart: false }
  try {
    const value = JSON.parse(text) as Record<string, unknown>
    if (!value || typeof value !== 'object') return { turnStart: false }
    const id = typeof value.uuid === 'string' && value.uuid.length <= 200 ? value.uuid : undefined
    const message = value.message as { content?: unknown } | undefined
    const content = message?.content
    const toolResult = Array.isArray(content) && content.some((block: unknown) => block && typeof block === 'object' && (block as { type?: string }).type === 'tool_result')
    const turnStart = value.type === 'user' ? !toolResult && !value.parent_tool_use_id && !value.isSynthetic : value.role === 'user'
    return { id, turnStart, ...(Buffer.byteLength(text) > 1024 ? {
      deferredEnvelope: projectDeferredTranscriptMessage(value as SDKMessage, '此记录已分段。请通过记录详情查看完整展示投影。', 1),
    } : {}) }
  } catch { return { turnStart: false } }
}

/** 未知外部变更换代；只有受管 append 的前后版本连续时才复用偏移。 */
export async function getTranscriptIndex(path: string, tailOnly = false): Promise<TranscriptIndex> {
  const inflight = pending.get(path)
  if (inflight) { await inflight; return getTranscriptIndex(path, tailOnly) }
  const work = (async () => {
    const release = await acquireBuild()
    try { return await buildIndex(path, tailOnly) } finally { release() }
  })()
  pending.set(path, work)
  try { return await work } finally { if (pending.get(path) === work) pending.delete(path) }
}
async function buildIndex(path: string, tailOnly: boolean): Promise<TranscriptIndex> {
  const stat = statSync(path)
  if (!stat.isFile()) throw new Error('历史记录不是普通文件')
  const stamp = transcriptFileStamp(stat)
  let cached = cache.get(path)
  if (!cached && !tailOnly) {
    const restored = await restoreIndex(path, stamp, stat.size)
    if (restored && transcriptFileStamp(statSync(path)) === stamp) {
      putCache(path, { index: restored, acceptedStamp: stamp })
      return restored
    }
  }
  if (cached?.index.stamp === stamp && (cached.index.complete || tailOnly)) {
    putCache(path, cached)
    return { ...cached.index, scannedBytes: 0 }
  }
  // 缓存存在不代表可继续其偏移；未知重写也应走有界冷tail，而非隐式全扫。
  if (cached && cached.acceptedStamp !== stamp) { cache.delete(path); cached = undefined }
  const epoch = epochs.get(path) ?? 0
  const promote = cached?.acceptedStamp === stamp && !cached.index.complete && !tailOnly
  const append = !promote && cached?.acceptedStamp === stamp && stat.size >= cached.index.observedEnd
  const generation = append || promote ? cached!.index.generation : randomUUID()
  if (!cached && tailOnly) {
    const tail = readJsonlTail(path, { maxBytes: 1024 * 1024, maxLines: 1000 })
    let turn = 0
    const rows: TranscriptRecordLocation[] = []
    for (const record of tail.lines.toReversed()) {
      // 末尾半行不提交；仍保留完整坏行的物理范围。
      if (record.end - record.offset <= Buffer.byteLength(record.text)) continue
      const identity = identifyRecord(record.text)
      if (identity.turnStart) turn++
      rows.push({ offset: record.offset, end: record.end, id: identity.id ?? `@${generation}:${record.offset}`, turn, turnStart: identity.turnStart, deferredEnvelope: identity.deferredEnvelope })
    }
    {
      if (transcriptFileStamp(statSync(path)) !== stamp) throw new Error('历史在尾页读取期间发生变化，请重试')
      const index: TranscriptIndex = { generation, stamp, size: stat.size, observedEnd: rows.at(-1)?.end ?? 0,
        records: rows, scannedBytes: tail.bytesRead, complete: tail.reachedStart, coverageStart: rows[0]?.offset ?? (tail.reachedStart ? 0 : stat.size) }
      if (index.complete) persistIndex(path, index, 0)
      putCache(path, { index, acceptedStamp: stamp })
      return index
    }
  }
  // 正文读取持有旧snapshot跨await；只复制偏移引用，绝不让追加修改旧observedEnd对应的数组。
  const records = append ? cached!.index.records.slice() : []
  if (append) indexChunkDigests.set(records, [...(indexChunkDigests.get(cached!.index.records) ?? [])])
  const firstChanged = records.length
  let observedEnd = append ? cached!.index.observedEnd : 0
  const scanStart = observedEnd
  let turn = records.at(-1)?.turn ?? 0
  try {
    for await (const record of scanJsonlRecords(path, { start: observedEnd, end: stat.size, maxLineBytes: 4 * 1024 * 1024 })) {
      const identity = identifyRecord(record.text)
      if (identity.turnStart) turn++
      if (records.length >= MAX_RECORDS) throw new Error('历史索引超过单会话资源预算，请缩小会话或使用完整导出')
      records.push({ offset: record.offset, end: record.end, id: identity.id ?? `@${generation}:${record.offset}`, turn, turnStart: identity.turnStart, deferredEnvelope: identity.deferredEnvelope })
      observedEnd = record.end
    }
    if (transcriptFileStamp(statSync(path)) !== stamp || (epochs.get(path) ?? 0) !== epoch) throw new Error('历史在索引期间发生变化，请重试')
    const index: TranscriptIndex = { generation, stamp, size: stat.size, observedEnd, records, scannedBytes: stat.size - scanStart,
      complete: append ? cached!.index.complete : true, coverageStart: append ? cached!.index.coverageStart : 0 }
    if (index.complete) persistIndex(path, index, firstChanged)
    putCache(path, { index, acceptedStamp: stamp })
    return index
  } catch (error) {
    if (append) records.length = firstChanged
    cache.delete(path)
    throw error
  }
}
export function noteTranscriptAppend(path: string, previousStamp: string): void {
  const cached = cache.get(path)
  if (!cached || cached.acceptedStamp !== previousStamp) return
  try { cached.acceptedStamp = transcriptFileStamp(statSync(path)) } catch { cache.delete(path) }
}
export function invalidateTranscriptIndex(path: string): void {
  cache.delete(path)
  // 只有正在执行的构建需要取消代次；无活动任务不积累session键。
  if (pending.has(path)) {
    epochs.set(path, (epochs.get(path) ?? 0) + 1)
    void pending.get(path)!.catch(() => {}).finally(() => { epochs.delete(path) })
  }
  const directory = indexDirectory(path, false)
  if (directory) { try { rmSync(directory, { recursive: true, force: true }) } catch { /* 可重建 */ } }
}
