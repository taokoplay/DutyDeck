import { describe, expect, test } from 'bun:test'
import type { AgentSessionMeta } from '@dutydeck/shared'
import { createVisualProductionAgentAccess } from './agent-access'

/** 构造只记录影像模块准入边界的会话夹具。 */
function fixture() {
  const state = {
    session: { id: 'session-1', title: '影像测试', workspaceId: 'project-1', createdAt: 1, updatedAt: 1 } as AgentSessionMeta,
    active: true,
  }
  const options = {
    sessionId: 'session-1', toolMode: 'standard', automation: false,
    getSession: () => state.session,
    assertRunActive: () => { if (!state.active) throw new Error('运行已取消') },
    canWrite: () => true,
    createAccess: (_id: string, dependencies: { assertCaller(): void; canWrite(): boolean }) => ({
      workspaceId: 'project-1', assertCurrent: dependencies.assertCaller,
      execute: async () => { throw new Error('本测试不执行影像命令') },
    }),
  }
  return { state, options }
}

describe('影像创作 Agent 准入', () => {
  test('Given 用户探索分支 When 当前消息显式选择影像创作 Then 获得独立项目能力', () => {
    const { state, options } = fixture()
    state.session = { ...state.session, explorationParentSessionId: 'parent-1' }
    expect(createVisualProductionAgentAccess(options)).not.toBeNull()
  })

  test('Given 自动化、委派或内部来源 When 构建影像能力 Then 拒绝且不扩大父会话权限', () => {
    const { options, state } = fixture()
    for (const triggeredBy of ['automation', 'delegation', 'external']) {
      expect(createVisualProductionAgentAccess({ ...options, triggeredBy })).toBeNull()
    }
    for (const fields of [
      { automationGraduated: true },
      { parentSessionId: 'parent-1' },
      { sourceDesignProjectId: 'project-1' },
      { archived: true },
    ]) {
      state.session = { id: 'session-1', title: '影像测试', workspaceId: 'project-1', createdAt: 1, updatedAt: 1, ...fields }
      expect(createVisualProductionAgentAccess(options)).toBeNull()
    }
  })
})
