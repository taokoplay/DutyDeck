import { atom } from 'jotai'
import type { AgentSessionMeta } from '@dutydeck/shared'
import { activeViewAtom } from './active-view'
import { agentDiffPanelTabAtom, agentSessionsAtom, currentAgentSessionIdAtom } from './agent-atoms'
import { agentSessionModulePolicyAtomFamily } from './agent-module-atoms'

export interface WorkContext {
  projectId: string | null
  sessionId: string | null
  runId: string | null
  surfaceId: string | null
  activeModuleIds: string[]
  returnRoute: 'agent' | 'project' | 'module'
  revision: number
}

/** 从全局 Session、视图和模块策略派生唯一工作上下文，组件不再自行拼接归属。 */
export function deriveWorkContext(input: {
  session: AgentSessionMeta | null
  activeView: 'conversations' | 'planning' | 'agent-skills' | 'vault'
  surfaceId: string | null
  modulePolicyRevision?: number
  activeModuleIds?: string[]
}): WorkContext {
  const projectId = input.session?.workspaceId ?? null
  const returnRoute = input.activeView === 'conversations' && input.session ? 'agent'
    : input.activeView === 'agent-skills' || input.activeView === 'vault' ? 'module'
      : 'project'
  return {
    projectId,
    sessionId: input.session?.id ?? null,
    runId: null,
    surfaceId: input.surfaceId,
    activeModuleIds: [...(input.activeModuleIds ?? [])],
    returnRoute,
    revision: input.modulePolicyRevision ?? 0,
  }
}

/** 当前任务与工作区入口共享的派生上下文。 */
export const workContextAtom = atom<WorkContext>((get) => {
  const sessions = get(agentSessionsAtom)
  const sessionId = get(currentAgentSessionIdAtom)
  const session = sessions.find((candidate) => candidate.id === sessionId) ?? null
  const activeView = get(activeViewAtom)
  const surfaceId = sessionId ? get(agentDiffPanelTabAtom).get(sessionId) ?? null : null
  const policy = sessionId ? get(agentSessionModulePolicyAtomFamily(sessionId)) : null
  return deriveWorkContext({
    session,
    activeView,
    surfaceId,
    modulePolicyRevision: policy?.revision,
    activeModuleIds: policy?.enabledModuleIds,
  })
})
