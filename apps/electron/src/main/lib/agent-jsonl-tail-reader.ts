import { openSync, closeSync, readSync, fstatSync } from 'node:fs'

export interface JsonlTailLine { text: string; offset: number; end: number }
export interface JsonlTailResult { lines: JsonlTailLine[]; bytesRead: number; reachedStart: boolean; oversized: boolean }
export interface JsonlTailOptions { maxBytes?: number; maxLineBytes?: number; maxLines?: number; end?: number }

/** 最多读取固定预算；只在完整换行边界解码，超长行不越过后继续猜测较旧状态。 */
export function readJsonlTail(path: string, options: JsonlTailOptions = {}): JsonlTailResult {
  const maxBytes = options.maxBytes ?? 512 * 1024
  const maxLineBytes = options.maxLineBytes ?? 256 * 1024
  const maxLines = options.maxLines ?? 2048
  if (![maxBytes, maxLineBytes, maxLines].every((n) => Number.isSafeInteger(n) && n > 0)
    || maxBytes > 4 * 1024 * 1024 || maxLineBytes > 4 * 1024 * 1024 || maxLines > 10000
    || (options.end !== undefined && (!Number.isSafeInteger(options.end) || options.end < 0))) {
    throw new Error('JSONL 尾读预算非法')
  }
  const result: JsonlTailResult = { lines: [], bytesRead: 0, reachedStart: false, oversized: false }
  const fd = openSync(path, 'r')
  try {
    const stat = fstatSync(fd)
    if (!stat.isFile()) throw new Error('历史记录不是普通文件')
    let position = Math.min(options.end ?? stat.size, stat.size)
    let pending = Buffer.alloc(0)
    let recordEnd = position
    while (position > 0 && result.bytesRead < maxBytes) {
      const size = Math.min(16 * 1024, position, maxBytes - result.bytesRead)
      const buffer = Buffer.allocUnsafe(size)
      const start = position - size
      const read = readSync(fd, buffer, 0, size, start)
      result.bytesRead += read
      if (read !== size) return result // 并发截短：不使用不完整快照。
      const block = Buffer.concat([buffer, pending])
      let end = block.length
      for (let index = end - 1; index >= 0; index--) {
        if (block[index] !== 10) continue
        const length = end - index - 1
        if (length > maxLineBytes) { result.oversized = true; return result }
        if (length > 0 || recordEnd > start + index + 1) {
          result.lines.push({ text: block.subarray(index + 1, end).toString('utf8'), offset: start + index + 1, end: recordEnd })
          if (result.lines.length >= maxLines) return result
        }
        recordEnd = start + index + 1
        end = index
      }
      pending = block.subarray(0, end)
      position = start
      if (pending.length > maxLineBytes) { result.oversized = true; return result }
    }
    if (position === 0) {
      if (pending.length > 0 || recordEnd > 0) result.lines.push({ text: pending.toString('utf8'), offset: 0, end: recordEnd })
      result.reachedStart = true
    } else if (pending.length > 0) result.oversized = true
    return result
  } finally { closeSync(fd) }
}

/** 仅由主进程持有的半行状态；pending最多保留maxLineBytes，巨行只保留长度与边界。 */
export interface JsonlBatchContinuation {
  /** 下次物理读取的位置。 */
  position: number
  /** 当前记录的起点（正向）或终点（反向）。 */
  boundary: number
  /** 尚未遇到换行的正文片段。 */
  pending: Buffer[]
  /** 当前行已观察的字节数，超过预算时不再缓存正文。 */
  length: number
  /** 反向扫描时，当前行是否有已确认的末尾换行。 */
  terminated: boolean
}
/** 批次只提交已闭合的记录；text缺失表示超大记录占位。 */
export interface JsonlBatchResult {
  lines: Array<{ text?: string; offset: number; end: number }>
  bytesRead: number
  done: boolean
  continuation: JsonlBatchContinuation
}
/** 按方向在固定预算内扫描；调用方负责将continuation绑定到同一文件代次。 */
export function readJsonlBatch(path: string, options: {
  direction: 'forward' | 'backward'; start?: number; end: number
  maxBytes?: number; maxLineBytes?: number; maxLines?: number; continuation?: JsonlBatchContinuation
}): JsonlBatchResult {
  // 预算与物理范围在分配缓冲前验证。
  const maxBytes = options.maxBytes ?? 1024 * 1024
  const maxLineBytes = options.maxLineBytes ?? 256 * 1024
  const maxLines = options.maxLines ?? 1000
  const start = options.start ?? 0
  if (![maxBytes, maxLineBytes, maxLines].every((value) => Number.isSafeInteger(value) && value > 0)
    || maxBytes > 4 * 1024 * 1024 || maxLineBytes > 4 * 1024 * 1024 || maxLines > 10000
    || !Number.isSafeInteger(start) || start < 0 || !Number.isSafeInteger(options.end) || options.end < start) {
    throw new Error('JSONL 批次预算非法')
  }
  const backward = options.direction === 'backward'
  const initial = backward ? options.end : start
  // 克隆状态，避免后续请求修改已经返回的索引快照。
  const state: JsonlBatchContinuation = options.continuation ? { ...options.continuation, pending: [...options.continuation.pending] }
    : { position: initial, boundary: initial, pending: [], length: 0, terminated: false }
  const result: JsonlBatchResult = { lines: [], bytesRead: 0, done: false, continuation: state }
  /** 合并当前块的行片段；超出正文预算立即释放片段，仅继续找边界。 */
  function collect(piece: Buffer): void {
    state.length += piece.length
    if (state.length > maxLineBytes) state.pending = []
    else if (piece.length > 0) {
      // 分块持有，完整行只拼接一次，避免巨行续扫反复复制累积正文。
      if (backward) state.pending.unshift(piece)
      else state.pending.push(piece)
    }
  }
  /** 提交完整物理范围，清空半行；超大行不尝试解析不完整JSON。 */
  function emit(offset: number, end: number): void {
    result.lines.push({ offset, end, ...(state.length <= maxLineBytes ? { text: Buffer.concat(state.pending, state.length).toString('utf8') } : {}) })
  }
  const fd = openSync(path, 'r')
  try {
    const stat = fstatSync(fd)
    if (!stat.isFile() || stat.size < options.end) throw new Error('历史记录已截短或不是普通文件')
    while ((backward ? state.position > start : state.position < options.end) && result.bytesRead < maxBytes) {
      const size = Math.min(16 * 1024, maxBytes - result.bytesRead, backward ? state.position - start : options.end - state.position)
      const blockStart = backward ? state.position - size : state.position
      const buffer = Buffer.allocUnsafe(size)
      const read = readSync(fd, buffer, 0, size, blockStart)
      result.bytesRead += read
      if (read !== size) throw new Error('历史记录在批次读取期间已截短')
      let boundary = backward ? size : 0
      for (let index = backward ? size - 1 : 0; backward ? index >= 0 : index < size; index += backward ? -1 : 1) {
        if (buffer[index] !== 10) continue
        collect(backward ? buffer.subarray(index + 1, boundary) : buffer.subarray(boundary, index))
        const offset = blockStart + index + 1
        if (backward) {
          if (state.terminated) emit(offset, state.boundary)
          state.terminated = true
        } else emit(state.boundary, offset)
        state.boundary = offset
        state.pending = []; state.length = 0
        boundary = backward ? index : index + 1
        state.position = backward ? offset - 1 : offset
        if (result.lines.length >= maxLines) return result
      }
      collect(backward ? buffer.subarray(0, boundary) : buffer.subarray(boundary))
      state.position = backward ? blockStart : blockStart + size
    }
    result.done = backward ? state.position === start : state.position === options.end
    if (backward && result.done && state.terminated && state.boundary > start) {
      emit(start, state.boundary)
      state.boundary = start; state.pending = []; state.length = 0
    }
    return result
  } finally { closeSync(fd) }
}
