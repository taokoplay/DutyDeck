import { VISUAL_PRODUCTION_READ_METHODS, parseVisualProductionCommand } from '@dutydeck/shared'
import type { VisualProductionChanged, VisualProductionInputs, VisualProductionMethod, VisualProductionResults } from '@dutydeck/shared'

/** 身份解析后的唯一模块执行入口，UI 与 Agent 共享。 */
export interface VisualProductionExecutor {
  /** 当前绑定的项目身份，仅由主进程赋值。 */
  workspaceId: string
  /** 复核当前会话/根目录没有漂移。 */
  assertCurrent(): void
  /** 执行具有关联返回类型的模块命令。 */
  execute<M extends VisualProductionMethod>(method: M, input: VisualProductionInputs[M], signal?: AbortSignal): Promise<VisualProductionResults[M]>
  /** Host 直接等待媒体运行终态，不向 Agent 暴露内部轮询或远端身份。 */
  waitForMediaExecution?(input: { runId: string; engine: 'model' | 'workflow' }, signal?: AbortSignal): Promise<{ phase: string }>
}

/** 业务服务窄接口，便于隔离文件存储与权限测试。 */
export interface VisualProductionCommandService {
  /** 执行已经通过宿主归属验证的命令。 */
  invoke<M extends VisualProductionMethod>(method: M, input: VisualProductionInputs[M], signal?: AbortSignal): Promise<VisualProductionResults[M]>
}

/** 授权事实与文件服务由生产宿主注入，renderer 不可选项目路径。 */
export interface VisualProductionAccessDependencies {
  /** 获取当前用户项目会话，已归档或内部会话由宿主拒绝。 */
  resolveSession(sessionId: string): { workspaceId: string; projectRoot: string }
  /** 在每次新请求和异步返回后检查调用者仍有效。 */
  assertCaller?(): void
  /** 返回本次执行权限；Agent 计划模式禁止写，手工 UI 保持既有权限。 */
  canWrite?(): boolean
  /** 租约防止异步文件写期间迁移或删除项目。 */
  acquireWriteLease(workspaceId: string): () => void
  /** 为固定根构建服务，并在落盘前调用 assertCurrent。 */
  createService(context: { workspaceId: string; projectRoot: string; assertCurrent(): void }): VisualProductionCommandService
  /** Host 托管等待媒体运行终态。 */
  waitForMediaExecution?(input: { sessionId: string; runId: string; engine: 'model' | 'workflow' }, signal?: AbortSignal): Promise<{ phase: string }>
  /** 轻量失效事件，不附带任何页面正文。 */
  onChanged?(event: VisualProductionChanged): void
}

/**
 * 固定一次 IPC/Agent 运行的项目归属，防迟到操作写到新项目。
 * @param sessionId 可信入口绑定的普通会话。
 * @param dependencies 主进程身份、租约和文件服务。
 * @returns 校验身份并执行命令的窄接口。
 */
export function createVisualProductionAccess(sessionId: string, dependencies: VisualProductionAccessDependencies): VisualProductionExecutor {
  dependencies.assertCaller?.()
  const initial = dependencies.resolveSession(sessionId)
  const assertCurrent = (): void => {
    dependencies.assertCaller?.()
    const current = dependencies.resolveSession(sessionId)
    if (current.workspaceId !== initial.workspaceId || current.projectRoot !== initial.projectRoot) throw new Error('VISUAL_PRODUCTION_ACCESS_CHANGED: 项目归属或目录已变化，请重新打开影像作品')
  }
  return {
    workspaceId: initial.workspaceId,
    assertCurrent,
    ...(dependencies.waitForMediaExecution ? {
      async waitForMediaExecution(input: { runId: string; engine: 'model' | 'workflow' }, signal?: AbortSignal): Promise<{ phase: string }> {
        assertCurrent()
        signal?.throwIfAborted()
        const result = await dependencies.waitForMediaExecution!({ sessionId, ...input }, signal)
        assertCurrent()
        signal?.throwIfAborted()
        return result
      },
    } : {}),
    async execute<M extends VisualProductionMethod>(method: M, input: VisualProductionInputs[M], signal?: AbortSignal): Promise<VisualProductionResults[M]> {
      /** 独立工具调用可比整轮更早被取消；在每次读取返回及提交前重新检查。 */
      const assertInvocation = (): void => {
        assertCurrent()
        if (signal?.aborted) throw new Error('VISUAL_PRODUCTION_ABORTED: 本次工具调用已取消')
      }
      assertInvocation()
      if (input.sessionId !== sessionId) throw new Error('VISUAL_PRODUCTION_ACCESS_DENIED: 会话身份不匹配')
      const command = parseVisualProductionCommand({ method, input })
      const writes = !VISUAL_PRODUCTION_READ_METHODS.includes(method)
      if (writes && dependencies.canWrite?.() === false) throw new Error('VISUAL_PRODUCTION_READ_ONLY: 计划模式不能修改影像作品')
      const release = writes ? dependencies.acquireWriteLease(initial.workspaceId) : undefined
      try {
        const service = dependencies.createService({ ...initial, assertCurrent: () => {
          assertInvocation()
          if (writes && dependencies.canWrite?.() === false) throw new Error('VISUAL_PRODUCTION_READ_ONLY: 写入权限已变更')
        } })
        const result = await service.invoke(method, command.input as VisualProductionInputs[M], signal)
        assertInvocation()
        if (writes) dependencies.onChanged?.({ workspaceId: initial.workspaceId, ...('productionId' in command.input ? { productionId: command.input.productionId } : {}) })
        return result
      } finally { release?.() }
    },
  }
}
