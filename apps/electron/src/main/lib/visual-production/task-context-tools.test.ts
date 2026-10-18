import { describe, expect, test } from 'bun:test'
import { buildVisualTaskContextTools } from './task-context-tools'
import type { VisualTaskContextRuntime } from './task-context'

/** 只记录入口调用，工具 schema 与权限测试不调用真实文件服务。 */
function fixture() {
  const writes: boolean[] = []
  const calls: unknown[] = []
  const runtime = { async open(input: unknown) { calls.push(input); return { content: [], details: {} } }, async record(input: unknown) { calls.push(input); return { content: [], details: {} } } } as unknown as VisualTaskContextRuntime
  const tools = buildVisualTaskContextTools({ runtime, sdk: { defineTool: (definition: unknown) => definition } as Parameters<typeof buildVisualTaskContextTools>[0]['sdk'], assertAccess(write) { writes.push(write) } })
  return { tools, calls, writes }
}
describe('视觉工具宿主入口', () => {
  test('Given显式对象 When打开范围 Then保留目标且不请求写权限', async () => {
    const { tools, calls, writes } = fixture()
    const open = tools.find(tool => tool.name === 'visual_production_open_context')!
    const input = { productionId: 'p1', productionRevision: 1, target: { kind: 'shot', shotId: 's1' }, objective: '检查' }
    await open.execute('call', input, undefined, undefined, {} as never)
    expect(calls).toEqual([input]); expect(writes).toEqual([false])
    await expect(open.execute('bad', { ...input, projectRoot: '/tmp' }, undefined, undefined, {} as never)).rejects.toThrow('INVALID_INPUT')
  })
  test('Given结论写入 When提交 Then必须检查写权限并拒绝空证据', async () => {
    const { tools, writes } = fixture()
    const record = tools.find(tool => tool.name === 'visual_production_record_observation')!
    await record.execute('call', { contextId: 'scope', evidenceIds: ['e1'], objective: '检查', conclusion: '有差异', unchecked: [] }, undefined, undefined, {} as never)
    expect(writes).toEqual([true])
    await expect(record.execute('bad', { contextId: 'scope', evidenceIds: [], objective: '检查', conclusion: '有差异', unchecked: [] }, undefined, undefined, {} as never)).rejects.toThrow('INVALID_INPUT')
  })
})
