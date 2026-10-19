import { describe, expect, test } from 'bun:test'
import type { PiAgentQueryOptions } from './adapters/pi-agent-adapter'
import { createRecoveryContextDigest, getRecoverySessionContext, isExactRecoveryEligible, requireRecoveryContextDigest } from './agent-recovery-context'

/** 只构造真实查询合同，不启动网络、工具或模型。 */
function queryFixture(): PiAgentQueryOptions {
  return { sessionId: 's1', prompt: '任务', model: 'm1', provider: 'openai', apiKey: 'fixture-key',
    cwd: '/private/tmp', baseUrl: 'https://fixture.invalid/v1', permissionMode: 'plan', systemPrompt: '含当前时间的动态文本',
    piAgentDir: '/private/tmp/fixture-agent', piSessionDir: '/private/tmp/fixture-sessions',
    activeToolNames: ['read', 'write'], additionalDirectories: ['/private/tmp/a'],
    projectInstructionFiles: [{ path: '/private/tmp/AGENTS.md', content: '项目约束 A' }] }
}

/** 以生产摘要函数比较每个真实安全字段，避免仅断言源码接线。 */
function digest(query: PiAgentQueryOptions, prompts: string[] = ['模块提示 A']): string {
  return createRecoveryContextDigest({ query, hostVersion: '0.20.5', modulePrompts: prompts, extensions: {} })
}

describe('精确恢复运行上下文', () => {
  test('Given 相同 ID When 渠道地址、权限、目录、工具或项目指令变化 Then 摘要变化并可在发模型前阻断', () => {
    const original = queryFixture()
    const expected = digest(original)
    const changes: Partial<PiAgentQueryOptions>[] = [
      { baseUrl: 'https://changed.invalid/v1' }, { provider: 'anthropic' }, { permissionMode: 'bypassPermissions' },
      { cwd: '/private/tmp/other' }, { additionalDirectories: ['/private/tmp/b'] }, { activeToolNames: ['read'] },
      { projectInstructionFiles: [{ path: '/private/tmp/AGENTS.md', content: '项目约束 B' }] },
    ]
    for (const change of changes) expect(digest({ ...original, ...change })).not.toBe(expected)
    expect(digest(original, ['模块提示 B'])).not.toBe(expected)
    expect(expected).toMatch(/^[a-f0-9]{64}$/)
  })

  test('Given 纯用户正文和动态时间改变 When 检查 Then 不把恢复误判为新的授权合同', () => {
    const original = queryFixture()
    expect(digest({ ...original, prompt: '', systemPrompt: '另一个当前时间', activeToolNames: ['write', 'read'] })).toBe(digest(original))
  })

  test('Given plan 或自动会话 When 重建有效配置 Then 保留原权限且内部受限运行不被公共恢复接管', () => {
    expect(getRecoverySessionContext({ channelId: 'c1', permissionMode: 'plan' }).permissionMode).toBe('plan')
    expect(getRecoverySessionContext({ channelId: 'c1', permissionMode: 'bypassPermissions' }).permissionMode).toBe('bypassPermissions')
    expect(isExactRecoveryEligible(undefined, {})).toBe(true)
    expect(isExactRecoveryEligible('user', { allowedToolNames: ['read'] })).toBe(false)
    expect(isExactRecoveryEligible('user', { skillsMode: 'disabled' })).toBe(false)
    expect(isExactRecoveryEligible('automation', {})).toBe(false)
    expect(() => requireRecoveryContextDigest([])).toThrow('AGENT_RUN_RECOVERY_CONTEXT_CHANGED')
  })
})

/** 同一真实知识工具工厂在恢复原用户身份后应产生相同合同，且不调用任何写方法。 */
test('Given 普通项目和已核验用户身份 When 重建知识工具 Then 工具集合及摘要与原运行一致', async () => {
  const { createProjectKnowledgeAgent } = await import('./project-knowledge-agent')
  const { buildProjectKnowledgeTools } = await import('./project-knowledge-tools')
  const { requireRecoveryUserMessageUuid } = await import('./agent-recovery-context')
  const events: import('@dutydeck/shared').AgentRunJournalEvent[] = [{ runId: 'r1', branchId: 'pi1', sequence: 1,
    eventId: 'e1', eventType: 'user_turn', createdAt: 1, payload: { userMessageUuid: 'user1' } }]
  const restoredUuid = requireRecoveryUserMessageUuid(events, { user1: 'pi-entry1' })
  let writes = 0
  /** 公共业务 facade 与工具注册均使用生产实现，仅底层服务为未调用的夹具。 */
  const toolsFor = (uuid: string | undefined) => {
    const knowledge = createProjectKnowledgeAgent({
      sessionId: 's1', toolMode: 'standard', getSession: () => ({ id: 's1', title: '项目', workspaceId: 'w1', createdAt: 1, updatedAt: 1 }),
      getBinding: () => 'project-root', assertRunActive: () => undefined,
      service: { getSnapshot: async () => { throw new Error('不读取项目') }, search: async () => { throw new Error('不检索') }, read: async () => { throw new Error('不读取') } },
      ...(uuid ? { maintenance: { next: async () => ({ refs: [], remaining: 0 }), observeRead: () => undefined,
        submit: async () => { writes += 1; return { status: 'unchanged' as const, published: 0, refreshed: 0, skipped: 0, processedSources: 0, entryIds: [] } } } } : {}),
    })!
    return buildProjectKnowledgeTools({ defineTool: (tool: import('@earendil-works/pi-coding-agent').ToolDefinition) => tool } as unknown as Parameters<typeof buildProjectKnowledgeTools>[0], knowledge)
  }
  const original = toolsFor('user1')
  const restored = toolsFor(restoredUuid)
  expect(restored.map((tool) => tool.name)).toEqual(original.map((tool) => tool.name))
  expect(restored.some((tool) => tool.name === 'proma_knowledge_submit')).toBe(true)
  expect(digest({ ...queryFixture(), customTools: restored })).toBe(digest({ ...queryFixture(), customTools: original }))
  expect(digest({ ...queryFixture(), customTools: toolsFor(undefined) })).not.toBe(digest({ ...queryFixture(), customTools: original }))
  expect(() => requireRecoveryUserMessageUuid(events, {})).toThrow('AGENT_RUN_RECOVERY_CONTEXT_CHANGED')
  expect(writes).toBe(0)
})
