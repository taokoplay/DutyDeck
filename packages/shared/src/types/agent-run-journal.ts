/** Agent 运行日志的跨进程可序列化合同。 */

export type AgentRunJournalEventType =
  | 'user_turn'
  | 'assistant_turn'
  | 'tool_started'
  | 'tool_result'
  | 'permission_requested'
  | 'permission_resolved'
  | 'checkpoint'
  | 'run_completed'
  | 'run_failed'
  | 'run_stopped'

export type AgentRunRecoveryAction = 'resume' | 'confirm' | 'abandon'

export interface AgentRunJournalEvent {
  runId: string
  branchId: string
  sequence: number
  eventId: string
  eventType: AgentRunJournalEventType
  parentEventId?: string
  commandId?: string
  idempotencyKey?: string
  payload: Record<string, unknown>
  createdAt: number
}

/** 展示 JSONL 一次追加写入的可核对摘要；不保存消息正文或工具参数。 */
export interface AgentRunJournalDisplayBinding {
  fileIdentity?: { dev: number; ino: number }
  byteOffset: number
  byteLength: number
  messages: Array<{ uuid: string; sha256: string }>
}

/** Pi artifact 当前分支的可核对身份；entry id 只作为定位，不携带正文。 */
export interface AgentRunJournalPiBinding {
  sessionId?: string
  sessionFile?: string
  branchTipId?: string
  artifactSha256?: string
  entryBindings: Record<string, string>
}

/** 一次运行在两套事实源上的绑定快照。 */
export interface AgentRunJournalFactBinding {
  display?: AgentRunJournalDisplayBinding
  pi?: AgentRunJournalPiBinding
}

export type AgentRunReconciliationStatus = 'matched' | 'incomplete' | 'mismatch'

export interface AgentRunReconciliation {
  status: AgentRunReconciliationStatus
  reasons: string[]
}

export interface AgentRunRecoveryPlan {
  runId: string
  branchId: string
  lastSequence: number
  action: AgentRunRecoveryAction
  reason: string
  pendingEventId?: string
  moduleId?: string
  capabilityId?: string
  reconciliation?: AgentRunReconciliation
  /** 宿主根据实际 artifact 允许的动作；旧版本缺失时只能重新检查。 */
  availableActions?: AgentRunRecoveryOperation[]
  /** 不允许继续时的可读原因，不包含工具参数。 */
  continuationBlockedReason?: string
}

/** 精确续接不追加用户消息；放弃只终结指定运行并保留历史。 */
export type AgentRunRecoveryOperation = 'continue' | 'abandon'

/** Renderer 只能提交运行身份和 CAS 版本，不能提交 artifact 路径或提示词。 */
export interface AgentRunRecoveryInput {
  sessionId: string
  runId: string
  branchId: string
  lastSequence: number
  operation: AgentRunRecoveryOperation
}

/** 已接管不代表模型执行成功；真实终态仍由 Agent 事件与 Journal 提供。 */
export interface AgentRunRecoveryResult {
  runId: string
  status: 'accepted' | 'abandoned'
}
