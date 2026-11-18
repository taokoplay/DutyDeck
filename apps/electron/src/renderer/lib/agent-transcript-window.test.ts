import { describe, expect, test } from 'bun:test'
import { createMountedTranscriptRegistry, readTranscriptPageOnce, readAdjacentTranscript } from './agent-transcript-window'
import type { AgentTranscriptPage, AgentTranscriptPageRequest } from '@dutydeck/shared'
describe('历史窗口所有权', () => {
  test('Given 同一会话两个Pane When 一个卸载 Then 仍算挂载，最后卸载才回收', () => {
    const registry = createMountedTranscriptRegistry()
    const first = registry.mount('A'); const second = registry.mount('A')
    first(); first()
    expect(registry.has('A')).toBe(true)
    expect(registry.has('B')).toBe(false)
    second()
    expect(registry.has('A')).toBe(false)
  })
  test('Given 相同版本和预算的并发读 When 发起请求 Then 去重且settled后再次校准', async () => {
    let calls = 0
    const read = async (_input: AgentTranscriptPageRequest): Promise<AgentTranscriptPage> => { calls++; await Promise.resolve(); return { entries: [] } as unknown as AgentTranscriptPage }
    const input: AgentTranscriptPageRequest = { sessionId: 'A', mode: 'tail' }
    await Promise.all([readTranscriptPageOnce(input, read), readTranscriptPageOnce(input, read)])
    expect(calls).toBe(1)
    await readTranscriptPageOnce(input, read)
    expect(calls).toBe(2)
  })
})

test('Given 巨条需要多批索引 When 读相邻历史 Then 保留方向游标且中途换会话不再读下一批', async () => {
  const cursor = { generation: 'g', sessionId: 'A', offset: 32 }
  const input: AgentTranscriptPageRequest = { sessionId: 'A', mode: 'before', cursor }
  const pending = { generation: 'g', status: 'page', indexRequired: true, indexBytes: 1024, after: cursor } as AgentTranscriptPage
  const finished = { ...pending, indexRequired: false }
  const calls: AgentTranscriptPageRequest[] = []
  expect(await readAdjacentTranscript(input, async (request) => {
    calls.push(request); return calls.length < 3 ? pending : finished
  }, () => true)).toBe(finished)
  expect(calls).toEqual([input, input, input])
  let active = true
  let count = 0
  await expect(readAdjacentTranscript(input, async () => {
    count++; active = false; return pending
  }, () => active)).rejects.toThrow('取消')
  expect(count).toBe(1)
})

test('Given 旧请求未返回但历史已截断 When 新revision读取 Then 不复用旧Promise', async () => {
  let calls = 0
  const read = async (_input: AgentTranscriptPageRequest): Promise<AgentTranscriptPage> => { calls++; await Promise.resolve(); return { entries: [] } as unknown as AgentTranscriptPage }
  const input: AgentTranscriptPageRequest = {sessionId: 's', mode: 'tail'}
  await Promise.all([readTranscriptPageOnce(input, read, 'old'), readTranscriptPageOnce(input, read, 'new')])
  expect(calls).toBe(2)
})

test('Given 尾部巨条跨批 When 未能取得同代游标或没有读取字节 Then 停止而不重复请求', async () => {
  /** 只报告读取量却不提供同一会话的权威游标，不能据此开启下一次尾扫。 */
  for (const partial of [{}, { after: { sessionId: 'B', generation: 'g', offset: 64 } },
    { after: { sessionId: 'A', generation: 'old', offset: 64 } }, { indexBytes: 0 }]) {
    let calls = 0
    await expect(readAdjacentTranscript({ sessionId: 'A', mode: 'tail' }, async () => {
      calls++
      if (calls > 1) throw new Error('重复请求')
      return { generation: 'g', indexRequired: true, indexBytes: 64, ...partial } as AgentTranscriptPage
    }, () => true)).rejects.toThrow(/没有进展|游标/)
    expect(calls).toBe(1)
  }
})
