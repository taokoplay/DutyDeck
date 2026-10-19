import { realpathSync } from 'node:fs'
import type { AgentRunJournalEvent, AgentRunRecoveryInput, AgentRunRecoveryPlan, AgentRunRecoveryResult } from '@dutydeck/shared'
import type { AgentRunJournalStore } from './agent-run-journal'
import type { PiResumeContinuation } from './adapters/pi-exact-continuation'

/** 仅包含核验所需的会话身份；外部输入不能提供或替换 artifact 路径。 */
export interface RecoverySessionBinding {
  sdkSessionId?: string
  piSessionFile?: string
}

/** 主进程提供真实的会话/运行权限和 Pi 解析，不在恢复器中另建 Agent。 */
export interface AgentRunRecoveryDependencies {
  journal: AgentRunJournalStore
  isBusy: (sessionId: string) => boolean
  getSession: (sessionId: string) => RecoverySessionBinding | null
  validateContinuation: (expected: PiResumeContinuation) => void
  assertContextCurrent: (sessionId: string, events: readonly AgentRunJournalEvent[]) => void
  /** 放弃只收束关联命令；不得删除其他队列或改写历史消息。 */
  onAbandon?: (sessionId: string, events: readonly AgentRunJournalEvent[]) => void
}

/** 领取的原运行身份及精确 artifact 版本，只在可信主进程内传递。 */
export interface AgentRunContinuationContext extends PiResumeContinuation {
  runId: string
  agentSessionId: string
  events: AgentRunJournalEvent[]
}

/** 按 run+branch+sequence 做单次恢复领取；永不通过重发用户消息恢复。 */
export class AgentRunRecoveryService {
  /** 同步领取先于异步预检，防止重复点击或另一个 IPC 窗口并发派发。 */
  private readonly pending = new Set<string>()

  constructor(private readonly dependencies: AgentRunRecoveryDependencies) {}

  /** 返回最近二十个未完成运行，旧记录保留在 Journal；不调用模型或历史工具。 */
  list(sessionId: string): AgentRunRecoveryPlan[] {
    if (this.pending.has(sessionId) || this.dependencies.isBusy(sessionId)) return []
    return this.dependencies.journal.scanRecovery(sessionId).slice(-20).reverse().map((plan) => {
      try {
        this.requireContinuation(sessionId, plan)
        return { ...plan, availableActions: ['continue', 'abandon'] }
      } catch (error) {
        return { ...plan, availableActions: ['abandon'], continuationBlockedReason: recoveryReason(error) }
      }
    })
  }

  /** CAS 领取后立即返回接管回执；模型结果继续通过现有 Agent 流和 Journal 交付。 */
  apply(input: AgentRunRecoveryInput, start: (context: AgentRunContinuationContext) => Promise<void>): AgentRunRecoveryResult {
    if (!input || typeof input.sessionId !== 'string' || typeof input.runId !== 'string' || typeof input.branchId !== 'string'
      || !Number.isSafeInteger(input.lastSequence) || input.lastSequence < 1 || !['continue', 'abandon'].includes(input.operation)) {
      throw new Error('AGENT_RUN_RECOVERY_INPUT_INVALID')
    }
    if (this.pending.has(input.sessionId) || this.dependencies.isBusy(input.sessionId)) throw new Error('AGENT_RUN_RECOVERY_BUSY')
    const plan = this.dependencies.journal.scanRecovery(input.sessionId).find((candidate) => candidate.runId === input.runId)
    if (!plan || plan.branchId !== input.branchId || plan.lastSequence !== input.lastSequence) throw new Error('AGENT_RUN_RECOVERY_STALE')
    const events = this.dependencies.journal.read(input.sessionId).filter((event) => event.runId === input.runId)
    if (input.operation === 'abandon') {
      this.dependencies.onAbandon?.(input.sessionId, events)
      this.dependencies.journal.abandonRecovery(input.sessionId, input.runId, input.branchId, events)
      return { runId: input.runId, status: 'abandoned' }
    }
    const context = this.requireContinuation(input.sessionId, plan)
    this.dependencies.journal.append({ sessionId: input.sessionId, runId: input.runId, branchId: input.branchId, eventType: 'checkpoint', payload: { stage: 'recovery-claimed', expectedSequence: input.lastSequence }, idempotencyKey: `recovery-claim:${input.lastSequence}` })
    this.pending.add(input.sessionId)
    /** 即使准备阶段同步抛错，领取也保留为可审计失败，不重新派发。 */
    const recordFailure = (): void => {
      if (this.dependencies.journal.scanRecovery(input.sessionId).some((candidate) => candidate.runId === input.runId)) {
        this.dependencies.journal.append({ sessionId: input.sessionId, runId: input.runId, branchId: input.branchId, eventType: 'run_failed', payload: { errorCode: 'AGENT_RUN_RECOVERY_START_FAILED' }, idempotencyKey: `recovery-failed:${input.lastSequence}` })
      }
    }
    try {
      void start(context).catch(recordFailure).finally(() => this.pending.delete(input.sessionId))
    } catch {
      this.pending.delete(input.sessionId)
      recordFailure()
      throw new Error('AGENT_RUN_RECOVERY_START_FAILED')
    }
    return { runId: input.runId, status: 'accepted' }
  }

  /** 三份事实源、当前 Session 归属、工具配对、模块配置全部通过才签发续接。 */
  private requireContinuation(sessionId: string, plan: AgentRunRecoveryPlan): AgentRunContinuationContext {
    if (plan.reconciliation?.status !== 'matched' || plan.pendingEventId || plan.action !== 'resume') throw new Error('AGENT_RUN_RECOVERY_UNCONFIRMED')
    const events = this.dependencies.journal.read(sessionId).filter((event) => event.runId === plan.runId)
    if (events.some((event) => event.payload.stage === 'recovery-claimed')) throw new Error('AGENT_RUN_RECOVERY_ALREADY_CLAIMED')
    const binding = this.dependencies.journal.getPiBinding(sessionId, plan.runId)
    const session = this.dependencies.getSession(sessionId)
    if (!binding?.sessionFile || !binding.sessionId || !binding.branchTipId || !binding.artifactSha256
      || !session?.piSessionFile || session.sdkSessionId !== binding.sessionId || plan.branchId !== binding.sessionId
      || realpathSync(session.piSessionFile) !== realpathSync(binding.sessionFile)) throw new Error('AGENT_RUN_RECOVERY_SESSION_CHANGED')
    const context: AgentRunContinuationContext = { agentSessionId: sessionId, runId: plan.runId, events, expectedSessionFile: binding.sessionFile, sessionId: binding.sessionId, branchTipId: binding.branchTipId, artifactSha256: binding.artifactSha256 }
    this.dependencies.assertContextCurrent(sessionId, events)
    this.dependencies.validateContinuation(context)
    return context
  }
}

/** 将稳定失败分类为用户可理解的原因，避免将文件路径/供应商错误直接带到 UI。 */
function recoveryReason(error: unknown): string {
  const code = error instanceof Error ? error.message : ''
  if (code === 'AGENT_RUN_RECOVERY_ALREADY_CLAIMED') return '该运行已领取过续接，需保留记录并确认实际结果。'
  if (code === 'AGENT_RUN_RECOVERY_CONTEXT_CHANGED') return '模块或会话配置已经变化，请保留记录后开启新任务。'
  if (code === 'PI_CONTINUATION_UNSAFE_TAIL') return '历史已到达 assistant 边界，不能将其重新推理冒充原回合续接。'
  return '缺少可安全续接的完整事实，或仍有未确认的工具／权限结果。'
}
