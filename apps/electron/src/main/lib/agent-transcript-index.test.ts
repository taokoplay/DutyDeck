import { afterEach, describe, expect, test } from 'bun:test'
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { getTranscriptIndex, noteTranscriptAppend, transcriptFileStamp } from './agent-transcript-index'
const dirs: string[] = []
function fixture(): string {
  const dir = mkdtempSync(join(tmpdir(), 'dutydeck-transcript-index-')); dirs.push(dir)
  const path = join(dir, 'session.jsonl')
  writeFileSync(path, line('one', 'user') + line('two', 'assistant'))
  return path
}
function line(id: string, type: string): string { return JSON.stringify({ type, uuid: id, message: { content: [{ type: 'text', text: id }] } }) + '\n' }
afterEach(() => { dirs.splice(0).forEach((dir) => rmSync(dir, { recursive: true, force: true })) })
describe('可重建历史索引', () => {
  test('Given sidecar伪造但偏移与stamp自洽 When 恢复 Then 不能信任ID和回合', async () => {
    const path = fixture(); const stat = statSync(path); const boundary = Buffer.byteLength(line('one', 'user'))
    const dir = `${path}.display-index`; mkdirSync(dir)
    writeFileSync(join(dir, '0.json'), JSON.stringify([
      { offset: 0, end: boundary, id: 'two', turn: 1, turnStart: true },
      { offset: boundary, end: stat.size, id: 'one', turn: 1, turnStart: false },
    ]))
    writeFileSync(join(dir, 'manifest.json'), JSON.stringify({ version: 1, generation: '12345678-1234-1234-1234-123456789abc',
      stamp: transcriptFileStamp(stat), size: stat.size, observedEnd: stat.size, count: 2 }))
    const index = await getTranscriptIndex(path)
    expect(index.records.map((record) => record.id)).toEqual(['one', 'two'])
  })
  test('Given 12MiB尾条 When 请求首屏尾索引 Then 不隐式扫描完整正文', async () => {
    const path = fixture()
    appendFileSync(path, JSON.stringify({ type: 'assistant', message: { content: 'x'.repeat(12 * 1024 * 1024) } }) + '\n')
    const index = await getTranscriptIndex(path, true)
    expect(index.scannedBytes).toBeLessThanOrEqual(1024 * 1024)
    expect(index.complete).toBe(false)
  })
  test('Given sidecar预置tmp及bak符号链接 When 建索引 Then 权威JSONL与哨兵内容不变', async () => {
    const path = fixture(); const original = readFileSync(path, 'utf8')
    const dir = `${path}.display-index`; mkdirSync(dir)
    const sentinel = join(dir, 'sentinel'); writeFileSync(sentinel, 'preserve')
    symlinkSync(path, join(dir, '0.json.tmp'))
    symlinkSync(sentinel, join(dir, '0.json.bak'))
    await getTranscriptIndex(path)
    expect(readFileSync(path, 'utf8')).toBe(original)
    expect(readFileSync(sentinel, 'utf8')).toBe('preserve')
  })

  test('Given sidecar假称非空历史已覆盖但无records When 读取 Then 丢弃索引并重建', async () => {
    const path = fixture(); const stat = statSync(path)
    const dir = `${path}.display-index`; mkdirSync(dir)
    writeFileSync(join(dir, 'manifest.json'), JSON.stringify({ version: 1, generation: '12345678-1234-1234-1234-123456789abc',
      stamp: transcriptFileStamp(stat), size: stat.size, observedEnd: stat.size, count: 0 }))
    const result = await getTranscriptIndex(path)
    expect(result.records.map((r) => r.id)).toEqual(['one', 'two'])
  })

  test('Given 大历史无索引 When 只请求尾页 Then 首屏扫描有界，后续完整索引沿用generation', async () => {
    const path = fixture()
    appendFileSync(path, Array.from({ length: 20000 }, (_, i) => line(`r${i}`, i % 2 === 0 ? 'user' : 'assistant')).join(''))
    const tail = await getTranscriptIndex(path, true)
    expect(tail.scannedBytes).toBeLessThanOrEqual(1024 * 1024)
    expect(tail.complete).toBe(false)
    expect(tail.coverageStart).toBeGreaterThan(0)
    const full = await getTranscriptIndex(path)
    expect(full.complete).toBe(true)
    expect(full.generation).toBe(tail.generation)
    expect(full.records).toHaveLength(20002)
  })

  test('Given 原始JSONL When 首次与重复读取 Then 记录物理身份且热读不重新扫描', async () => {
    const path = fixture()
    const first = await getTranscriptIndex(path)
    expect(first.records.map((r) => r.id)).toEqual(['one', 'two'])
    expect(first.observedEnd).toBe(statSync(path).size)
    const next = await getTranscriptIndex(path)
    expect(next.generation).toBe(first.generation)
    expect(next.scannedBytes).toBe(0)
  })
  test('Given 受管连续追加 When 索引校准 Then 只扫描新增尾部并保持generation', async () => {
    const path = fixture(); const first = await getTranscriptIndex(path)
    const stamp = transcriptFileStamp(statSync(path)); const added = line('new', 'user')
    appendFileSync(path, added); noteTranscriptAppend(path, stamp)
    const next = await getTranscriptIndex(path)
    expect(next.generation).toBe(first.generation)
    expect(next.records.map((r) => r.id)).toEqual(['one', 'two', 'new'])
    expect(next.scannedBytes).toBe(Buffer.byteLength(added))
  })
  test('Given 同长度非受管重写 When 再读 Then 换代且不返回旧ID', async () => {
    const path = fixture(); const first = await getTranscriptIndex(path)
    writeFileSync(path, line('xxx', 'user') + line('yyy', 'assistant'))
    const next = await getTranscriptIndex(path)
    expect(next.generation).not.toBe(first.generation)
    expect(next.records.map((r) => r.id)).toEqual(['xxx', 'yyy'])
  })
  test('Given 无UUID、超长行及未完成尾部 When 建索引 Then 身份稳定且半行不提交', async () => {
    const path = fixture()
    appendFileSync(path, JSON.stringify({ type: 'assistant', message: { content: 'x'.repeat(300000) } }) + '\n{"type":')
    const first = await getTranscriptIndex(path)
    expect(first.records).toHaveLength(3)
    expect(first.records[2]?.id).toContain('@')
    expect(first.observedEnd).toBeLessThan(statSync(path).size)
  })
})

test('Given 已缓存尾页后外部写入巨型尾条 When 再取tail Then 换代仍保持首屏扫描预算', async () => {
  const path = fixture()
  const first = await getTranscriptIndex(path, true)
  appendFileSync(path, JSON.stringify({ type: 'assistant', message: { content: 'x'.repeat(12 * 1024 * 1024) } }) + '\n')
  const next = await getTranscriptIndex(path, true)
  expect(next.generation).not.toBe(first.generation)
  expect(next.scannedBytes).toBeLessThanOrEqual(1024 * 1024)
})

test('Given 持有旧索引快照 When 受管追加构建新索引 Then 旧记录数组与observedEnd保持一致', async () => {
  const path = fixture(); const previous = await getTranscriptIndex(path)
  const stamp = transcriptFileStamp(statSync(path)); appendFileSync(path, line('three','assistant')); noteTranscriptAppend(path, stamp)
  await getTranscriptIndex(path)
  expect(previous.records).toHaveLength(2)
  expect(previous.records.at(-1)?.end).toBe(previous.observedEnd)
})
