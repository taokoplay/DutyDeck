import { describe, expect, test } from 'bun:test'
import { createMountedTranscriptRegistry, readTranscriptPageOnce } from './agent-transcript-window'
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

test('Given 旧请求未返回但历史已截断 When 新revision读取 Then 不复用旧Promise', async () => {
  let calls = 0
  const read = async (_input: AgentTranscriptPageRequest): Promise<AgentTranscriptPage> => { calls++; await Promise.resolve(); return { entries: [] } as unknown as AgentTranscriptPage }
  const input: AgentTranscriptPageRequest = {sessionId: 's', mode: 'tail'}
  await Promise.all([readTranscriptPageOnce(input, read, 'old'), readTranscriptPageOnce(input, read, 'new')])
  expect(calls).toBe(2)
})
