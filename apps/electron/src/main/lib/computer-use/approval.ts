import type { DutyDeckPermissionMode, PermissionRequest } from '@dutydeck/shared'
import type { AgentPermissionService } from '../agent-permission-service'
import type { ComputerUseToolsContext } from './tools'

/** 绑定原生单次审批与当前运行身份；不接收任何自动授权策略。 */
interface ComputerUseApprovalContext {
  /** 本轮宿主会话身份。 */
  sessionId: string
  /** 现有原生审批服务，负责中止和请求生命周期。 */
  service: AgentPermissionService
  /** 宿主动态代际检查。 */
  assertActive(): void
  /** 审批前后均使用实时权限。 */
  getPermissionMode(): DutyDeckPermissionMode
  /** 发布用户确认卡。 */
  publishRequested(request: PermissionRequest): void
  /** 发布同一请求的终态，收回已解决的确认卡。 */
  publishResolved(requestId: string, behavior: 'allow' | 'deny'): void
}

/** 创建桌面专用批准回调，bypass/会话白名单/媒体自动策略均无法跳过。 */
export function createComputerUseApproval(context: ComputerUseApprovalContext): ComputerUseToolsContext['approve'] {
  return async (name, input, signal, toolUseId) => {
    /** 即使申请已撤销，仍以拒绝返回，不创建悬空确认卡。 */
    const allowedNow = (): boolean => {
      try { signal.throwIfAborted(); context.assertActive(); return context.getPermissionMode() !== 'plan' }
      catch { return false }
    }
    if (!allowedNow()) return false
    /** 审批身份由权限服务生成，终态只回收这张卡片。 */
    let requestId: string | undefined
    /** 当前批准只包含工具参数与目标，不携带任意 Driver 命令。 */
    const permission = await context.service.requestSingleApproval(context.sessionId, name, input, {
      signal,
      toolUseID: toolUseId,
      displayName: name === 'ComputerUseObserve' ? '观察电脑窗口' : '操作电脑窗口',
      description: name === 'ComputerUseObserve'
        ? '读取指定窗口的画面与控件文字，交给当前会话模型并进入会话历史。'
        : '在已观察的目标窗口执行这一次输入；已交给系统的动作不能回滚。',
    }, request => {
      requestId = request.requestId
      context.publishRequested(request)
    })
    /** 用户确认期间停止或切换计划模式时，批准自动失效。 */
    const allowed = permission.behavior === 'allow' && allowedNow()
    if (requestId) context.publishResolved(requestId, allowed ? 'allow' : 'deny')
    return allowed
  }
}
