import type { AgentSessionModulePolicy } from '@dutydeck/shared'
import { normalizeAgentSessionModulePolicy } from '@dutydeck/shared'
import { getAgentSessionMeta, updateAgentSessionMeta } from '../agent-session-manager'
import { buildNextSessionModulePolicy } from './module-policy'
import type { UpdateSessionModulePolicyOptions } from './module-policy'

export type { UpdateSessionModulePolicyOptions } from './module-policy'

/** 读取 Session 模块策略；旧会话统一返回可持久化的 auto 默认值。 */
export function getAgentSessionModulePolicy(sessionId: string, now = Date.now()): AgentSessionModulePolicy {
  const meta = getAgentSessionMeta(sessionId)
  if (!meta) throw new Error('AGENT_SESSION_NOT_FOUND')
  return normalizeAgentSessionModulePolicy(meta.modulePolicy, now)
}

/**
 * 原子更新 Session 模块策略并写回现有会话索引。
 * @param sessionId 目标 Agent Session。
 * @param requested 要更新的策略字段。
 * @param options 可选 revision 条件和测试时间。
 * @returns 已提交的模块策略。
 */
export function updateAgentSessionModulePolicy(
  sessionId: string,
  requested: Partial<AgentSessionModulePolicy>,
  options: UpdateSessionModulePolicyOptions = {},
): AgentSessionModulePolicy {
  const meta = getAgentSessionMeta(sessionId)
  if (!meta) throw new Error('AGENT_SESSION_NOT_FOUND')
  const next = buildNextSessionModulePolicy(meta.modulePolicy, requested, options)
  updateAgentSessionMeta(sessionId, { modulePolicy: next })
  return next
}
