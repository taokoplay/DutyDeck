import { isOrdinaryTopLevelAgentSession } from '@dutydeck/shared'
import type { AgentSessionMeta } from '@dutydeck/shared'
import { atom } from 'jotai'
import type { createStore } from 'jotai'
import { atomFamily } from 'jotai-family'
import {
  agentDiffPanelTabAtom,
  agentSessionsAtom,
  agentWorkspacesAtom,
  agentSidePanelOpenAtomFamily,
  currentAgentSessionIdAtom,
  currentAgentWorkspaceIdAtom,
  currentSessionSidePanelOpenAtom,
  isWorkspaceComponentTab,
  openWorkspaceComponentAtom,
} from './agent-atoms'
import { activeViewAtom, agentSkillsTabAtom } from './active-view'
import { appModeAtom } from './app-mode'
import { automationFormAtom } from './automation-atoms'
import { planningTabAtom } from './planning-atoms'
import { productivityToolsAtom } from './ui-preferences'
import type { WorkspaceComponentTab } from './agent-atoms'
import { deriveWorkspaceToolTarget } from '@/lib/work-context-routing'

/** 工作区工具入口：4 个动态工作区加上 10 个项目组件。 */
export type WorkspaceToolId = 'browser' | 'files' | 'terminal' | 'canvas' | WorkspaceComponentTab

export const WORKSPACE_TOOLS_COLLAPSED_WIDTH = 78
export const WORKSPACE_TOOLS_EXPANDED_WIDTH = 208

/** 常驻工作区工具栏是否展开，默认收起以减少主界面占用。 */
export const workspaceToolsExpandedAtom = atom(false)

/** 根据展开状态计算工具栏宽度，保证布局只依赖一个稳定尺寸。 */
export const workspaceToolsWidthAtom = atom((get) => (
  get(workspaceToolsExpandedAtom)
    ? WORKSPACE_TOOLS_EXPANDED_WIDTH
    : WORKSPACE_TOOLS_COLLAPSED_WIDTH
))

export interface WorkspaceToolAvailability {
  visible: boolean
  disabledReason?: string
}

/** 当前会话优先使用会话所属项目；无会话时回退到当前选中项目。 */
export const workspaceProjectAtom = atom((get) => {
  const sessionId = get(appModeAtom) === 'agent' ? get(currentAgentSessionIdAtom) : null
  const workspaces = get(agentWorkspacesAtom)
  if (sessionId) {
    const workspaceId = get(agentSessionsAtom).find((session) => session.id === sessionId)?.workspaceId
    return workspaceId && workspaces.some((workspace) => workspace.id === workspaceId) ? workspaceId : null
  }
  const selectedId = get(currentAgentWorkspaceIdAtom)
  return workspaces.some((workspace) => workspace.id === selectedId) ? selectedId : null
})

/** 动态请求身份跨消费与异步完成保留，避免旧结果覆盖新导航。 */
export interface WorkspaceToolRequest {
  /** 本次点击的唯一身份。 */
  requestId: string
  /** 资源归属会话。 */
  sessionId: string
  /** 沿用 WorkContext 路由的工具 surface 身份。 */
  surfaceId: 'browser' | 'terminal' | 'canvas'
  /** 发起时的导航代次。 */
  navigationRevision: number
  /** 本次请求的动态工具。 */
  tool: 'browser' | 'terminal' | 'canvas'
}

/** 每个会话只保存最近一次请求的可见结果。 */
export interface WorkspaceToolReceipt extends WorkspaceToolRequest {
  /** pending 包含等待就绪及已经消费的在途动作。 */
  status: 'pending' | 'opened' | 'failed' | 'canceled'
  /** 失败或取消的用户可见原因。 */
  message?: string
}

/** 队列与回执分离：消费不代表成功。 */
const workspaceToolRequestsAtom = atom<Map<string, WorkspaceToolRequest>>(new Map())
/** 最多保留最近 64 个会话的各一条回执，避免无限累积。 */
const workspaceToolReceiptsAtom = atom<Map<string, WorkspaceToolReceipt>>(new Map())

/** 用户导航代次使已交付但尚未完成的资源动作失去前台焦点权限。 */
export const workspaceToolNavigationRevisionAtom = atom(0)

/** 指定会话时仅撤销该会话请求；全局导航同时撤销已消费的在途动作。 */
export const clearWorkspaceToolRequestAtom = atom(null, (get, set, sessionId?: string) => {
  if (!sessionId || get(currentAgentSessionIdAtom) === sessionId) {
    set(workspaceToolNavigationRevisionAtom, (revision) => revision + 1)
  }
  /** 后台会话的延迟关闭不能撤销当前会话的资源请求和焦点权限。 */
  const requests = new Map(get(workspaceToolRequestsAtom))
  if (sessionId) requests.delete(sessionId)
  else requests.clear()
  set(workspaceToolRequestsAtom, requests)
  /** 已消费请求也保留 pending 回执，因此导航可立即报告取消。 */
  const receipts = new Map(get(workspaceToolReceiptsAtom))
  for (const [id, receipt] of receipts) {
    if ((!sessionId || sessionId === id) && receipt.status === 'pending') {
      receipts.set(id, { ...receipt, status: 'canceled', message: '已取消打开：你已切换位置；已创建资源仍保留在原会话' })
    }
  }
  set(workspaceToolReceiptsAtom, receipts)
})

/** 统一生成请求身份并立即发布 pending；新点击使旧在途动作失去焦点权限。 */
export const requestWorkspaceToolAtom = atom(
  null,
  (get, set, input: { sessionId: string; tool: WorkspaceToolRequest['tool'] }) => {
    set(clearWorkspaceToolRequestAtom)
    /** 导航身份由 store 生成，调用方不能伪造代次。 */
    const request: WorkspaceToolRequest = {
      ...input, requestId: crypto.randomUUID(), surfaceId: input.tool,
      navigationRevision: get(workspaceToolNavigationRevisionAtom),
    }
    set(workspaceToolRequestsAtom, new Map([[input.sessionId, request]]))
    /** 删除后追加使 Map 顺序表达最近使用时间。 */
    const receipts = new Map(get(workspaceToolReceiptsAtom))
    receipts.delete(input.sessionId)
    receipts.set(input.sessionId, { ...request, status: 'pending' })
    while (receipts.size > 64) receipts.delete(receipts.keys().next().value!)
    set(workspaceToolReceiptsAtom, receipts)
  },
)

/** 回执读取不依赖队列，消费后仍能显示进行中和取消。 */
export const workspaceToolReceiptAtom = atomFamily((sessionId: string) => atom(
  (get) => get(workspaceToolReceiptsAtom).get(sessionId) ?? null,
))

/** 只允许相同请求与导航代次完成；返回是否接纳，供调用方抑制迟到错误提示。 */
export const finishWorkspaceToolRequestAtom = atom(null, (get, set, result: {
  request: WorkspaceToolRequest
  status: 'opened' | 'failed'
  message?: string
}) => {
  /** 当前回执是请求终态的唯一写入依据。 */
  const current = get(workspaceToolReceiptsAtom).get(result.request.sessionId)
  if (!current || current.requestId !== result.request.requestId || current.status !== 'pending') return false
  /** 即使订阅尚未安装，也不把离开上下文的结果误报为打开成功。 */
  const valid = get(currentAgentSessionIdAtom) === current.sessionId
    && get(appModeAtom) === 'agent'
    && get(activeViewAtom) === 'conversations'
    && get(workspaceToolNavigationRevisionAtom) === current.navigationRevision
  const receipts = new Map(get(workspaceToolReceiptsAtom))
  receipts.set(current.sessionId, valid
    ? { ...current, status: result.status, message: result.message }
    : { ...current, status: 'canceled', message: '已取消打开：你已切换位置；已创建资源仍保留在原会话' })
  set(workspaceToolReceiptsAtom, receipts)
  return valid
})

/** 读取指定 session 尚未处理的动态请求。 */
export const pendingWorkspaceToolRequestAtom = atomFamily((sessionId: string) => atom(
  (get) => get(workspaceToolRequestsAtom).get(sessionId) ?? null,
))

/** 原子取走指定 session 的动态请求；调用后对应 pending atom 立即为空。 */
export const consumeWorkspaceToolRequestAtom = atom(
  null,
  (get, set, sessionId: string) => {
    const current = get(workspaceToolRequestsAtom).get(sessionId)
    if (!current || get(currentAgentSessionIdAtom) !== sessionId || get(appModeAtom) !== 'agent') return null
    const next = new Map(get(workspaceToolRequestsAtom))
    next.delete(sessionId)
    set(workspaceToolRequestsAtom, next)
    return current
  },
)

/** 固定工具清单用于共享导航守卫，避免展示与命令校验漂移。 */
const ALL_WORKSPACE_TOOLS: readonly WorkspaceToolId[] = ['browser', 'files', 'terminal', 'canvas', 'todos', 'calendar', 'automations', 'skills', 'mcp', 'memory', 'vault', 'server-ops', 'api-workbench', 'capability-factory', 'interaction-design', 'visual-production', 'mobile-mirror']
/** 这些入口必须拥有 Agent 会话才能维持资源归属。 */
const SESSION_TOOLS: readonly WorkspaceToolId[] = ['browser', 'files', 'terminal', 'canvas', 'server-ops', 'api-workbench', 'capability-factory', 'interaction-design', 'visual-production', 'mobile-mirror']
/** Chat 继续只提供原有的效率工具与 Obsidian 整页入口。 */
const CAPABILITY_TOOLS: readonly WorkspaceToolId[] = ['skills', 'mcp', 'memory']

/**
 * 判断影像创作入口的会话身份，供菜单和右侧面板共享。
 * @param session 当前真实会话，不使用全局项目回退。
 * @param workspaceExists 会话所属项目是否仍存在。
 * @returns 可展示的拒绝原因；符合普通项目会话约束时返回 null。
 */
export function visualProductionDenialReason(session: AgentSessionMeta | undefined, workspaceExists: boolean): string | null {
  if (!isOrdinaryTopLevelAgentSession(session) || session.archived || session.explorationParentSessionId !== undefined || (session.toolMode ?? 'standard') !== 'standard') return '影像创作仅支持未归档的普通项目会话'
  if (!session.workspaceId || !workspaceExists) return '当前会话没有有效的所属项目'
  return null
}

/** 根据模式、有效项目和功能开关计算显示与禁用状态，供界面与写入动作共同使用。 */
export const workspaceToolAvailabilityAtom = atom<Record<WorkspaceToolId, WorkspaceToolAvailability>>((get) => {
  const agentMode = get(appModeAtom) === 'agent'
  const sessionId = agentMode ? get(currentAgentSessionIdAtom) : null
  const projectId = get(workspaceProjectAtom)
  /** 入口依据会话索引验证身份，不允许后台会话借用普通入口。 */
  const visualDenial = visualProductionDenialReason(get(agentSessionsAtom).find((session) => session.id === sessionId), Boolean(projectId))
  const settings = get(productivityToolsAtom)
  const availability = {} as Record<WorkspaceToolId, WorkspaceToolAvailability>
  for (const tool of ALL_WORKSPACE_TOOLS) {
    if ((tool === 'todos' && !settings.todosEnabled) || (tool === 'calendar' && !settings.calendarEnabled) || (tool === 'vault' && !settings.obsidianEnabled) || (!agentMode && CAPABILITY_TOOLS.includes(tool))) {
      availability[tool] = { visible: false }
    } else if (!sessionId && SESSION_TOOLS.includes(tool)) {
      availability[tool] = { visible: true, disabledReason: '需要先打开 Agent 会话' }
    } else if (tool === 'visual-production' && visualDenial) {
      availability[tool] = { visible: true, disabledReason: visualDenial }
    } else if (sessionId && !projectId && !['files', 'browser', 'terminal', 'server-ops'].includes(tool)) {
      availability[tool] = { visible: true, disabledReason: '当前会话没有有效的所属项目' }
    } else {
      availability[tool] = { visible: true }
    }
  }
  return availability
})

/** 处理常驻工具栏动作；动态资源入口交给 SidePanel 现有回调消费。 */
export const openWorkspaceToolAtom = atom(
  null,
  (get, set, tool: WorkspaceToolId) => {
    const availability = get(workspaceToolAvailabilityAtom)[tool]
    if (!availability.visible || availability.disabledReason) return
    const sessionId = get(appModeAtom) === 'agent' ? get(currentAgentSessionIdAtom) : null
    const target = deriveWorkspaceToolTarget({
      sessionId,
      activeView: get(activeViewAtom),
      tool,
      moduleId: ['browser', 'terminal', 'canvas'].includes(tool) ? tool : undefined,
    })
    if (target.kind === 'blocked') return
    set(clearWorkspaceToolRequestAtom)
    set(automationFormAtom, { open: false, draft: null })
    if (!sessionId) {
      if (tool === 'todos' || tool === 'calendar' || tool === 'automations') {
        set(planningTabAtom, tool)
        set(activeViewAtom, 'planning')
      } else if (tool === 'skills' || tool === 'mcp' || tool === 'memory') {
        set(agentSkillsTabAtom, tool)
        set(activeViewAtom, 'agent-skills')
      } else if (tool === 'vault') {
        set(activeViewAtom, 'vault')
      }
      return
    }
    set(activeViewAtom, 'conversations')
    set(currentSessionSidePanelOpenAtom, true)
    if (tool === 'files') {
      set(agentDiffPanelTabAtom, (previous) => new Map(previous).set(sessionId, 'files'))
    } else if (tool === 'browser' || tool === 'terminal' || tool === 'canvas') {
      set(requestWorkspaceToolAtom, { sessionId, tool })
    } else {
      set(openWorkspaceComponentAtom, tool)
    }
  },
)

/**
 * 在 AppShell 生命周期内同步撤销已离开的上下文请求。
 * 返回清理订阅的函数；进入 conversations 是菜单导航本身，不清除刚写入的新请求。
 */
export function subscribeWorkspaceToolRequestContext(store: ReturnType<typeof createStore>): () => void {
  const clearPending = () => store.set(clearWorkspaceToolRequestAtom)
  const unsubscribeSession = store.sub(currentAgentSessionIdAtom, clearPending)
  const unsubscribeMode = store.sub(appModeAtom, clearPending)
  const unsubscribeProject = store.sub(workspaceProjectAtom, clearPending)
  const unsubscribeView = store.sub(activeViewAtom, () => {
    if (store.get(activeViewAtom) !== 'conversations') clearPending()
  })
  const unsubscribePanel = store.sub(currentSessionSidePanelOpenAtom, () => {
    if (!store.get(currentSessionSidePanelOpenAtom)) clearPending()
  })
  return () => { unsubscribeSession(); unsubscribeMode(); unsubscribeProject(); unsubscribeView(); unsubscribePanel(); clearPending() }
}

/** 从当前 view、planning/skills 子页和右侧动态 Tab 派生当前入口。 */
export const activeWorkspaceToolAtom = atom<WorkspaceToolId | null>((get) => {
  const view = get(activeViewAtom)
  if (view === 'planning') return get(planningTabAtom)
  if (view === 'agent-skills') return get(agentSkillsTabAtom)
  if (view === 'vault') return 'vault'
  if (get(appModeAtom) !== 'agent') return null
  const sessionId = get(currentAgentSessionIdAtom)
  if (!sessionId || !get(agentSidePanelOpenAtomFamily(sessionId))) return null
  const tab = get(agentDiffPanelTabAtom).get(sessionId) ?? 'files'
  if (tab.startsWith('browser:')) return 'browser'
  if (tab.startsWith('terminal:')) return 'terminal'
  if (tab === 'canvas' || tab.startsWith('canvas:')) return 'canvas'
  if (tab === 'preview' || tab.startsWith('preview:')) return 'files'
  return isWorkspaceComponentTab(tab) ? tab : tab === 'files' ? 'files' : null
})
