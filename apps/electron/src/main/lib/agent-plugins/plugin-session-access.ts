import type { AgentSessionModulePolicy } from '@dutydeck/shared'

/** 主进程核验的当前模块包身份，不接受模型或 renderer 声明。 */
export interface PluginModuleIdentity {
  moduleId: string
  moduleVersion: string
  packageHash: string
}

/** Surface 写操作需要持续有效的会话附着身份。 */
export function isPluginModuleAttached(module: PluginModuleIdentity, policy: AgentSessionModulePolicy): boolean {
  if (policy.disabledModuleIds.includes(module.moduleId) || !policy.enabledModuleIds.includes(module.moduleId)) return false
  const binding = policy.moduleBindings?.find(item => item.moduleId === module.moduleId)
  return binding?.moduleVersion === module.moduleVersion && binding.packageHash === module.packageHash
}
