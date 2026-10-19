import { describe, expect, test } from 'bun:test'
import { deriveWorkContext } from './work-context-atoms'

describe('WorkContext 派生', () => {
  test('当前 Agent 会话优先返回 Agent 路由和项目归属', () => {
    const context = deriveWorkContext({ session: { id: 's1', workspaceId: 'p1' } as never, activeView: 'conversations', surfaceId: 'canvas', modulePolicyRevision: 2, activeModuleIds: ['canvas'] })
    expect(context).toEqual({ projectId: 'p1', sessionId: 's1', runId: null, surfaceId: 'canvas', activeModuleIds: ['canvas'], returnRoute: 'agent', revision: 2 })
  })

  test('无会话的技能页面仍能明确回到模块路由', () => {
    expect(deriveWorkContext({ session: null, activeView: 'agent-skills', surfaceId: null }).returnRoute).toBe('module')
  })
})
