import { describe, expect, mock, test } from 'bun:test'

/** 历史消息读取计数，确保 metadata 与未入选页不触发磁盘读取。 */
let messageReads = 0
/** 模拟重启后的持久化会话，保留真实父子归属字段。 */
const sessions = Array.from({ length: 25 }, (_, index) => ({
  id: `child-${index}`, sourceDelegationId: `delegation-${index}`, parentSessionId: 'parent',
  delegationStatus: 'completed', createdAt: index, updatedAt: index, title: `任务${index}`,
}))
mock.module('./agent-session-manager', () => ({
  createAgentSession: () => { throw new Error('本测试不创建会话') },
  getAgentSessionMeta: () => undefined,
  getAgentSessionSDKMessages: () => {
    messageReads++
    return [{ type: 'assistant', message: { content: [{ type: 'text', text: '甲'.repeat(60000) + '尾部' }] } }]
  },
  listAgentSessions: () => sessions,
  updateAgentSessionMeta: () => undefined,
}))
mock.module('./agent-model-selection', () => ({
  assertEnabledModelForChannel: () => undefined,
  listEnabledAgentModelsForChannel: () => [],
}))
/** 只替换 I/O 边界；执行真实工具 schema 和 execute 链路。 */
const { buildPiCollaborationTools } = await import('./agent-collaboration-tools')
interface TestTool {
  /** 工具注册名。 */
  name: string
  /** 工具真实执行入口。 */
  execute: (id: string, params: unknown) => Promise<{ content: Array<{ text: string }> }>
}
const sdk = { defineTool: (definition: unknown) => definition } as unknown as Parameters<typeof buildPiCollaborationTools>[0]
const tools = buildPiCollaborationTools(sdk, { sessionId: 'parent', channelId: 'channel' }) as TestTool[]
/** 调用真实工具并解码返回载荷。 */
async function invoke(name: string, params: unknown) {
  const response = await tools.find((tool) => tool.name.endsWith(name))!.execute('test', params)
  return JSON.parse(response.content[0]!.text) as { delegations: Array<Record<string, unknown>>; nextOffset?: number }
}

describe('协作读取工具集成', () => {
  test('默认 list 只读元数据且按稳定时间倒序分页', async () => {
    messageReads = 0
    const page = await invoke('list_delegations', {})
    expect(page.delegations).toHaveLength(20)
    expect(page.nextOffset).toBe(20)
    expect(page.delegations[0]?.delegationId).toBe('delegation-24')
    expect(messageReads).toBe(0)
  })
  test('preview list 只读取入选页历史', async () => {
    messageReads = 0
    const page = await invoke('list_delegations', { detail: 'preview', limit: 2 })
    expect(page.delegations).toHaveLength(2)
    expect(messageReads).toBe(2)
    expect(JSON.stringify(page).length).toBeLessThanOrEqual(12000)
  })
  test('full 可读取历史50k之后尾部并拒绝不属于当前父会话的结果', async () => {
    const page = await invoke('get_delegation_results', { delegationIds: ['delegation-1'], detail: 'full', resultOffset: 60000 })
    expect(page.delegations[0]?.resultSummary).toBe('尾部')
    sessions[0]!.parentSessionId = 'other-parent'
    await expect(invoke('get_delegation_results', { delegationIds: ['delegation-0'] })).rejects.toThrow('未找到')
    sessions[0]!.parentSessionId = 'parent'
  })
  test('等待已完成历史默认返回预算内preview', async () => {
    const page = await invoke('wait_for_delegations', { delegationIds: ['delegation-1', 'delegation-2'] })
    expect(page.delegations).toHaveLength(2)
    expect(page.delegations[0]?.resultTruncated).toBe(true)
    expect(JSON.stringify(page).length).toBeLessThanOrEqual(12000)
  })
})
