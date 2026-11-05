import { open } from 'node:fs/promises'

export interface JsonlRecord {
  offset: number
  end: number
  /** 超长记录仅保留物理范围，绝不保留巨型字符串。 */
  text?: string
}

/** 分块流式扫描：可用于异步索引与回填，不阻塞主进程同步读取整份历史。 */
export async function* scanJsonlRecords(
  path: string,
  options: { start?: number; end?: number; maxLineBytes?: number } = {},
): AsyncGenerator<JsonlRecord> {
  const start = options.start ?? 0
  const maxLineBytes = options.maxLineBytes ?? 256 * 1024
  if (!Number.isSafeInteger(start) || start < 0 || !Number.isSafeInteger(maxLineBytes) || maxLineBytes < 1
    || maxLineBytes > 4 * 1024 * 1024 || (options.end !== undefined && (!Number.isSafeInteger(options.end) || options.end < start))) {
    throw new Error('JSONL 扫描范围非法')
  }
  const handle = await open(path, 'r')
  try {
    const stat = await handle.stat()
    if (!stat.isFile()) throw new Error('历史记录不是普通文件')
    const limit = Math.min(options.end ?? stat.size, stat.size)
    let position = start
    let recordStart = start
    let chunks: Buffer[] = []
    let length = 0
    while (position < limit) {
      const buffer = Buffer.allocUnsafe(Math.min(64 * 1024, limit - position))
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, position)
      if (bytesRead === 0) break
      let from = 0
      for (let index = 0; index < bytesRead; index++) {
        if (buffer[index] !== 10) continue
        const part = buffer.subarray(from, index)
        length += part.length
        if (length <= maxLineBytes) chunks.push(part)
        const end = position + index + 1
        yield { offset: recordStart, end, text: length <= maxLineBytes ? Buffer.concat(chunks).toString('utf8') : undefined }
        recordStart = end
        chunks = []; length = 0; from = index + 1
      }
      if (from < bytesRead) {
        const part = buffer.subarray(from, bytesRead)
        length += part.length
        if (length <= maxLineBytes) chunks.push(part)
        else chunks = []
      }
      position += bytesRead
    }
    // 尾部无换行可能正在追写；索引/回填不把它提交为稳定记录。
  } finally { await handle.close() }
}
