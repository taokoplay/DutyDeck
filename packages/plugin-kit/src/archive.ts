import { inflateRawSync } from 'node:zlib'
import { isPluginResourcePath } from '@dutydeck/plugin-sdk'

/** 包容器上限；调用者只能收紧限制，不能扩大宿主预算。 */
export interface PluginArchiveLimits {
  maxArchiveBytes: number
  maxFileBytes: number
  maxExpandedBytes: number
  maxFiles: number
}

/** 安装包只承载小型能力资源，大型媒体不进入插件。 */
const LIMITS: PluginArchiveLimits = { maxArchiveBytes: 50 * 1024 * 1024, maxFileBytes: 16 * 1024 * 1024, maxExpandedBytes: 200 * 1024 * 1024, maxFiles: 2000 }
/** 严格 UTF-8 防止文件名的替换字符掩盖别名。 */
const decoder = new TextDecoder('utf-8', { fatal: true })

/** 收紧预算并拒绝无效测试/宿主配置。 */
function limitsFor(overrides: Partial<PluginArchiveLimits>): PluginArchiveLimits {
  /** 副本避免任何调用修改默认限制。 */
  const result = { ...LIMITS }
  for (const key of Object.keys(LIMITS) as Array<keyof PluginArchiveLimits>) {
    const value = overrides[key] ?? LIMITS[key]
    if (!Number.isSafeInteger(value) || value < 0 || value > LIMITS[key]) throw new Error('PLUGIN_ARCHIVE_LIMIT_INVALID')
    result[key] = value
  }
  return result
}

/** ZIP CRC-32 表只初始化一次，逐文件校验线性扫描载荷。 */
const CRC_TABLE = Uint32Array.from({ length: 256 }, (_, value) => {
  /** 当前多项式余数。 */
  let crc = value
  for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0)
  return crc >>> 0
})

/** 按 ZIP 标准计算内容校验和；不用于发布者信任。 */
function crc32(bytes: Uint8Array): number {
  /** 逐字节滚动校验状态。 */
  let crc = 0xffffffff
  for (const byte of bytes) crc = (crc >>> 8) ^ CRC_TABLE[(crc ^ byte) & 255]!
  return (crc ^ 0xffffffff) >>> 0
}

/** 校验文件名及集合唯一性，文件/目录前缀冲突也不能进入落盘阶段。 */
function acceptPath(path: string, seen: Set<string>): void {
  /** 使用 SDK 的同一可移植路径合同。 */
  const key = path.normalize('NFC').toLowerCase()
  if (!isPluginResourcePath(path) || seen.has(key)) throw new Error(`PLUGIN_ARCHIVE_PATH_INVALID:${path}`)
  for (const existing of seen) {
    if (key.startsWith(`${existing}/`) || existing.startsWith(`${key}/`)) throw new Error('PLUGIN_ARCHIVE_PATH_CONFLICT')
  }
  seen.add(key)
}

/**
 * 创建确定性 ZIP。使用 STORED 避免工具/压缩器版本改变同一包的字节。
 * @param files 已收集的相对路径与载荷，不遍历目录或执行作者脚本。
 * @param overrides 可选更严预算。
 * @returns 标准 ZIP 字节，后续完整性和签名由包层处理。
 */
export function createPluginArchive(files: ReadonlyMap<string, Uint8Array>, overrides: Partial<PluginArchiveLimits> = {}): Buffer {
  /** 编码状态均在当前调用内。 */
  const limits = limitsFor(overrides)
  const seen = new Set<string>()
  const locals: Buffer[] = []
  const centrals: Buffer[] = []
  let offset = 0
  let expanded = 0
  let centralBytes = 0
  if (files.size > limits.maxFiles) throw new Error('PLUGIN_ARCHIVE_TOO_MANY_FILES')
  for (const [path, bytes] of [...files].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)) {
    acceptPath(path, seen)
    expanded += bytes.byteLength
    if (bytes.byteLength > limits.maxFileBytes || expanded > limits.maxExpandedBytes) throw new Error('PLUGIN_ARCHIVE_EXPANSION_LIMIT')
    /** 每个文件头使用固定日期、常规只读载荷权限与 UTF-8 标记。 */
    const name = Buffer.from(path)
    const local = Buffer.alloc(30)
    const central = Buffer.alloc(46)
    const checksum = crc32(bytes)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(20, 4)
    local.writeUInt16LE(0x800, 6)
    local.writeUInt16LE(33, 12)
    local.writeUInt32LE(checksum, 14)
    local.writeUInt32LE(bytes.byteLength, 18)
    local.writeUInt32LE(bytes.byteLength, 22)
    local.writeUInt16LE(name.length, 26)
    central.writeUInt32LE(0x02014b50, 0)
    central.writeUInt16LE(0x314, 4)
    central.writeUInt16LE(20, 6)
    central.writeUInt16LE(0x800, 8)
    central.writeUInt16LE(33, 14)
    central.writeUInt32LE(checksum, 16)
    central.writeUInt32LE(bytes.byteLength, 20)
    central.writeUInt32LE(bytes.byteLength, 24)
    central.writeUInt16LE(name.length, 28)
    central.writeUInt32LE((0o100644 << 16) >>> 0, 38)
    central.writeUInt32LE(offset, 42)
    offset += local.length + name.length + bytes.byteLength
    centralBytes += central.length + name.length
    if (offset + centralBytes + 22 > limits.maxArchiveBytes) throw new Error('PLUGIN_ARCHIVE_SIZE_LIMIT')
    locals.push(local, name, Buffer.from(bytes))
    centrals.push(central, name)
  }
  /** 单卷、无注释、无 ZIP64 的结束记录。 */
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0)
  end.writeUInt16LE(files.size, 8)
  end.writeUInt16LE(files.size, 10)
  end.writeUInt32LE(centralBytes, 12)
  end.writeUInt32LE(offset, 16)
  if (offset + centralBytes + end.length > limits.maxArchiveBytes) throw new Error('PLUGIN_ARCHIVE_SIZE_LIMIT')
  return Buffer.concat([...locals, ...centrals, end])
}

/**
 * 有界读取包工具生成的 ZIP 子集，不解压到磁盘；拒绝目录、链接、额外头与多卷。
 * @param input 包字节。
 * @param overrides 可选更严预算。
 * @returns 完整校验后的文件集合；任何一项异常均整体失败。
 */
export function readPluginArchive(input: Uint8Array, overrides: Partial<PluginArchiveLimits> = {}): Map<string, Uint8Array> {
  /** 沿源字节读取，不先复制可能过大的输入。 */
  const limits = limitsFor(overrides)
  if (input.byteLength < 22 || input.byteLength > limits.maxArchiveBytes) throw new Error('PLUGIN_ARCHIVE_SIZE_LIMIT')
  const bytes = Buffer.from(input.buffer, input.byteOffset, input.byteLength)
  const end = bytes.length - 22
  if (bytes.readUInt32LE(end) !== 0x06054b50 || bytes.readUInt32LE(end + 4) !== 0 || bytes.readUInt16LE(end + 20) !== 0) throw new Error('PLUGIN_ARCHIVE_FORMAT_UNSUPPORTED')
  /** 中央目录整体必须恰好位于 EOF 记录之前。 */
  const count = bytes.readUInt16LE(end + 10)
  const centralSize = bytes.readUInt32LE(end + 12)
  const centralStart = bytes.readUInt32LE(end + 16)
  if (count !== bytes.readUInt16LE(end + 8) || count > limits.maxFiles || centralStart + centralSize !== end) throw new Error('PLUGIN_ARCHIVE_DIRECTORY_INVALID')
  const files = new Map<string, Uint8Array>()
  const seen = new Set<string>()
  let cursor = centralStart
  let localCursor = 0
  let expanded = 0
  for (let index = 0; index < count; index += 1) {
    if (cursor + 46 > end || bytes.readUInt32LE(cursor) !== 0x02014b50) throw new Error('PLUGIN_ARCHIVE_DIRECTORY_INVALID')
    /** 头字段须在有界范围内读取并与本地头交叉核验。 */
    const flags = bytes.readUInt16LE(cursor + 8)
    const method = bytes.readUInt16LE(cursor + 10)
    const checksum = bytes.readUInt32LE(cursor + 16)
    const compressed = bytes.readUInt32LE(cursor + 20)
    const size = bytes.readUInt32LE(cursor + 24)
    const nameLength = bytes.readUInt16LE(cursor + 28)
    const attributes = bytes.readUInt32LE(cursor + 38)
    const offset = bytes.readUInt32LE(cursor + 42)
    if (flags !== 0x800 || (method !== 0 && method !== 8) || bytes.readUInt32LE(cursor + 30) !== 0 || bytes.readUInt16LE(cursor + 34) !== 0
      || ((attributes >>> 16) & 0o170000) !== 0o100000 || (attributes & 0x10) !== 0) throw new Error('PLUGIN_ARCHIVE_ENTRY_UNSUPPORTED')
    if (cursor + 46 + nameLength > end || offset !== localCursor || offset + 30 + nameLength + compressed > centralStart) throw new Error('PLUGIN_ARCHIVE_ENTRY_INVALID')
    const name = bytes.subarray(cursor + 46, cursor + 46 + nameLength)
    const path = decoder.decode(name)
    acceptPath(path, seen)
    if (bytes.readUInt32LE(offset) !== 0x04034b50 || bytes.readUInt16LE(offset + 6) !== flags || bytes.readUInt16LE(offset + 8) !== method
      || bytes.readUInt32LE(offset + 14) !== checksum || bytes.readUInt32LE(offset + 18) !== compressed || bytes.readUInt32LE(offset + 22) !== size
      || bytes.readUInt16LE(offset + 26) !== nameLength || bytes.readUInt16LE(offset + 28) !== 0
      || !bytes.subarray(offset + 30, offset + 30 + nameLength).equals(name)) throw new Error('PLUGIN_ARCHIVE_HEADER_MISMATCH')
    expanded += size
    if (size > limits.maxFileBytes || expanded > limits.maxExpandedBytes) throw new Error('PLUGIN_ARCHIVE_EXPANSION_LIMIT')
    if (method === 0 && compressed !== size) throw new Error('PLUGIN_ARCHIVE_SIZE_MISMATCH')
    /** inflate 的实际输出硬上限生效，不能相信攻击者自报的展开大小。 */
    const payload = bytes.subarray(offset + 30 + nameLength, offset + 30 + nameLength + compressed)
    let content: Buffer
    if (method === 0) content = Buffer.from(payload)
    else {
      /** 校验实际消费字节，拒绝有效压缩流后隐藏的未声明内容。 */
      const inflated = inflateRawSync(payload, { maxOutputLength: Math.max(1, size), info: true }) as unknown as { buffer: Buffer; engine: { bytesWritten: number } }
      if (inflated.engine.bytesWritten !== payload.length) throw new Error('PLUGIN_ARCHIVE_TRAILING_COMPRESSED_DATA')
      content = inflated.buffer
    }
    if (content.length !== size || crc32(content) !== checksum) throw new Error('PLUGIN_ARCHIVE_CHECKSUM_MISMATCH')
    files.set(path, content)
    cursor += 46 + nameLength
    localCursor += 30 + nameLength + compressed
  }
  if (cursor !== end || localCursor !== centralStart) throw new Error('PLUGIN_ARCHIVE_TRAILING_DATA')
  return files
}
