import { afterEach, describe, expect, test } from 'bun:test'
import { randomUUID } from 'node:crypto'
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { CanvasErrorDiagnostic } from '@proma/shared'
import { createCanvasLoadErrorRecorder } from './canvas-load-error-log'

/** 每例独立的日志根，结束后删除，不使用真实业务数据。 */
const directories: string[] = []
/** 建立临时目录，返回绝对路径。 */
function temporaryDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), 'canvas-error-log-'))
  directories.push(directory)
  return directory
}
/** 构造可与前端对应的安全诊断。 */
function diagnostic(): CanvasErrorDiagnostic {
  return { stage: 'content-load', reason: 'unknown', referenceId: randomUUID() }
}
afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }) })

describe('Canvas LOAD 本地错误记录', () => {
  test('Given 未知错误 When 写入日志 Then 可按编号读回原因、时间、版本且凭据脱敏', () => {
    /** 独立测试目录，仅用于本用例。 */
    const directory = temporaryDirectory()
    /** 被测同步记录器。 */
    const record = createCanvasLoadErrorRecorder({ directory: () => directory, version: () => 'test-version', platform: 'win32' })
    const detail = diagnostic()
    expect(record(detail, new Error('原始失败 api_key=private-secret'))).toBe('saved')
    /** 从落盘内容验证，不依赖内存记录。 */
    const text = readFileSync(join(directory, 'canvas-load-errors.json'), 'utf8')
    /** 测试读取固定日志数组。 */
    const entries = JSON.parse(text)
    expect(entries[0].diagnostic.referenceId).toBe(detail.referenceId)
    expect(entries[0].version).toBe('test-version')
    expect(entries[0].platform).toBe('win32')
    expect(Number.isNaN(Date.parse(entries[0].timestamp))).toBe(false)
    expect(text).toContain('原始失败')
    expect(text).not.toContain('private-secret')
    if (process.platform !== 'win32') expect(statSync(join(directory, 'canvas-load-errors.json')).mode & 0o777).toBe(0o600)
  })
  test('Given 循环和超长错误 When 连续记录 Then 保留最新16条且不执行 getter/toJSON', () => {
    /** 独立测试目录，仅用于本用例。 */
    const directory = temporaryDirectory()
    /** 被测同步记录器。 */
    const record = createCanvasLoadErrorRecorder({ directory: () => directory })
    const error = { message: '故障'.repeat(100_000), cause: {} }
    error.cause = error
    Object.defineProperty(error, 'stack', { get: () => { throw new Error('不可执行 getter') } })
    Object.defineProperty(error, 'toJSON', { value: () => { throw new Error('不可执行 toJSON') } })
    /** 保存每次编号，以验证环中只留下最新的失败。 */
    const diagnostics = Array.from({ length: 30 }, diagnostic)
    for (const detail of diagnostics) expect(record(detail, error)).toBe('saved')
    /** 从落盘内容验证，不依赖内存记录。 */
    const text = readFileSync(join(directory, 'canvas-load-errors.json'), 'utf8')
    /** 测试读取固定日志数组。 */
    const entries = JSON.parse(text)
    expect(entries.length).toBe(16)
    for (let index = 0; index < 16; index++) expect(entries[index].diagnostic.referenceId).toBe(diagnostics[index + 14]!.referenceId)
    expect(Buffer.byteLength(text)).toBeLessThanOrEqual(256 * 1024)
    for (const entry of entries) expect(Buffer.byteLength(JSON.stringify(entry, null, 2))).toBeLessThanOrEqual(8192)
    expect(text).toContain('[Circular]')
    expect(readdirSync(directory)).toEqual(['canvas-load-errors.json'])
  })
  test('Given 包装异常 When 记录 Then 保留 causeError 且不遍历未知字段', () => {
    /** 独立测试目录，仅用于本用例。 */
    const directory = temporaryDirectory()
    /** 被测同步记录器。 */
    const record = createCanvasLoadErrorRecorder({ directory: () => directory })
    expect(record(diagnostic(), { causeError: new Error('底层 helper 原因'), toJSON: () => { throw new Error('不可调用') } })).toBe('saved')
    expect(readFileSync(join(directory, 'canvas-load-errors.json'), 'utf8')).toContain('底层 helper 原因')
  })
  test('Given 深链与异常代理 When 记录 Then 异常不逃逸且缩进记录大小有界', () => {
    /** 独立测试目录，仅用于本用例。 */
    const directory = temporaryDirectory()
    /** 被测同步记录器。 */
    const record = createCanvasLoadErrorRecorder({ directory: () => directory })
    const leaf = { message: '错'.repeat(100_000), stack: '栈'.repeat(100_000) }
    const error = { ...leaf, cause: { ...leaf, cause: { ...leaf, causeError: leaf } }, causeError: leaf }
    expect(record(diagnostic(), error)).toBe('saved')
    /** 从落盘内容验证，不依赖内存记录。 */
    const text = readFileSync(join(directory, 'canvas-load-errors.json'), 'utf8')
    /** 测试读取固定日志数组。 */
    const entries = JSON.parse(text)
    expect(Buffer.byteLength(JSON.stringify(entries[0], null, 2))).toBeLessThanOrEqual(8192)
    expect(record(diagnostic(), new Proxy({}, { getOwnPropertyDescriptor: () => { throw new Error('拒绝检查') } }))).toBe('saved')
  })
  test('Given 未分类系统错误 When 记录 Then 保留 own-data name/code 且不执行 getter', () => {
    /** 独立测试目录与被测记录器。 */
    const directory = temporaryDirectory()
    const record = createCanvasLoadErrorRecorder({ directory: () => directory })
    /** 未知系统错误码是本例唯一原因证据。 */
    const error = Object.assign(new Error('read failed'), { name: 'SystemError', code: 'EIO' })
    expect(record(diagnostic(), error)).toBe('saved')
    expect(record(diagnostic(), { name: 'NativeError', code: 123 })).toBe('saved')
    expect(record(diagnostic(), { code: Number.POSITIVE_INFINITY })).toBe('saved')
    expect(record(diagnostic(), Object.defineProperty({}, 'code', { get: () => { throw new Error('不可执行') } }))).toBe('saved')
    /** 从本地记录确认未知码及数值码不会丢失。 */
    const entries = JSON.parse(readFileSync(join(directory, 'canvas-load-errors.json'), 'utf8'))
    expect(entries[0].error.name).toBe('SystemError')
    expect(entries[0].error.code).toBe('EIO')
    expect(entries[1].error.code).toBe(123)
    expect(entries[2].error.code).toBeUndefined()
    expect(entries[3].error.code).toBeUndefined()
  })
  test('Given 敏感引号值被长度限制截断 When 写入日志 Then 空格换行后的秘密也被脱敏', () => {
    /** 使用真实落盘检查完整日志，而非仅测试字符串工具。 */
    const directory = temporaryDirectory()
    const record = createCanvasLoadErrorRecorder({ directory: () => directory })
    for (const quote of ['"', "'"]) {
      /** 消息截断时闭引号必定位于预算外。 */
      const message = `password=${quote}first secret-with-spaces
secret-next-line ${'s'.repeat(2000)}${quote}`
      expect(record(diagnostic(), new Error(message))).toBe('saved')
    }
    /** 堆栈与消息都不能保留截断敏感值的任何尾部。 */
    const text = readFileSync(join(directory, 'canvas-load-errors.json'), 'utf8')
    expect(text).not.toContain('secret-with-spaces')
    expect(text).not.toContain('secret-next-line')
    expect(text).not.toContain('ssss')
    expect(text).toContain('[REDACTED]')
  })
  test('Given 日志目录不可用 When 记录 Then 返回 unavailable 不阻止前端错误显示', () => {
    /** 独立测试目录，仅用于本用例。 */
    const directory = temporaryDirectory()
    const blocker = join(directory, 'file')
    writeFileSync(blocker, 'blocked')
    /** 被测同步记录器。 */
    const record = createCanvasLoadErrorRecorder({ directory: () => blocker })
    expect(record(diagnostic(), new Error('原始故障'))).toBe('unavailable')
    expect(createCanvasLoadErrorRecorder({ directory: () => { throw new Error('logs unavailable') } })(diagnostic(), null)).toBe('unavailable')
  })
})
