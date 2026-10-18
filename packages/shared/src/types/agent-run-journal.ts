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

export interface AgentRunRecoveryPlan {
  runId: string
  branchId: string
  lastSequence: number
  action: AgentRunRecoveryAction
  reason: string
  pendingEventId?: string
  moduleId?: string
  capabilityId?: string
}
