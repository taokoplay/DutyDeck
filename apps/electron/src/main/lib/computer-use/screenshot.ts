import { constants } from 'node:fs'
import { open } from 'node:fs/promises'

/** 安全读取 PNG：在同一个句柄内限制读取量并检查尺寸。 */
export async function readPng(path: string): Promise<string | undefined> {
  /** 防止磁盘文件变大绕过 stat 检查的固定读取上限。 */
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW).catch((error: unknown) => { if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return null; throw error })
  if (!handle) return undefined
  try {
    if (!(await handle.stat()).isFile()) throw new Error('截图不是普通文件')
    /** 多读一字节识别超限文件。 */
    const buffer = Buffer.alloc(4 * 1024 * 1024 + 1)
    /** 已读取字节数。 */
    let length = 0
    while (length < buffer.length) {
      /** 本次读取结果。 */
      const result = await handle.read(buffer, length, buffer.length - length, null)
      if (!result.bytesRead) break
      length += result.bytesRead
    }
    if (length > 4 * 1024 * 1024 || length < 24 || !buffer.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10])) || buffer.toString('ascii',12,16) !== 'IHDR' || buffer.readUInt32BE(16) > 1280 || buffer.readUInt32BE(20) > 1280 || !buffer.readUInt32BE(16) || !buffer.readUInt32BE(20)) throw new Error('截图超限或 PNG 无效')
    return buffer.subarray(0, length).toString('base64')
  } finally { await handle.close() }
}
