import type { AgentSubmitOrEnqueueInput, AgentSubmitOrEnqueueResult } from '@dutydeck/shared'
import { getReferencedMediaModelRefs } from './agent-media-model-selection'

/**
 * Pi runtime 完成 query 与 renderer 收到终态事件之间，可能拒绝对旧通道的消息注入。
 * 这些错误表示消息尚未被接受，应转交 deferred queue，而不是暴露为用户发送失败。
 */
export function isStaleActiveQueueError(error: unknown): boolean {
  const record = error !== null && typeof error === 'object'
    ? error as Record<string, unknown>
    : undefined
  const code = typeof record?.code === 'string' ? record.code : ''
  const message = error instanceof Error
    ? error.message
    : typeof record?.message === 'string'
      ? record.message
      : String(error)

  return code === 'agent.query.not_active' ||
    message.includes('AGENT_MODULE_REQUIRES_NEW_RUN') ||
    message.includes('会话未运行，无法追加消息') ||
    message.includes('无活跃消息通道可注入队列消息') ||
    message.includes('当前会话没有正在运行的 Agent') ||
    message.includes('Agent session is not active')
}

/** queue-now 原子路由所需的可注入副作用。 */
export interface AgentSubmitRouteDependencies<TPrepared> {
  isActive: (sessionId: string) => boolean
  prepareNow: (input: AgentSubmitOrEnqueueInput) => TPrepared | Promise<TPrepared>
  injectPrepared: (prepared: TPrepared) => Promise<void>
  enqueue: (input: AgentSubmitOrEnqueueInput) => void
  onStaleActive: (sessionId: string) => void
}

/** 先完成权威解析，再把 Pi stale-active 与 resolver 拒绝严格分流。 */
export async function routeAgentSubmitOrEnqueue<TPrepared>(
  input: AgentSubmitOrEnqueueInput,
  dependencies: AgentSubmitRouteDependencies<TPrepared>,
): Promise<AgentSubmitOrEnqueueResult> {
  // 显式模块、媒体模型和影像目标使用独立新运行，冻结各自工具与上下文归属。
  if (input.dispatch === 'now' && !input.moduleIds?.length && !input.visualProductionReferences?.length
    && getReferencedMediaModelRefs(input.mentionedMediaModelRefs).length === 0 && dependencies.isActive(input.sessionId)) {
    const prepared = await dependencies.prepareNow(input)
    if (!dependencies.isActive(input.sessionId)) {
      dependencies.enqueue(input)
      return { disposition: 'queued' }
    }
    try {
      await dependencies.injectPrepared(prepared)
      return { disposition: 'injected' }
    } catch (error) {
      if (!isStaleActiveQueueError(error)) throw error
      dependencies.onStaleActive(input.sessionId)
    }
  }
  dependencies.enqueue(input)
  return { disposition: 'queued' }
}
