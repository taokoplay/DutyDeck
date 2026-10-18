import { randomUUID } from 'node:crypto'
import type { AgentMessage, AgentSendInput } from '@dutydeck/shared'
import type { ToolDefinition } from '@earendil-works/pi-coding-agent'
import type { AgentRunExtensions } from '../agent-run-extensions'
import type { HeadlessAgentRunCallbacks, HeadlessAgentRunner } from '../agent-headless-runner-registry'
import type { VisualTaskContextPolicy } from './context-contract'

/** 子任务只报告宿主核对后的终态；自然语言摘要不充当视觉验收。 */
interface VisualDelegationReceipt {
  id: string
  contextId: string
  childSessionId: string
  status: 'running' | 'completed' | 'failed' | 'cancelled'
  summary?: string
  error?: string
}

/** 隔离会话创建与运行，便于离线验证授权和终态。 */
interface VisualDelegationPorts {
  parentSessionId: string
  workspaceId: string
  channelId: string
  modelId?: string
  /** 父运行的同步撤销检查。 */
  assertActive(): void
  /** 每次使用前复核固定范围与版本。 */
  assertContext(contextId: string): Promise<void>
  /** 总是创建干净子会话，不续用其他镜头的历史。 */
  createSession(id: string, objective: string): string
  /** 返回只对固定范围开放的工具及一次性生命周期。 */
  createTools(contextId: string, runId: string): Promise<{ tools: ToolDefinition[]; policy: VisualTaskContextPolicy; prompt: string; hasObservation(): boolean; dispose(): void }>
  run: HeadlessAgentRunner
  stop(sessionId: string): void
}

/** 有界内存回执不携带图片；子会话与观察由各自既有存储持久化。 */
interface ActiveReview {
  receipt: VisualDelegationReceipt
  release(): void
}

/**
 * 创建仅存活于父运行的只读审图委派控制器。
 * @param ports 宿主范围校验与独立会话运行端口。
 * @returns 显式启动、查询及撤销能力；不恢复或重放已结束委派。
 */
export function createVisualContextDelegation(ports: VisualDelegationPorts) {
  const reviews = new Map<string, ActiveReview>()
  let disposed = false
  /** 拒绝已结束父运行的任何调用。 */
  const assertActive = (): void => { if (disposed) throw new Error('VISUAL_REVIEW_REVOKED'); ports.assertActive() }
  /** 先提交终态再释放资源；重复或迟到回调无效。 */
  const finish = (review: ActiveReview, status: VisualDelegationReceipt['status'], error?: string, messages?: AgentMessage[]): void => {
    if (review.receipt.status !== 'running') return
    review.receipt.status = status
    if (error) review.receipt.error = error.slice(0, 2048)
    if (status === 'completed') review.receipt.summary = messages?.filter(message => message.role === 'assistant').at(-1)?.content.slice(0, 4096)
    review.release()
  }
  return {
    /** 创建新会话并立即返回回执，后台运行只持有冻结工具集合。 */
    async start(contextId: string, objective: string, signal?: AbortSignal): Promise<VisualDelegationReceipt> {
      signal?.throwIfAborted()
      assertActive()
      if (!objective.trim() || objective.length > 2000) throw new Error('VISUAL_REVIEW_OBJECTIVE_INVALID')
      if (reviews.size >= 8 || [...reviews.values()].filter(item => item.receipt.status === 'running').length >= 2) throw new Error('VISUAL_REVIEW_LIMIT')
      await ports.assertContext(contextId)
      signal?.throwIfAborted()
      assertActive()
      const id = randomUUID()
      const capability = await ports.createTools(contextId, id)
      try {
        assertActive()
        await ports.assertContext(contextId)
        signal?.throwIfAborted()
        assertActive()
        const childSessionId = ports.createSession(id, objective)
        const review: ActiveReview = { receipt: { id, contextId, childSessionId, status: 'running' }, release: capability.dispose }
        reviews.set(id, review)
        const extensions: AgentRunExtensions = {
          piCustomTools: capability.tools,
          allowedToolNames: capability.tools.map(tool => tool.name), allowedToolNamesMode: 'replace', skillsMode: 'disabled',
          visualTaskContextPolicy: capability.policy,
          toolCallLimits: { visual_production_inspect_media: 32, visual_production_record_observation: 8 },
          evaluateCompletion: async () => {
            assertActive()
            await ports.assertContext(contextId)
            return capability.hasObservation() ? { action: 'complete' } : { action: 'blocked', message: '子任务没有提交绑定实际样本的观察记录，不能认定检查完成。' }
          },
          systemPromptAppend: `你只负责固定范围的视觉检查，不执行生成、写文件或其他项目操作。必须先 inspect 实际样本，下一轮再 record_observation。观察是模型判断；抽样不代表全片验收。\n${capability.prompt}`,
          beforeToolCall: () => { assertActive(); if (review.receipt.status !== 'running') throw new Error('VISUAL_REVIEW_REVOKED') },
        }
        const input: AgentSendInput = { sessionId: childSessionId, userMessage: objective, channelId: ports.channelId, modelId: ports.modelId,
          workspaceId: ports.workspaceId, triggeredBy: 'delegation', permissionModeOverride: 'bypassPermissions' }
        const callbacks: HeadlessAgentRunCallbacks = {
          source: 'delegation', originSessionId: ports.parentSessionId,
          onTitleUpdated: () => undefined,
          onError: error => finish(review, 'failed', error),
          onComplete: (messages, terminal) => {
            if (disposed) return
            try { assertActive() } catch { finish(review, 'cancelled'); return }
            if (terminal?.status === 'completed' && terminal.resultSubtype === 'success' && !terminal.stoppedByUser && !terminal.resultErrors?.length && !terminal.terminalReason) finish(review, 'completed', undefined, messages)
            else finish(review, terminal?.status === 'cancelled' ? 'cancelled' : 'failed', terminal?.resultErrors?.join('\n') || terminal?.terminalReason || '子任务没有可验证的成功终态')
          },
        }
        void ports.run(input, callbacks, extensions).then(() => {
          if (review.receipt.status === 'running') finish(review, 'failed', '子任务已返回但缺少可信终态，请读取已有观察后重新发起检查。')
        }, error => finish(review, 'failed', error instanceof Error ? error.message : String(error)))
        return structuredClone(review.receipt)
      } catch (error) { capability.dispose(); throw error }
    },
    /** 查询只检查当前内存回执，恢复历史不会重新执行或生成。 */
    async read(id: string): Promise<VisualDelegationReceipt> {
      assertActive()
      const review = reviews.get(id)
      if (!review) throw new Error('VISUAL_REVIEW_NOT_FOUND: 本轮没有此委派，请读取已保存的观察记录')
      await ports.assertContext(review.receipt.contextId)
      assertActive()
      return structuredClone(review.receipt)
    },
    /** 新范围或阶段关闭先撤销所有活动子任务，终态回执继续保留。 */
    cancelAll(): void {
      for (const review of reviews.values()) {
        if (review.receipt.status !== 'running') continue
        finish(review, 'cancelled')
        try { ports.stop(review.receipt.childSessionId) } catch { /* 能力已撤销，停止失败不恢复权限。 */ }
      }
    },
    /** 父运行收尾撤销授权并停止全部活动子任务。 */
    dispose(): void { this.cancelAll(); disposed = true },
  }
}
