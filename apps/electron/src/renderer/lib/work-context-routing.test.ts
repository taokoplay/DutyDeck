import { describe, expect, test } from 'bun:test'
import { deriveWorkspaceToolTarget } from './work-context-routing'

describe('WorkContext 工具路由', () => {
  test('同一 Agent 会话内打开浏览器进入当前会话面板并保留模块归属', () => {
    expect(deriveWorkspaceToolTarget({ sessionId: 's1', activeView: 'conversations', tool: 'browser', moduleId: 'browser' })).toEqual({
      kind: 'session-panel', sessionId: 's1', surfaceId: 'browser', moduleId: 'browser',
    })
  })

  test('没有会话时动态工具进入独立工作台并给出创建会话动作', () => {
    expect(deriveWorkspaceToolTarget({ sessionId: null, activeView: 'conversations', tool: 'browser' })).toEqual({
      kind: 'standalone-surface', surfaceId: 'browser', nextAction: 'create-session',
    })
  })

  test('视图处于全屏模块时保留返回项目的回程语义', () => {
    expect(deriveWorkspaceToolTarget({ sessionId: null, activeView: 'agent-skills', tool: 'skills' })).toEqual({
      kind: 'standalone-surface', surfaceId: 'skills', nextAction: 'return-to-project',
    })
  })
})

test('Given 无会话或Chat入口 When 打开既有效率工具 Then 进入独立整页而不阻断', () => {
  /** 覆盖所有原有整页入口，业务开关继续由 workspaceToolAvailabilityAtom 校验。 */
  for (const tool of ['todos', 'calendar', 'automations', 'skills', 'mcp', 'memory', 'vault']) {
    expect(deriveWorkspaceToolTarget({ sessionId: null, activeView: 'conversations', tool })).toEqual({
      kind: 'standalone-surface', surfaceId: tool, nextAction: 'return-to-project',
    })
  }
})
