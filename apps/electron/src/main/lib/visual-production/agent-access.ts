import type { AgentSessionMeta } from '@dutydeck/shared'
import { isEligibleProjectAgent } from '../agent-session-visibility'
import type { VisualProductionExecutor } from './access'
import type { VisualLockedAssetApprovalRequest } from './store'

/** 前台运行事实由编排器提供，不允许工具参数声明来源。 */
interface InteractionAgentAccessOptions {
  sessionId: string
  toolMode: string
  triggeredBy?: string
  automation: boolean
  getSession(sessionId: string): AgentSessionMeta | undefined
  assertRunActive(): void
  canWrite(): boolean
  /** Agent 正式修改锁定资产时请求项目统一权限弹窗。 */
  authorizeLockedAssetChanges?(request: VisualLockedAssetApprovalRequest, signal?: AbortSignal): Promise<boolean>
  /** Host 直接等待媒体运行终态，避免模型逐 revision 轮询。 */
  waitForMediaExecution?(input: { sessionId: string; runId: string; engine: 'model' | 'workflow' }, signal?: AbortSignal): Promise<{ phase: string }>
  createAccess(sessionId: string, options: {
    assertCaller(): void
    canWrite(): boolean
    authorizeLockedAssetChanges?(request: VisualLockedAssetApprovalRequest, signal?: AbortSignal): Promise<boolean>
    waitForMediaExecution?(input: { sessionId: string; runId: string; engine: 'model' | 'workflow' }, signal?: AbortSignal): Promise<{ phase: string }>
  }): VisualProductionExecutor
}

/** 仅当前用户项目前台运行注册能力，且每次调用重新检查归属、模式和取消状态。 */
export function createVisualProductionAgentAccess(options: InteractionAgentAccessOptions): VisualProductionExecutor | null {
  /** 当前会话的初始归属。 */
  const initial = options.getSession(options.sessionId)
  if (options.toolMode !== 'standard' || options.automation || (options.triggeredBy && options.triggeredBy !== 'user')
    || !initial || !initial.workspaceId || initial.archived || !isEligibleProjectAgent(initial, initial.workspaceId)) return null
  /** 固定标量身份，不能持有随后可能被就地更新的会话对象引用。 */
  const workspaceId = initial.workspaceId
  return options.createAccess(options.sessionId, {
    canWrite: options.canWrite,
    ...(options.authorizeLockedAssetChanges ? { authorizeLockedAssetChanges: options.authorizeLockedAssetChanges } : {}),
    ...(options.waitForMediaExecution ? { waitForMediaExecution: options.waitForMediaExecution } : {}),
    assertCaller: () => {
      options.assertRunActive()
      /** 后续回合不能继承已改变的运行归属。 */
      const current = options.getSession(options.sessionId)
      if (!current || !current.workspaceId || current.archived || current.workspaceId !== workspaceId
        || !isEligibleProjectAgent(current, workspaceId) || (current.toolMode ?? 'standard') !== 'standard') {
        throw new Error('VISUAL_PRODUCTION_ACCESS_CHANGED: Agent 运行归属已变化')
      }
    },
  })
}
