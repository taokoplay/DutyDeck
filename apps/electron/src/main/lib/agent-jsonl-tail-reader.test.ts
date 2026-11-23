import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { readJsonlTail } from './agent-jsonl-tail-reader'
const directories: string[] = []
function fixture(text: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'dutydeck-tail-')); directories.push(dir)
  const path = join(dir, 'history.jsonl'); writeFileSync(path, text); return path
}
afterEach(() => { for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true }) })
describe('有界 JSONL 倒读', () => {
  test('Given 中英混合和无末尾换行 When 倒读 Then 保留完整UTF8与精确物理偏移', () => {
    const result = readJsonlTail(fixture('第一行\n{"末尾":"中文"}'))
    expect(result.lines.map((line) => line.text)).toEqual(['{"末尾":"中文"}', '第一行'])
    expect(result.lines[0]?.offset).toBe(Buffer.byteLength('第一行\n'))
    expect(result.reachedStart).toBe(true)
  })
  test('Given 相同尾部与巨大前缀 When 限制读取 Then 不随文件长度扫描', () => {
    const path = fixture('prefix\n'.repeat(100000) + '尾部\n')
    const result = readJsonlTail(path, { maxBytes: 256, maxLines: 1 })
    expect(result.lines.map((line) => line.text)).toEqual(['尾部'])
    expect(result.bytesRead).toBeLessThanOrEqual(256)
    expect(result.reachedStart).toBe(false)
  })
  test('Given 超长单行 When 预算不足 Then 不把中间片段当完整行也不越过它推测旧状态', () => {
    const result = readJsonlTail(fixture('older\n' + '汉'.repeat(300000) + '\nlast\n'), { maxBytes: 512, maxLineBytes: 128 })
    expect(result.lines.map((line) => line.text)).toEqual(['last'])
    expect(result.oversized).toBe(true)
    expect(result.bytesRead).toBeLessThanOrEqual(512)
  })
  test('Given 多行与分页end When 读前页 Then 不包含end后的内容', () => {
    const result = readJsonlTail(fixture('one\ntwo\nthree\n'), { end: 8 })
    expect(result.lines.map((line) => line.text)).toEqual(['two', 'one'])
  })
  test('Given 非法预算 When 读取 Then 拒绝且不分配任意缓冲', () => {
    expect(() => readJsonlTail(fixture('x\n'), { maxBytes: Infinity })).toThrow()
  })
})

test('Given 跨批UTF8和巨行 When 倒读续扫 Then 不重复读取前缀且只提交完整物理行', async () => {
  // 新批读取接口将续扫状态留在主进程内，不信任来自renderer的半行内容。
  const { readJsonlBatch } = await import('./agent-jsonl-tail-reader')
  const path = fixture('开头\n' + '汉'.repeat(900) + '\n结束\n半行')
  let result = await readJsonlBatch(path, { direction: 'backward', end: Buffer.byteLength('开头\n' + '汉'.repeat(900) + '\n结束\n半行'), maxBytes: 128, maxLineBytes: 64 })
  const lines = [...result.lines]
  let total = result.bytesRead
  while (!result.done) {
    result = await readJsonlBatch(path, { direction: 'backward', end: statSync(path).size, maxBytes: 128, maxLineBytes: 64, continuation: result.continuation })
    lines.push(...result.lines); total += result.bytesRead
  }
  expect(lines.map((line) => line.text)).toEqual(['结束', undefined, '开头'])
  expect(total).toBe(statSync(path).size)
  expect(lines[1]?.offset).toBe(Buffer.byteLength('开头\n'))
  expect(lines[1]?.end).toBe(lines[0]?.offset)
})

for (const direction of ['forward', 'backward'] as const) {
  test(`Given UTF8空行与半行 When ${direction}逐字节和逐行续扫 Then 边界一致且不提交半行`, async () => {
    const { readJsonlBatch } = await import('./agent-jsonl-tail-reader')
    // 小预算刻意切开多字节字符、换行及空行。
    const text = '\n一\n\n末尾\n未完'
    const path = fixture(text)
    for (const limits of [{ maxBytes: 1 }, { maxBytes: 128, maxLines: 1 }]) {
      let batch = await readJsonlBatch(path, { direction, end: Buffer.byteLength(text), ...limits })
      const lines = [...batch.lines]
      for (let step = 0; step < 100 && !batch.done; step++) {
        batch = await readJsonlBatch(path, { direction, end: Buffer.byteLength(text), ...limits, continuation: batch.continuation })
        lines.push(...batch.lines)
      }
      expect(batch.done).toBe(true)
      expect(lines.map((line) => line.text)).toEqual(direction === 'forward' ? ['', '一', '', '末尾'] : ['末尾', '', '一', ''])
      const sorted = lines.toSorted((left, right) => left.offset - right.offset)
      expect(sorted[0]?.offset).toBe(0)
      for (let index = 1; index < sorted.length; index++) expect(sorted[index]?.offset).toBe(sorted[index - 1]?.end)
      expect(sorted.at(-1)?.end).toBe(Buffer.byteLength('\n一\n\n末尾\n'))
    }
  })
}


test('Given 长会话批次读取 When 发起索引扩展 Then 文件读取返回Promise让出主进程事件循环', async () => {
  const { readJsonlBatch } = await import('./agent-jsonl-tail-reader')
  const result = readJsonlBatch(fixture('第一行\n第二行\n'), { direction: 'forward', end: Buffer.byteLength('第一行\n第二行\n') })
  expect(result).toBeInstanceOf(Promise)
  await expect(result).resolves.toMatchObject({ done: true, lines: [{ text: '第一行' }, { text: '第二行' }] })
})
