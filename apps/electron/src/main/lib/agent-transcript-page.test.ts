import { afterEach, describe, expect, test } from 'bun:test'
import { appendFileSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { SDKMessage } from '@dutydeck/shared'
import { readTranscriptPage } from './agent-transcript-page'
import { noteTranscriptAppend, transcriptFileStamp } from './agent-transcript-index'
const dirs: string[] = []
const project = (value: unknown): SDKMessage => value as SDKMessage
function fixture(turns = 100): string {
  const dir = mkdtempSync(join(tmpdir(), 'dutydeck-history-page-')); dirs.push(dir)
  const path = join(dir, 'history.jsonl')
  writeFileSync(path, Array.from({ length: turns }, (_, i) => row(`u${i}`, 'user') + row(`a${i}`, 'assistant')).join(''))
  return path
}
function row(uuid: string, type: string, text = uuid): string {
  return JSON.stringify({ type, uuid, message: { content: [{ type: 'text', text }] } }) + '\n'
}
afterEach(() => dirs.splice(0).forEach((dir) => rmSync(dir, { recursive: true, force: true })))
describe('展示历史窗口协议', () => {
  test('Given 空行夹在两条记录之间 When before再after Then 自己返回的游标保持有效', async () => {
    const path = fixture(0)
    writeFileSync(path, '\n' + row('u', 'user') + '\n\n' + row('a', 'assistant') + '\n')
    const tail = await readTranscriptPage(path, { sessionId: 'A', mode: 'tail', maxRecords: 1 }, project)
    let current = tail
    for (let count = 0; count < 5 && current.hasBefore; count++) {
      current = await readTranscriptPage(path, { sessionId: 'A', mode: 'before', cursor: current.before, maxRecords: 1 }, project)
      const next = await readTranscriptPage(path, { sessionId: 'A', mode: 'after', cursor: current.after, maxRecords: 1 }, project)
      expect(next.status).not.toBe('resetRequired')
    }
  })
  test('Given 新会话尚无JSONL When 读尾页 Then 返回空页且不创建文件', async () => {
    const path = fixture(0) + '.missing'
    const page = await readTranscriptPage(path, { sessionId: 'A', mode: 'tail' }, project)
    expect(page.entries).toEqual([])
    expect(page.observedEnd).toBe(0)
    expect(page.hasBefore).toBe(false)
  })
  test('Given around前文投影膨胀 When 定位 Then 目标在页内且实际IO仍受预算限制', async () => {
    const path = fixture(0)
    writeFileSync(path, row('u', 'user', 'x'.repeat(1300)) + row('a', 'assistant', 'x'.repeat(1300)) + row('target', 'assistant', 'x'.repeat(1300)))
    const page = await readTranscriptPage(path, { sessionId: 'A', mode: 'around', messageId: 'target', maxBytes: 4096 }, (value) => {
      const message = value as SDKMessage & { uuid?: string }
      return (message.uuid === 'target' ? message : JSON.parse(row(message.uuid ?? '', 'assistant', 'x'.repeat(2400)))) as SDKMessage
    })
    expect(page.entries.some((entry) => entry.recordId === 'target')).toBe(true)
    expect(page.ioBytes).toBeLessThanOrEqual(4096)
    expect(page.returnedBytes).toBeLessThanOrEqual(4096)
  })
  test('Given around仅一条预算或前文太大 When 定位 Then 页内必须包含目标', async () => {
    const path = fixture(0)
    writeFileSync(path, row('u', 'user', 'x'.repeat(1700)) + row('a', 'assistant', 'x'.repeat(1700)) + row('target', 'assistant'))
    for (const limits of [{ maxRecords: 1 }, { maxBytes: 4096 }]) {
      const page = await readTranscriptPage(path, { sessionId: 'A', mode: 'around', messageId: 'target', ...limits }, project)
      expect(page.entries.some((entry) => entry.recordId === 'target')).toBe(true)
    }
  })

  test('Given 100回合 When 读尾页和前页 Then 每页仅10个完整回合且不重复', async () => {
    const path = fixture()
    const tail = await readTranscriptPage(path, { sessionId: 'A', mode: 'tail', maxTurns: 10 }, project)
    expect(tail.entries).toHaveLength(20)
    expect(tail.entries[0]?.recordId).toBe('u90')
    expect(tail.hasBefore).toBe(true)
    const before = await readTranscriptPage(path, { sessionId: 'A', mode: 'before', cursor: tail.before, maxTurns: 10 }, project)
    expect(before.entries[0]?.recordId).toBe('u80')
    expect(before.entries.at(-1)?.recordId).toBe('a89')
  })
  test('Given 热尾页 When 无变化与受管追加 Then unchanged或仅新增记录', async () => {
    const path = fixture(2)
    const tail = await readTranscriptPage(path, { sessionId: 'A', mode: 'tail' }, project)
    const unchanged = await readTranscriptPage(path, { sessionId: 'A', mode: 'after', cursor: tail.after }, project)
    expect(unchanged.status).toBe('unchanged')
    expect(unchanged.ioBytes).toBe(0)
    const stamp = transcriptFileStamp(statSync(path)); appendFileSync(path, row('u2', 'user')); noteTranscriptAppend(path, stamp)
    const added = await readTranscriptPage(path, { sessionId: 'A', mode: 'after', cursor: tail.after }, project)
    expect(added.entries.map((e) => e.recordId)).toEqual(['u2'])
  })
  test('Given 重写或跨session游标 When 翻页 Then reset或拒绝，不泄露另一会话', async () => {
    const path = fixture(1)
    const tail = await readTranscriptPage(path, { sessionId: 'A', mode: 'tail' }, project)
    await expect(readTranscriptPage(path, { sessionId: 'B', mode: 'before', cursor: tail.before }, project)).rejects.toThrow()
    writeFileSync(path, row('xx', 'user') + row('yy', 'assistant'))
    const reset = await readTranscriptPage(path, { sessionId: 'A', mode: 'after', cursor: tail.after }, project)
    expect(reset.status).toBe('resetRequired')
    expect(reset.entries).toEqual([])
  })
  test('Given 历史中间的消息 When around Then 包含所属用户回合而不是从末尾逐页加载', async () => {
    const page = await readTranscriptPage(fixture(), { sessionId: 'A', mode: 'around', messageId: 'a10', maxTurns: 2 }, project)
    expect(page.entries.some((e) => e.recordId === 'u10')).toBe(true)
    expect(page.entries.some((e) => e.recordId === 'a10')).toBe(true)
  })
  test('Given 超长单条和单回合 When 小字节预算 Then 返回显式deferred且不突破预算', async () => {
    const path = fixture(1)
    appendFileSync(path, row('large', 'assistant', '汉'.repeat(300000)))
    const initial = await readTranscriptPage(path, { sessionId: 'A', mode: 'tail', maxBytes: 4096 }, project)
    expect(initial.indexRequired).toBe(true)
    expect(initial.indexBytes).toBeLessThanOrEqual(1024 * 1024)
    const page = await readTranscriptPage(path, { sessionId: 'A', mode: 'rebuild', maxBytes: 4096 }, project)
    expect(page.returnedBytes).toBeLessThanOrEqual(4096)
    expect(page.ioBytes).toBeLessThanOrEqual(4096)
    expect(page.entries.at(-1)?.deferred).toBe(true)
  })
})

test('Given 巨条用户输入与工具结果 When 显式索引后读小页 Then 占位保留边界和错误身份', async () => {
  const path = fixture(0)
  writeFileSync(path, row('u', 'user', 'x'.repeat(300000)) + JSON.stringify({type:'user',uuid:'r',message:{content:[{type:'tool_result',tool_use_id:'call',is_error:true,content:'x'.repeat(300000)}]}})+'\n')
  const page = await readTranscriptPage(path, {sessionId:'s',mode:'rebuild',maxBytes:4096}, project)
  expect(page.entries.map(entry=>entry.message.type)).toEqual(['user','user'])
  expect((page.entries[1]!.message as {message:{content:Array<{tool_use_id:string;is_error:boolean}>}}).message.content[0]).toMatchObject({tool_use_id:'call',is_error:true})
})

test('Given 关联ID很多的巨条 When 最小分页预算 Then 仍返回可查看的显式占位而不陷入空页', async () => {
  const path = fixture(0)
  writeFileSync(path,JSON.stringify({type:'user',uuid:'many',message:{content:Array.from({length:16},(_,i)=>({type:'tool_result',tool_use_id:`call-${i}-${'x'.repeat(180)}`,content:'x'.repeat(1000),is_error:true}))}})+'\n')
  const page=await readTranscriptPage(path,{sessionId:'s',mode:'rebuild',maxBytes:4096},project)
  expect(page.entries).toHaveLength(1)
  expect(page.entries[0]?.deferred).toBe(true)
  expect(page.returnedBytes).toBeLessThanOrEqual(4096)
})
