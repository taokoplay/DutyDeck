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

for (const count of [10000, 50000]) {
  test(`Given ${count}条历史 When 跨局部窗口before再after Then 有界无漏项且回合稳定`, async () => {
    // 大样本让连续上翻跨越冷启动的1000条局部索引。
    const path = fixture(count / 2)
    let page = await readTranscriptPage(path, { sessionId: 'bounded', mode: 'tail', maxRecords: 300, maxTurns: 60 }, project)
    const generation = page.generation
    // 保存实际返回的身份与回合，向前跨窗后再逐页向后对照。
    const seen = new Map(page.entries.map((entry) => [entry.recordId, entry.turn]))
    for (let step = 0; step < 12; step++) {
      const newer = page
      page = await readTranscriptPage(path, { sessionId: 'bounded', mode: 'before', cursor: page.before, maxRecords: 300, maxTurns: 60 }, project)
      expect(page.status).toBe('page')
      expect(page.generation).toBe(generation)
      expect(page.indexBytes).toBeLessThanOrEqual(1024 * 1024)
      expect(page.after?.offset).toBe(newer.before?.offset)
      for (const entry of page.entries) {
        expect(seen.has(entry.recordId)).toBe(false)
        seen.set(entry.recordId, entry.turn)
      }
      const back = await readTranscriptPage(path, { sessionId: 'bounded', mode: 'after', cursor: page.after, maxRecords: 300, maxTurns: 60 }, project)
      expect(back.entries.map((entry) => [entry.recordId, entry.turn])).toEqual(newer.entries.map((entry) => [entry.recordId, entry.turn]))
    }
  })
}

test('Given 巨型尾行 When 同代tail有界续扫 Then 自动推进到deferred而不显式rebuild', async () => {
  const path = fixture(1)
  appendFileSync(path, row('giant', 'assistant', 'x'.repeat(5 * 1024 * 1024)))
  let page = await readTranscriptPage(path, { sessionId: 'giant', mode: 'tail', maxBytes: 4096 }, project)
  const generation = page.generation
  expect(page.indexRequired).toBe(true)
  for (let attempt = 0; attempt < 24 && page.indexRequired; attempt++) {
    page = await readTranscriptPage(path, { sessionId: 'giant', mode: 'tail', cursor: page.after, maxBytes: 4096 }, project)
    expect(page.generation).toBe(generation)
    expect(page.indexBytes).toBeGreaterThan(0)
    expect(page.indexBytes).toBeLessThanOrEqual(1024 * 1024)
  }
  expect(page.indexRequired).not.toBe(true)
  expect(page.entries.at(-1)?.deferred).toBe(true)
  expect(page.observedEnd).toBe(statSync(path).size)
})

test('Given 受管追加5MiB When after逐批续扫 Then 不整扫追加且最终接上旧游标', async () => {
  const path = fixture(1)
  const tail = await readTranscriptPage(path, { sessionId: 'append', mode: 'tail' }, project)
  const stamp = transcriptFileStamp(statSync(path))
  appendFileSync(path, row('giant', 'assistant', 'x'.repeat(5 * 1024 * 1024)))
  noteTranscriptAppend(path, stamp)
  let page = await readTranscriptPage(path, { sessionId: 'append', mode: 'after', cursor: tail.after }, project)
  for (let attempt = 0; attempt < 24 && page.indexRequired; attempt++) {
    expect(page.indexBytes).toBeLessThanOrEqual(1024 * 1024)
    page = await readTranscriptPage(path, { sessionId: 'append', mode: 'after', cursor: tail.after }, project)
  }
  expect(page.indexBytes).toBeLessThanOrEqual(1024 * 1024)
  expect(page.generation).toBe(tail.generation)
  expect(page.entries).toHaveLength(1)
  expect(page.entries[0]?.offset).toBe(tail.after?.offset)
})

test('Given 局部窗口跨工具回合 When 多次before至开头再after Then 回合与边界不漂移', async () => {
  const path = fixture(0)
  // 工具结果虽为user类型，但不能建立新用户回合。
  const tool = JSON.stringify({ type: 'user', uuid: 'tool', message: { content: [{ type: 'tool_result', tool_use_id: 'call', content: 'ok' }] } }) + '\n'
  writeFileSync(path, row('start', 'user') + Array.from({ length: 1200 }, (_, index) => row(`a${index}`, 'assistant')).join('') + tool)
  const tail = await readTranscriptPage(path, { sessionId: 'turn', mode: 'tail', maxRecords: 300 }, project)
  let page = tail
  for (let count = 0; count < 10 && page.hasBefore; count++) {
    page = await readTranscriptPage(path, { sessionId: 'turn', mode: 'before', cursor: page.before, maxRecords: 300 }, project)
    expect(page.entries.every((entry) => entry.turn === tail.entries[0]!.turn)).toBe(true)
    expect(page.endsMidTurn).toBe(true)
  }
  expect(page.entries[0]?.recordId).toBe('start')
  expect(page.startsMidTurn).toBe(false)
  const again = await readTranscriptPage(path, { sessionId: 'turn', mode: 'tail', maxRecords: 300 }, project)
  expect(again.entries.map((entry) => [entry.recordId, entry.turn])).toEqual(tail.entries.map((entry) => [entry.recordId, entry.turn]))
  expect(again.turnNumbersRelative).toBe(true)
})

test('Given 巨型中间行 When before有界续扫 Then 跨越后可after返回原尾页', async () => {
  const path = fixture(1)
  appendFileSync(path, row('giant', 'assistant', 'x'.repeat(3 * 1024 * 1024)) + row('last', 'assistant'))
  const tail = await readTranscriptPage(path, { sessionId: 'middle', mode: 'tail', maxRecords: 1 }, project)
  expect(tail.entries[0]?.recordId).toBe('last')
  let before = await readTranscriptPage(path, { sessionId: 'middle', mode: 'before', cursor: tail.before, maxRecords: 1 }, project)
  for (let attempt = 0; attempt < 10 && before.indexRequired; attempt++) {
    expect(before.indexBytes).toBeGreaterThan(0)
    expect(before.indexBytes).toBeLessThanOrEqual(1024 * 1024)
    before = await readTranscriptPage(path, { sessionId: 'middle', mode: 'before', cursor: tail.before, maxRecords: 1 }, project)
  }
  expect(before.entries).toHaveLength(1)
  expect(before.entries[0]?.deferred).toBe(true)
  expect(before.after?.offset).toBe(tail.before?.offset)
  const after = await readTranscriptPage(path, { sessionId: 'middle', mode: 'after', cursor: before.after, maxRecords: 1 }, project)
  expect(after.entries.map((entry) => entry.recordId)).toEqual(['last'])
})

test('Given 正向追加超过一批 When after返回局部页 Then hasAfter不能假报已到最新', async () => {
  const path = fixture(1)
  const tail = await readTranscriptPage(path, { sessionId: 'growing', mode: 'tail' }, project)
  const stamp = transcriptFileStamp(statSync(path))
  appendFileSync(path, Array.from({ length: 2000 }, (_, index) => row(`next${index}`, 'assistant')).join(''))
  noteTranscriptAppend(path, stamp)
  const page = await readTranscriptPage(path, { sessionId: 'growing', mode: 'after', cursor: tail.after, maxRecords: 1000 }, project)
  expect(page.entries).toHaveLength(1000)
  expect(page.hasAfter).toBe(true)
  expect(page.endsMidTurn).toBe(true)
})

test('Given 可解析的巨条工具结果 When tail续扫再around Then UUID和工具回合身份一致', async () => {
  const path = fixture(1)
  appendFileSync(path, JSON.stringify({ type: 'user', uuid: 'large-tool', message: { content: [{ type: 'tool_result', tool_use_id: 'call-large', is_error: true, content: 'x'.repeat(600000) }] } }) + '\n')
  let page = await readTranscriptPage(path, { sessionId: 'identity', mode: 'tail', maxBytes: 4096 }, project)
  for (let attempt = 0; attempt < 4 && page.indexRequired; attempt++) {
    page = await readTranscriptPage(path, { sessionId: 'identity', mode: 'tail', cursor: page.after, maxBytes: 4096 }, project)
  }
  expect(page.entries.at(-1)?.recordId).toBe('large-tool')
  expect(page.entries.at(-1)?.turn).toBe(page.entries[0]?.turn)
  const around = await readTranscriptPage(path, { sessionId: 'identity', mode: 'around', messageId: page.entries.at(-1)!.recordId, maxBytes: 4096 }, project)
  expect(around.status).toBe('page')
  expect(around.entries.at(-1)?.recordId).toBe('large-tool')
  expect((page.entries.at(-1)?.message as { message: { content: Array<{ tool_use_id: string; is_error: boolean }> } }).message.content[0]).toMatchObject({ tool_use_id: 'call-large', is_error: true })
})

test('Given 巨行续扫中外部替换或截短 When 用旧tail游标重试 Then resetRequired且不返回旧页', async () => {
  for (const replacement of ['', row('replacement', 'user')]) {
    const path = fixture(0)
    appendFileSync(path, row('giant', 'assistant', 'x'.repeat(3 * 1024 * 1024)))
    const initial = await readTranscriptPage(path, { sessionId: 'replace', mode: 'tail' }, project)
    expect(initial.indexRequired).toBe(true)
    writeFileSync(path, replacement)
    const reset = await readTranscriptPage(path, { sessionId: 'replace', mode: 'tail', cursor: initial.after }, project)
    expect(reset.status).toBe('resetRequired')
    expect(reset.entries).toEqual([])
    expect(reset.generation).not.toBe(initial.generation)
  }
})

test('Given 冷巨行仍在倒扫 When 受管追加与tail续扫交错 Then 不混接正反向覆盖范围', async () => {
  const path = fixture(1)
  appendFileSync(path, row('giant', 'assistant', 'x'.repeat(3 * 1024 * 1024)))
  let page = await readTranscriptPage(path, { sessionId: 'interleave', mode: 'tail' }, project)
  const stamp = transcriptFileStamp(statSync(path))
  appendFileSync(path, row('last', 'assistant'))
  noteTranscriptAppend(path, stamp)
  for (let attempt = 0; attempt < 12 && page.indexRequired; attempt++) {
    page = await readTranscriptPage(path, { sessionId: 'interleave', mode: 'tail', cursor: page.after }, project)
    expect(page.indexBytes).toBeLessThanOrEqual(1024 * 1024)
  }
  expect(page.indexRequired).not.toBe(true)
  expect(page.entries.map((entry) => entry.recordId)).toEqual(['u0', 'a0', 'giant', 'last'])
  const earlier = await readTranscriptPage(path, { sessionId: 'interleave', mode: 'before', cursor: page.before }, project)
  expect(earlier.entries).toEqual([])
})
