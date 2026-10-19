import type { AgentSessionModulePolicy } from '@dutydeck/shared'
import { normalizeAgentSessionModulePolicy } from '@dutydeck/shared'

export interface UpdateSessionModulePolicyOptions {
  /** 用于防止并发更新覆盖较新的策略版本。 */
  expectedRevision?: number
  /** 测试或迁移时固定写入时间。 */
  now?: number
}

/**
 * 计算下一份 Session 模块策略；该函数不触碰 Electron 或文件系统，便于可靠测试。
 * @param current 当前已持久化策略；旧会话可传 undefined。
 * @param requested 用户请求的策略字段。
 * @param options revision 条件和更新时间。
 * @returns revision 递增且数组已规范化的新策略。
 */
export function buildNextSessionModulePolicy(
  current: AgentSessionModulePolicy | undefined,
  requested: Partial<AgentSessionModulePolicy>,
  options: UpdateSessionModulePolicyOptions = {},
): AgentSessionModulePolicy {
  const now = options.now ?? Date.now()
  const normalizedCurrent = normalizeAgentSessionModulePolicy(current, now)
  if (options.expectedRevision !== undefined && options.expectedRevision !== normalizedCurrent.revision) {
    throw new Error('AGENT_MODULE_POLICY_REVISION_CONFLICT')
  }
  const requestedBase = normalizeAgentSessionModulePolicy({ ...normalizedCurrent, ...requested }, now)
  return {
    ...requestedBase,
    revision: normalizedCurrent.revision + 1,
    updatedAt: now,
  }
}
