import type { ActiveView } from '@/atoms/active-view'

export type WorkspaceToolTarget =
  | { kind: 'session-panel'; sessionId: string; surfaceId: string; moduleId?: string }
  | { kind: 'standalone-surface'; surfaceId: string; nextAction: 'create-session' | 'return-to-project' }
  | { kind: 'blocked'; reason: string }

/**
 * 统一计算工作区入口的目标位置；AppShell、工具栏和异步资源动作都应使用同一结果。
 * @param input 当前 Session、视图和工具入口快照。
 * @returns 可预测的会话面板、独立工作台或阻断结果。
 */
export function deriveWorkspaceToolTarget(input: {
  sessionId: string | null
  activeView: ActiveView
  tool: string
  moduleId?: string
}): WorkspaceToolTarget {
  const surfaceId = input.tool
  if (input.sessionId && input.activeView === 'conversations') {
    return { kind: 'session-panel', sessionId: input.sessionId, surfaceId, ...(input.moduleId ? { moduleId: input.moduleId } : {}) }
  }
  if (!input.sessionId && ['browser', 'terminal', 'canvas', 'files'].includes(input.tool)) {
    return { kind: 'standalone-surface', surfaceId, nextAction: 'create-session' }
  }
  // 无会话的效率工具和知识入口仍沿用整页导航，具体可用性由入口统一校验。
  if (!input.sessionId && ['todos', 'calendar', 'automations', 'skills', 'mcp', 'memory', 'vault'].includes(input.tool)) {
    return { kind: 'standalone-surface', surfaceId, nextAction: 'return-to-project' }
  }
  if (input.activeView === 'planning' || input.activeView === 'agent-skills' || input.activeView === 'vault') {
    return { kind: 'standalone-surface', surfaceId, nextAction: 'return-to-project' }
  }
  return { kind: 'blocked', reason: '当前工作区没有可用的 Agent 会话' }
}
