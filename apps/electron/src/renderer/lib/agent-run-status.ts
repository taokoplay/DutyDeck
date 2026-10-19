export type AgentRunStatus = 'recovering' | 'queued' | 'running' | 'waiting_permission' | 'waiting_answer' | 'background_waiting' | 'completed' | 'failed' | 'stopping'

export interface AgentRunStatusInput {
  messagesLoaded: boolean
  messagesRefreshing: boolean
  streaming: boolean
  backgroundWaiting: boolean
  queuedCount: number
  waitingPermission: boolean
  waitingAnswer: boolean
  stopping: boolean
  hasError: boolean
  hasChannel: boolean
  hasModel: boolean
}

/** 按用户下一步动作优先级派生唯一会话状态，避免多个横幅互相覆盖。 */
export function deriveAgentRunStatus(input: AgentRunStatusInput): AgentRunStatus {
  if (input.stopping) return 'stopping'
  if (!input.messagesLoaded || input.messagesRefreshing) return 'recovering'
  if (input.waitingPermission) return 'waiting_permission'
  if (input.waitingAnswer) return 'waiting_answer'
  if (input.streaming) return 'running'
  if (input.queuedCount > 0) return 'queued'
  if (input.backgroundWaiting) return 'background_waiting'
  if (input.hasError || !input.hasChannel || !input.hasModel) return 'failed'
  return 'completed'
}
