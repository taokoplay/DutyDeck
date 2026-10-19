import type { createStore } from 'jotai'
import { finishWorkspaceToolRequestAtom, consumeWorkspaceToolRequestAtom, pendingWorkspaceToolRequestAtom, workspaceToolNavigationRevisionAtom, workspaceProjectAtom } from '@/atoms/workspace-tools'

import { currentAgentSessionIdAtom, currentSessionSidePanelOpenAtom, agentDiffPanelTabAtom } from '@/atoms/agent-atoms'
import { appModeAtom } from '@/atoms/app-mode'
import { activeViewAtom } from '@/atoms/active-view'

/** 现有 SidePanel 提供资源动作；请求交付层不拥有浏览器、终端或画布。 */
export interface WorkspaceToolRequestActions {
  canvasReady: boolean
  canvasError: string | null
  openBrowser: () => void | Promise<unknown>
  openTerminal: () => void | Promise<unknown>
  openCanvas: () => void | Promise<unknown>
  reportError: (message: string) => void
}

/**
 * 将指定会话的待处理入口交给现有工作区回调。
 * 输入 store、会话与当前就绪状态；返回交付完成的 Promise，不创建额外资源。
 * Canvas 加载中保留请求；执行前原子取走，StrictMode 重放也不会重复打开。
 */
export async function runPendingWorkspaceToolRequest(
  store: ReturnType<typeof createStore>,
  sessionId: string,
  actions: WorkspaceToolRequestActions,
): Promise<void> {
  /** 先只读就绪条件，失败或就绪才消费 Canvas 请求。 */
  const pending = store.get(pendingWorkspaceToolRequestAtom(sessionId))
  if (!pending || (pending.tool === 'canvas' && !actions.canvasReady && !actions.canvasError)) return
  /** 消费函数重新校验当前会话，返回值是本次独占执行凭据。 */
  const request = store.set(consumeWorkspaceToolRequestAtom, sessionId)
  if (!request) return
  /** 失败提示与回执共享身份检查，迟到失败不能污染其他会话。 */
  const fail = (message: string): void => {
    if (store.set(finishWorkspaceToolRequestAtom, { request, status: 'failed', message })) actions.reportError(message)
  }
  if (request.tool === 'canvas' && actions.canvasError) {
    fail(actions.canvasError)
    return
  }
  try {
    /** false 是既有 Canvas 动作的明确失败结果，不能标记成功。 */
    const result = request.tool === 'browser' ? await actions.openBrowser()
      : request.tool === 'terminal' ? await actions.openTerminal() : await actions.openCanvas()
    if (result === false) throw new Error('资源未能打开')
    store.set(finishWorkspaceToolRequestAtom, { request, status: 'opened' })
  } catch {
    fail(request.tool === 'browser' ? '打开浏览器失败，请重试' : request.tool === 'terminal' ? '打开终端失败，请重试' : '打开画布失败，请重试')
  }
}

/** 为一次资源打开捕获导航身份；返回的谓词只授权仍在原上下文的前台选择。 */
export function createWorkspaceToolNavigationGuard(store: ReturnType<typeof createStore>, sessionId: string): () => boolean {
  const revision = store.get(workspaceToolNavigationRevisionAtom)
  const projectId = store.get(workspaceProjectAtom)
  const originalTab = store.get(agentDiffPanelTabAtom).get(sessionId)
  return () => store.get(currentAgentSessionIdAtom) === sessionId
    && store.get(appModeAtom) === 'agent'
    && store.get(activeViewAtom) === 'conversations'
    && store.get(currentSessionSidePanelOpenAtom)
    && store.get(workspaceProjectAtom) === projectId
    && store.get(workspaceToolNavigationRevisionAtom) === revision
    && store.get(agentDiffPanelTabAtom).get(sessionId) === originalTab
}
