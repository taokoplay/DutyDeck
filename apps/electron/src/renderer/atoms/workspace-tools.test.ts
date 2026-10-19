import { describe, expect, test } from 'bun:test'
import { createStore } from 'jotai/vanilla'
import {
  WORKSPACE_TOOLS_EXPANDED_WIDTH,
  WORKSPACE_TOOLS_COLLAPSED_WIDTH,
  type WorkspaceToolId,
  consumeWorkspaceToolRequestAtom,
  workspaceToolAvailabilityAtom,
  activeWorkspaceToolAtom,
  subscribeWorkspaceToolRequestContext,
  clearWorkspaceToolRequestAtom,
  openWorkspaceToolAtom,
  pendingWorkspaceToolRequestAtom,
  workspaceToolsExpandedAtom,
  workspaceToolsWidthAtom,
} from './workspace-tools'
import { agentDiffPanelTabAtom, agentSidePanelOpenAtomFamily, agentSessionsAtom, agentWorkspacesAtom, currentAgentSessionIdAtom, sanitizeWorkspaceComponentTabs } from './agent-atoms'
import { activeViewAtom, agentSkillsTabAtom } from './active-view'
import { appModeAtom } from './app-mode'
import { automationFormAtom } from './automation-atoms'
import { planningTabAtom } from './planning-atoms'
import { productivityToolsAtom } from './ui-preferences'

describe('工作区工具命令', () => {
  test('Given 有效项目会话 When 从 MCP 打开手机面板 Then 聚焦当前会话并保留可恢复标签', () => {
    /** 导航必须以当前会话的实际项目为准。 */
    const store = createStore()
    store.set(agentWorkspacesAtom, [{ id: 'project-a', name: '项目', slug: 'project-a', createdAt: 1, updatedAt: 1 }])
    store.set(agentSessionsAtom, [{ id: 'session-a', title: '会话', workspaceId: 'project-a', createdAt: 1, updatedAt: 1 }])
    store.set(currentAgentSessionIdAtom, 'session-a')
    store.set(activeViewAtom, 'agent-skills')
    store.set(openWorkspaceToolAtom, 'mobile-mirror')
    expect(store.get(activeViewAtom)).toBe('conversations')
    expect(store.get(agentSidePanelOpenAtomFamily('session-a'))).toBe(true)
    expect(store.get(activeWorkspaceToolAtom)).toBe('mobile-mirror')
    expect(sanitizeWorkspaceComponentTabs(['mobile-mirror', 'unknown'])).toEqual(['mobile-mirror'])
  })

  test('Given 无会话或 Chat 模式 When 尝试打开手机面板 Then 禁用并保持当前视图', () => {
    /** 不能借用 Chat 背后的 Agent 会话启动设备进程。 */
    const store = createStore()
    expect(store.get(workspaceToolAvailabilityAtom)['mobile-mirror']?.disabledReason).toBeDefined()
    store.set(currentAgentSessionIdAtom, 'session-a')
    store.set(agentSidePanelOpenAtomFamily('session-a'), false)
    store.set(appModeAtom, 'chat')
    store.set(openWorkspaceToolAtom, 'mobile-mirror')
    expect(store.get(agentSidePanelOpenAtomFamily('session-a'))).toBe(false)
  })

  test('默认收起并按展开状态提供稳定宽度', () => {
    const store = createStore()
    expect(store.get(workspaceToolsExpandedAtom)).toBe(false)
    expect(store.get(workspaceToolsWidthAtom)).toBe(WORKSPACE_TOOLS_COLLAPSED_WIDTH)
    store.set(workspaceToolsExpandedAtom, true)
    expect(store.get(workspaceToolsWidthAtom)).toBe(WORKSPACE_TOOLS_EXPANDED_WIDTH)
  })

  test('当前会话的动态工具请求只能被消费一次', () => {
    const store = createStore()
    store.set(currentAgentSessionIdAtom, 'session-a')
    store.set(openWorkspaceToolAtom, 'browser' satisfies WorkspaceToolId)

    expect(store.get(pendingWorkspaceToolRequestAtom('session-a'))).toMatchObject({ tool: 'browser' })
    expect(store.set(consumeWorkspaceToolRequestAtom, 'session-a')).toMatchObject({ tool: 'browser' })
    expect(store.get(pendingWorkspaceToolRequestAtom('session-a'))).toBeNull()
  })

  test('切换会话后旧请求不会被新会话消费', () => {
    const store = createStore()
    store.set(currentAgentSessionIdAtom, 'session-a')
    store.set(openWorkspaceToolAtom, 'terminal')
    expect(store.get(pendingWorkspaceToolRequestAtom('session-b'))).toBeNull()
    store.set(consumeWorkspaceToolRequestAtom, 'session-b')
    expect(store.get(pendingWorkspaceToolRequestAtom('session-a'))).toMatchObject({ tool: 'terminal' })
  })

  test('新导航或会话切换可清掉未交付请求', () => {
    const store = createStore()
    store.set(currentAgentSessionIdAtom, 'session-a')
    store.set(openWorkspaceToolAtom, 'terminal')
    store.set(clearWorkspaceToolRequestAtom)
    expect(store.get(pendingWorkspaceToolRequestAtom('session-a'))).toBeNull()
  })

  test('无 Agent 会话时组件入口降级到对应全屏视图', () => {
    const store = createStore()
    store.set(openWorkspaceToolAtom, 'calendar')
    expect(store.get(activeViewAtom)).toBe('planning')
    expect(store.get(planningTabAtom)).toBe('calendar')

    store.set(openWorkspaceToolAtom, 'skills')
    expect(store.get(activeViewAtom)).toBe('agent-skills')
    expect(store.get(agentSkillsTabAtom)).toBe('skills')
  })

  test('禁用的生产力工具不会改变当前视图', () => {
    const store = createStore()
    store.set(productivityToolsAtom, (previous) => ({ ...previous, todosEnabled: false }))
    store.set(activeViewAtom, 'conversations')
    store.set(openWorkspaceToolAtom, 'todos')
    expect(store.get(activeViewAtom)).toBe('conversations')
  })

  test('Chat 模式隐藏技能中心入口并保持当前视图', () => {
    const store = createStore()
    store.set(currentAgentSessionIdAtom, 'session-a')
    store.set(appModeAtom, 'chat')
    store.set(openWorkspaceToolAtom, 'memory')
    expect(store.get(activeViewAtom)).toBe('conversations')
  })
  test('Given Chat 保留后台 Agent 会话 When 打开日程 Then 打开整页且不能新建后台终端', () => {
    const store = createStore()
    store.set(currentAgentSessionIdAtom, 'session-a')
    store.set(appModeAtom, 'chat')
    store.set(openWorkspaceToolAtom, 'calendar')
    expect(store.get(activeViewAtom)).toBe('planning')
    expect(store.get(planningTabAtom)).toBe('calendar')
    expect(store.get(workspaceToolAvailabilityAtom).terminal.disabledReason).toBeDefined()
    expect(store.get(workspaceToolAvailabilityAtom).skills.visible).toBe(false)
  })

  test('Given 整页或自动任务表单 When 点击资源入口 Then 会话面板挂载并保留待处理请求', () => {
    const store = createStore()
    store.set(currentAgentSessionIdAtom, 'session-a')
    store.set(activeViewAtom, 'planning')
    store.set(automationFormAtom, { open: true, draft: null })
    const release = subscribeWorkspaceToolRequestContext(store)
    store.set(openWorkspaceToolAtom, 'browser')
    expect(store.get(activeViewAtom)).toBe('conversations')
    expect(store.get(automationFormAtom).open).toBe(false)
    expect(store.get(pendingWorkspaceToolRequestAtom('session-a'))).toMatchObject({ tool: 'browser' })
    store.set(openWorkspaceToolAtom, 'files')
    expect(store.get(pendingWorkspaceToolRequestAtom('session-a'))).toBeNull()
    release()
  })

  test('Given 未交付资源请求 When 切换会话再切回 Then 不恢复旧请求', () => {
    const store = createStore()
    store.set(currentAgentSessionIdAtom, 'session-a')
    const release = subscribeWorkspaceToolRequestContext(store)
    store.set(openWorkspaceToolAtom, 'terminal')
    store.set(currentAgentSessionIdAtom, 'session-b')
    store.set(currentAgentSessionIdAtom, 'session-a')
    expect(store.set(consumeWorkspaceToolRequestAtom, 'session-a')).toBeNull()
    release()
  })

  test('Given 活动工作区 When 映射选中入口 Then 动态标签和默认文件准确对应且Chat不串状态', () => {
    const store = createStore()
    store.set(currentAgentSessionIdAtom, 'session-a')
    store.set(agentSidePanelOpenAtomFamily('session-a'), true)
    expect(store.get(activeWorkspaceToolAtom)).toBe('files')
    for (const [tab, tool] of [['browser:1', 'browser'], ['terminal:1', 'terminal'], ['canvas:1', 'canvas'], ['canvas', 'canvas'], ['preview:1', 'files']] as const) {
      store.set(agentDiffPanelTabAtom, new Map([['session-a', tab]]))
      expect(store.get(activeWorkspaceToolAtom)).toBe(tool)
    }
    store.set(appModeAtom, 'chat')
    expect(store.get(activeWorkspaceToolAtom)).toBeNull()
  })

})


describe('影像创作独立入口', () => {
  test('Given 有效项目普通会话 When 打开影像创作 Then 独立标签可恢复且不替换画布', () => {
    /** 模拟用户主动打开入口，不靠后台创建自动聚焦。 */
    const store = createStore()
    store.set(agentWorkspacesAtom, [{ id: 'visual-project', name: '项目', slug: 'visual-project', createdAt: 1, updatedAt: 1 }])
    store.set(agentSessionsAtom, [{ id: 'visual-session', title: '会话', workspaceId: 'visual-project', createdAt: 1, updatedAt: 1 }])
    store.set(currentAgentSessionIdAtom, 'visual-session')
    expect(store.get(activeWorkspaceToolAtom)).not.toBe('visual-production')
    store.set(openWorkspaceToolAtom, 'visual-production')
    expect(store.get(activeWorkspaceToolAtom)).toBe('visual-production')
    expect(sanitizeWorkspaceComponentTabs(['canvas', 'interaction-design', 'visual-production', 'unknown'])).toEqual(['interaction-design', 'visual-production'])
  })

  test('Given 无效或后台会话 When 打开影像创作 Then 禁止导航', () => {
    /** 每种身份均需单独校验，不能使用全局选中的项目补齐归属。 */
    const invalidSessions = [undefined, { archived: true }, { parentSessionId: 'parent' }, { sourceCanvasId: 'canvas' }, { explorationParentSessionId: 'parent' }, { toolMode: 'server-ops-read' as const }, { workspaceId: 'missing' }]
    for (const invalid of invalidSessions) {
      /** 独立 store 避免前一用例的标签污染后续断言。 */
      const store = createStore()
      store.set(agentWorkspacesAtom, [{ id: 'visual-project', name: '项目', slug: 'visual-project', createdAt: 1, updatedAt: 1 }])
      store.set(agentSessionsAtom, invalid ? [{ id: 'visual-session', title: '会话', workspaceId: 'visual-project', createdAt: 1, updatedAt: 1, ...invalid }] : [])
      store.set(currentAgentSessionIdAtom, 'visual-session')
      expect(store.get(workspaceToolAvailabilityAtom)['visual-production']?.disabledReason).toBeDefined()
      store.set(openWorkspaceToolAtom, 'visual-production')
      expect(store.get(activeWorkspaceToolAtom)).not.toBe('visual-production')
    }
  })
})


test('Given Chat 模式保留有效 Agent 会话 When 打开影像创作 Then 不打开后台工作台', () => {
  /** Chat 与 Agent 使用不同交互入口，后台身份不能获得前台权限。 */
  const store = createStore()
  store.set(agentWorkspacesAtom, [{ id: 'visual-project', name: '项目', slug: 'visual-project', createdAt: 1, updatedAt: 1 }])
  store.set(agentSessionsAtom, [{ id: 'visual-session', title: '会话', workspaceId: 'visual-project', createdAt: 1, updatedAt: 1 }])
  store.set(currentAgentSessionIdAtom, 'visual-session')
  store.set(appModeAtom, 'chat')
  store.set(agentSidePanelOpenAtomFamily('visual-session'), false)
  expect(store.get(workspaceToolAvailabilityAtom)['visual-production'].disabledReason).toBeDefined()
  store.set(openWorkspaceToolAtom, 'visual-production')
  expect(store.get(agentSidePanelOpenAtomFamily('visual-session'))).toBe(false)
})
