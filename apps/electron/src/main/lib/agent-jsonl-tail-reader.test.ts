import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
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
