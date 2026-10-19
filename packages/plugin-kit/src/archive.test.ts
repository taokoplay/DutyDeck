import { describe, expect, test } from 'bun:test'
import { deflateRawSync } from 'node:zlib'
import { createPluginArchive, readPluginArchive } from './archive'

/** 统一 UTF-8 测试载荷，避免测试依赖真实插件或外部 ZIP 工具。 */
const text = (value: string): Uint8Array => new TextEncoder().encode(value)

describe('插件 ZIP 容器合同', () => {
  test('Given 相同文件不同枚举顺序 When 打包 Then 字节一致且往返保留正文', () => {
    /** 两个输入模拟文件系统枚举顺序不同。 */
    const first = new Map([['plugin.json', text('{"version":2}')], ['skills/demo/SKILL.md', text('中文内容')]])
    const second = new Map([...first].reverse())
    expect(createPluginArchive(first)).toEqual(createPluginArchive(second))
    expect([...readPluginArchive(createPluginArchive(first))]).toEqual([...second].sort(([a], [b]) => a.localeCompare(b, 'en')))
  })

  test('Given 路径逃逸或归一后冲突 When 打包 Then 拒绝', () => {
    for (const path of ['../outside', '/absolute', 'a\\b', 'a/../b', 'CON', 'assets/a:stream', 'a//b', 'a./b']) {
      expect(() => createPluginArchive(new Map([[path, text('x')]]))).toThrow()
    }
    expect(() => createPluginArchive(new Map([['Assets/a', text('1')], ['assets/A', text('2')]]))).toThrow()
  })

  test('Given 内容被篡改或截断 When 读取 Then 拒绝而不返回部分文件', () => {
    /** 存储模式下直接修改第一个载荷字节，验证 CRC 校验生效。 */
    const bytes = createPluginArchive(new Map([['a.txt', text('hello')]]))
    const tampered = Buffer.from(bytes)
    tampered[35] = (tampered[35] ?? 0) ^ 1
    expect(() => readPluginArchive(tampered)).toThrow()
    expect(() => readPluginArchive(bytes.subarray(0, bytes.length - 1))).toThrow()
  })

  test('Given 中央目录声明软链接或重复偏移 When 读取 Then 拒绝', () => {
    /** 中央目录头位置来自本工具生成的确定性容器。 */
    const bytes = Buffer.from(createPluginArchive(new Map([['a.txt', text('hello')]])))
    const central = bytes.readUInt32LE(bytes.length - 6)
    bytes.writeUInt32LE((0o120777 << 16) >>> 0, central + 38)
    expect(() => readPluginArchive(bytes)).toThrow()
  })

  test('Given 文件或包预算不足 When 编解包 Then 在超额处拒绝', () => {
    const files = new Map([['a.txt', text('hello')]])
    expect(() => createPluginArchive(files, { maxFileBytes: 4 })).toThrow()
    const bytes = createPluginArchive(files)
    expect(() => readPluginArchive(bytes, { maxFileBytes: 4 })).toThrow()
    expect(() => readPluginArchive(bytes, { maxArchiveBytes: 10 })).toThrow()
    expect(() => readPluginArchive(bytes, { maxFiles: 0 })).toThrow()
  })

  test('Given STORED 压缩/展开声明不同 When 读取 Then 在复制载荷前拒绝头', () => {
    /** 载荷保留，但两份头谎称零字节展开大小。 */
    const bytes = Buffer.from(createPluginArchive(new Map([['a.txt', text('hello')]])))
    const central = bytes.readUInt32LE(bytes.length - 6)
    bytes.writeUInt32LE(0, 22)
    bytes.writeUInt32LE(0, central + 24)
    expect(() => readPluginArchive(bytes, { maxFileBytes: 0 })).toThrow('PLUGIN_ARCHIVE_SIZE_MISMATCH')
  })

  test('Given DEFLATE流包含尾随字节 When 读取 Then 拒绝隐藏内容', () => {
    /** 单文件夹具保留原CRC和展开大小，仅替换压缩载荷及相关偏移。 */
    const original = createPluginArchive(new Map([['a.txt', text('hello')]]))
    const originalCentral = original.readUInt32LE(original.length - 6)
    const compressed = deflateRawSync(text('hello'))
    function variant(extra: string): Buffer {
      const payload = Buffer.concat([compressed, Buffer.from(extra)])
      const bytes = Buffer.concat([original.subarray(0, 35), payload, original.subarray(originalCentral)])
      const central = 35 + payload.length
      bytes.writeUInt16LE(8, 8)
      bytes.writeUInt32LE(payload.length, 18)
      bytes.writeUInt16LE(8, central + 10)
      bytes.writeUInt32LE(payload.length, central + 20)
      bytes.writeUInt32LE(central, bytes.length - 6)
      return bytes
    }
    expect(new TextDecoder().decode(readPluginArchive(variant('')).get('a.txt'))).toBe('hello')
    expect(() => readPluginArchive(variant('hidden bytes'))).toThrow('PLUGIN_ARCHIVE_TRAILING_COMPRESSED_DATA')
  })

  test('Given 空包预算不足以容纳结束头 When 打包 Then 拒绝', () => {
    expect(() => createPluginArchive(new Map(), { maxArchiveBytes: 0 })).toThrow('PLUGIN_ARCHIVE_SIZE_LIMIT')
  })
})
