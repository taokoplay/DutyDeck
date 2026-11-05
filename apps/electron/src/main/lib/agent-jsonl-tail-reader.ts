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
