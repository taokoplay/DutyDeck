import * as sync from "./agent-transcript-sync"

import { describe, expect, test } from 'bun:test'
import type { AgentTranscriptEntry, AgentTranscriptPage, SDKMessage } from '@dutydeck/shared'
import { mergeTranscriptPage, acknowledgeTranscriptMessages, bindTranscriptMessages, getTranscriptWindow } from './agent-transcript-sync'
function entry(id: number): AgentTranscriptEntry {
  return { recordId: `m${id}`, offset: id * 100, end: (id + 1) * 100, turn: id,
    message: { type: 'assistant', uuid: `m${id}`, message: { role: 'assistant', content: [{ type: 'text', text: `${id}` }] } } as SDKMessage }
}
function page(ids: number[], generation = 'g'): AgentTranscriptPage {
  const entries = ids.map(entry)
  return { sessionId: 's', status: 'page', generation, revision: `${generation}:1000`, observedEnd: 1000,
    entries, before: { sessionId: 's', generation, offset: entries[0]?.offset ?? 0 },
    after: { sessionId: 's', generation, offset: entries.at(-1)?.end ?? 0 }, hasBefore: ids[0] !== 0,
    hasAfter: false, startsMidTurn: false, endsMidTurn: false, ioBytes: 0, indexBytes: 0, returnedBytes: 0, turnNumbersRelative: false }
}
describe('版本化展示窗口同步', () => {
  test('Given 连续尾部增量 When 合并 Then 保留旧对象、稳定身份与有界尾窗', () => {
    const first = page([0, 1, 2])
    const next = mergeTranscriptPage(first, page([3, 4]), 'after', 4)
    expect(next.entries.map((e) => e.recordId)).toEqual(['m1', 'm2', 'm3', 'm4'])
    expect(next.entries[0]).toBe(first.entries[1])
    expect(next.hasBefore).toBe(true)
  })
  test('Given 断开的阅读窗口、跨会话或generation When 合并 Then 不拼成伪连续历史', () => {
    expect(mergeTranscriptPage(page([0]), page([9]), 'after').entries.map((e) => e.recordId)).toEqual(['m9'])
    expect(() => mergeTranscriptPage(page([0]), { ...page([1]), sessionId: 'other' }, 'after')).toThrow()
    expect(mergeTranscriptPage(page([0]), page([1], 'new'), 'after').entries.map((e) => e.recordId)).toEqual(['m1'])
  })
  test('Given 停止后的live包含窗口外和新run消息 When 页确认 Then 只删除已持久化且同run的完整消息', () => {
    const old = { ...entry(1).message, _promaLiveRunGeneration: 2 } as SDKMessage
    const outside = entry(99).message
    const current = { ...entry(2).message, _promaLiveRunGeneration: 3 } as SDKMessage
    const partial = { ...entry(3).message, _partial: true } as SDKMessage
    const live = [old, outside, current, partial]
    const kept = acknowledgeTranscriptMessages(live, page([1, 2, 3]), { runGeneration: 2 })
    expect(kept).toEqual([outside, current, partial])
  })
  test('Given 巨条占位 When 确认 Then 不删除仍持有完整内容的live', () => {
    const persisted = page([1]); persisted.entries[0]!.deferred = true
    const live = [entry(1).message]
    expect(acknowledgeTranscriptMessages(live, persisted)).toEqual(live)
  })
  test('Given 缓存数组 When 绑定窗口 Then 元数据与数组同生命周期，普通乐观数组无过期游标', () => {
    const window = page([0, 1])
    const messages = bindTranscriptMessages(window)
    expect(getTranscriptWindow(messages)).toBe(window)
    expect(getTranscriptWindow([...messages])).toBeUndefined()
  })
})

describe('完成交接与乐观覆盖层', () => {
  test('Given 800条完成记录且尾页500条 When 精准确认后展示 Then 旧live不倒挂到页尾且DOM仍有界', () => {
    const tail = page(Array.from({ length: 500 }, (_, i) => i + 300))
    const live = Array.from({ length: 800 }, (_, i) => entry(i).message)
    const remaining = acknowledgeTranscriptMessages(live, tail)
    const display = sync.selectTranscriptDisplay(bindTranscriptMessages(tail), remaining, tail)
    expect(display.messages.map(message => (message as {uuid?: string}).uuid)).toEqual(tail.entries.map(item => item.recordId))
    expect(remaining).toHaveLength(300) // 未证实的缓冲正文不能丢弃。
    expect(display.omitted).toBe(300)
  })
  test('Given 乐观插入与撤销 When 继承权威窗口 Then 控制游标仍在但乐观消息不冒充落盘记录', () => {
    const tail = page([1, 2]); const original = bindTranscriptMessages(tail)
    const optimistic = [...original, entry(3).message]
    sync.inheritTranscriptWindow(original, optimistic)
    expect(getTranscriptWindow(optimistic)).toBe(tail)
    expect(tail.entries).toHaveLength(2)
  })
  test('Given 已接受较新尾窗 When 旧请求返回 Then 同代缩小与旧epoch均拒绝', () => {
    const current = { ...page([3]), observedEnd: 400 }
    expect(sync.canAcceptTranscriptPage(current, { ...page([2]), observedEnd: 300 }, 2, 2)).toBe(false)
    expect(sync.canAcceptTranscriptPage(current, page([4], 'old'), 1, 2)).toBe(false)
    expect(sync.canAcceptTranscriptPage(current, { ...page([4]), observedEnd: 500 }, 2, 2)).toBe(true)
  })
})

test('Given 单条实时内容含海量blocks When 投影展示 Then 不挂载巨型消息且完整对象可按需访问', () => {
  const huge = { ...entry(1).message, message: { role: 'assistant', content: Array.from({length:2000}, () => ({type:'text',text:'大记录'})) } } as SDKMessage
  const display = sync.selectTranscriptDisplay([], [huge], page([]))
  expect(((display.messages[0]! as {message: {content: unknown[]}}).message).content.length).toBe(1)
  expect(display.retained).toContain(huge)
  expect((huge as {message: unknown}).message).not.toBe((display.messages[0]! as {message: unknown}).message)
})

test('Given 冷tail相对回合后来与绝对前页合并 When 翻页 Then 既有记录回合号重新对齐且不修改旧页', () => {
  const tail = page([8, 9]); tail.turnNumbersRelative = true
  tail.entries[0]!.turn = 1; tail.entries[1]!.turn = 2
  const earlier = page([6, 7]); earlier.endsMidTurn = false
  const merged = mergeTranscriptPage(tail, earlier, 'before')
  expect(merged.entries.map(entry => entry.turn)).toEqual([6, 7, 8, 9])
  expect(merged.turnNumbersRelative).toBe(false)
  expect(tail.entries[0]!.turn).toBe(1)
})

test('Given 同代窗口中有焦点或选区 When 尾部刷新 Then 固定旧视图；generation变化不保留被删除历史', () => {
  const old = {messages: [entry(1).message], omitted: 0, retained: []}
  const next = {messages: [entry(2).message], omitted: 0, retained: []}
  expect(sync.preserveInteractingTranscript(old, next, true, 's:g', 's:g')).toBe(old)
  expect(sync.preserveInteractingTranscript(old, next, true, 's:g', 's:new')).toBe(next)
  expect(sync.preserveInteractingTranscript(old, next, false, 's:g', 's:g')).toBe(next)
})

test('Given 无页或占位超额 When 展示 Then 始终最多500条和1000 blocks', () => {
  const live = Array.from({length:800}, (_, i) => entry(i).message)
  expect(sync.selectTranscriptDisplay([], live).messages.length).toBeLessThanOrEqual(500)
  const blocks = Array.from({length:500}, (_, i) => ({...entry(i).message, message:{role:'assistant',content:Array.from({length:i<5?200:1},()=>({type:'text',text:'x'}))}} as SDKMessage))
  const display = sync.selectTranscriptDisplay([], blocks, page([]))
  expect(display.messages.reduce((sum,m)=>sum+((m as {message:{content:unknown[]}}).message.content.length),0)).toBeLessThanOrEqual(1000)
})
test('Given deferred无uuid但展示ID相同 When live合并 Then 单一展示而不冒充ACK', () => {
  const p = page([7]); p.entries[0]!.deferred=true; delete (p.entries[0]!.message as {uuid?:string}).uuid
  const display = sync.selectTranscriptDisplay(bindTranscriptMessages(p), [entry(7).message], p)
  expect(display.messages).toHaveLength(1)
})
test('Given 巨条真实用户和工具结果 When 有界投影 Then 保留角色和工具错误关联', () => {
  const user = {type:'user',uuid:'u',message:{role:'user',content:[{type:'text',text:'x'.repeat(150000)}]}} as SDKMessage
  const tool = {type:'user',uuid:'r',parent_tool_use_id:'parent',message:{role:'user',content:[{type:'tool_result',tool_use_id:'call',is_error:true,content:'x'.repeat(150000)}]}} as SDKMessage
  const messages = sync.selectTranscriptDisplay([], [user,tool], page([])).messages as Array<{type:string;parent_tool_use_id?:string;message:{content:Array<{tool_use_id?:string;is_error?:boolean}>}}>
  expect(messages[0]!.type).toBe('user')
  expect(messages[1]!.message.content[0]!.tool_use_id).toBe('call')
  expect(messages[1]!.message.content[0]!.is_error).toBe(true)
  expect(messages[1]!.parent_tool_use_id).toBe('parent')
})

test('Given 500条成对工具页面 When live挤掉调用留下结果 Then 孤立结果加入可查看保留集合', () => {
  const records = Array.from({length:500},(_,i)=>entry(i).message)
  records[0]={type:'assistant',uuid:'call-record',message:{content:[{type:'tool_use',id:'call',name:'Read',input:{}}]}} as SDKMessage
  records[1]={type:'user',uuid:'result-record',message:{content:[{type:'tool_result',tool_use_id:'call',is_error:true,content:'错误证据'}]}} as SDKMessage
  const display=sync.selectTranscriptDisplay(records,[entry(501).message])
  expect(display.retained).toContain(records[1]!)
})

test('Given rewind期间新run已结束 When 清理旧live Then 只删除操作前的对象而保留新run', () => {
  const old=entry(1).message; const current=entry(2).message
  expect(sync.discardTranscriptSnapshot([old,current],new Set([old]))).toEqual([current])
})

/** 带创建时间的记录：模拟真实持久化消息，用于判断页外实时的新旧关系。 */
function timedEntry(id: number, base = 1_700_000_000_000): AgentTranscriptEntry {
  const record = entry(id)
  ;(record.message as { _createdAt?: number })._createdAt = base + id * 1000
  return record
}
/** 带创建时间的尾部页；默认标记为存在更早历史（真实尾页的常态）。 */
function timedPage(ids: number[], generation = 'g', hasBefore = true): AgentTranscriptPage {
  const entries = ids.map((id) => timedEntry(id))
  return {
    ...page(ids, generation),
    entries,
    hasBefore,
    before: { sessionId: 's', generation, offset: entries[0]?.offset ?? 0 },
    after: { sessionId: 's', generation, offset: entries.at(-1)?.end ?? 0 },
  }
}
/** 尾部页已确认的记录回执。 */
function receiptsOf(target: AgentTranscriptPage): Array<{ uuid: string; offset: number }> {
  return target.entries.map((item) => ({ uuid: item.recordId, offset: item.offset }))
}

describe('打开会话时的历史顺序', () => {
  test('Given 尾部页只覆盖最近500条且live含更早页外缓冲 When 精确ACK后展示 Then 早期消息不倒挂到页尾', () => {
    const tail = timedPage(Array.from({ length: 500 }, (_, i) => i + 300))
    const live = Array.from({ length: 800 }, (_, i) => timedEntry(i).message)
    const remaining = sync.acknowledgeTranscriptReceipts(live, receiptsOf(tail), tail)
    const display = sync.selectTranscriptDisplay(bindTranscriptMessages(tail), remaining, tail)
    expect(display.messages.map((message) => (message as { uuid?: string }).uuid))
      .toEqual(Array.from({ length: 500 }, (_, i) => `m${i + 300}`))
    expect(display.omitted).toBe(300)
  })

  test('Given 尾部页覆盖最近记录且live为运行中新消息 When 展示 Then 新消息仍追加在页尾', () => {
    const tail = timedPage(Array.from({ length: 500 }, (_, i) => i))
    const live = Array.from({ length: 50 }, (_, i) => timedEntry(i + 500).message)
    const display = sync.selectTranscriptDisplay(bindTranscriptMessages(tail), live, tail)
    expect((display.messages.at(-1) as { uuid?: string } | undefined)?.uuid).toBe('m549')
  })

  test('Given 两侧都缺创建时间 When 页外live无法判定新旧 Then 保持追加页尾的既有行为', () => {
    const tail = page(Array.from({ length: 500 }, (_, i) => i + 300))
    const live = Array.from({ length: 300 }, (_, i) => entry(i).message)
    const display = sync.selectTranscriptDisplay(bindTranscriptMessages(tail), live, tail)
    expect((display.messages.at(-1) as { uuid?: string } | undefined)?.uuid).toBe('m299')
  })
})

describe('尾部页确认后的页外缓冲清理', () => {
  test('Given 页外属于更早run且尾部页已读到文件尾 When 精确ACK Then 旧run缓冲被丢弃、当前run保留', () => {
    const tail = timedPage([1, 2, 3])
    const superseded = { ...timedEntry(0).message, _promaLiveRunGeneration: 1 } as SDKMessage
    const current = { ...timedEntry(4).message, _promaLiveRunGeneration: 2 } as SDKMessage
    const kept = sync.acknowledgeTranscriptReceipts([superseded, current], receiptsOf(tail), tail, { runGeneration: 2 })
    expect(kept).toEqual([current])
  })

  test('Given 无run标记的旧格式消息或未完成消息 When 精确ACK Then 均不被丢弃', () => {
    const tail = timedPage([1, 2, 3])
    const legacy = timedEntry(9).message
    const partial = { ...timedEntry(10).message, _partial: true, _promaLiveRunGeneration: 1 } as SDKMessage
    const kept = sync.acknowledgeTranscriptReceipts([legacy, partial], receiptsOf(tail), tail, { runGeneration: 2 })
    expect(kept).toEqual([legacy, partial])
  })

  test('Given 页面尚未确认读取到尾部 When 精确ACK Then 不据run标记删除页外缓冲', () => {
    const head = timedPage([1, 2, 3], 'g', false)
    const superseded = { ...timedEntry(0).message, _promaLiveRunGeneration: 1 } as SDKMessage
    const kept = sync.acknowledgeTranscriptReceipts([superseded], receiptsOf(head), head, { runGeneration: 2 })
    expect(kept).toEqual([superseded])
  })
})
