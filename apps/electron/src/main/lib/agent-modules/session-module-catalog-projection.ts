import type {
  AgentModuleManifest,
  AgentSessionModuleEntryState,
  AgentSessionModulePolicy,
  WorkspaceToolEntry,
} from '@dutydeck/shared'

/** 右侧菜单可直接打开的宿主面板；未知 surface 不进入 UI，避免伪造面板能力。 */
const HOST_SURFACES = new Set([
  'canvas',
  'visual-production',
  'interaction-design',
  'server-ops',
  'api-workbench',
  'capability-factory',
])

/** 判断宿主是否实现了模块声明的面板 surface。 */
export function isHostWorkspaceSurface(surfaceId: string): boolean {
  return HOST_SURFACES.has(surfaceId)
}

/** 读取模块在当前 Session 中的接入状态。 */
function resolveEntryState(module: AgentModuleManifest, policy: AgentSessionModulePolicy): { state: AgentSessionModuleEntryState; reason?: string } {
  if (module.activation !== 'session-toggle') return { state: 'unavailable', reason: '该模块仍需在消息中明确选择' }
  /** 禁用和身份变化都保留为可接入状态，右侧菜单必须能直接完成恢复。 */
  if (policy.disabledModuleIds.includes(module.id)) return { state: 'available', reason: '模块已被当前会话禁用，请重新接入' }
  if (policy.enabledModuleIds.includes(module.id)) {
    const binding = policy.moduleBindings?.find((candidate) => candidate.moduleId === module.id)
    if (binding && (binding.moduleVersion !== module.version || binding.packageHash !== module.packageHash)) {
      return { state: 'available', reason: '模块版本或包身份已变化，请重新接入' }
    }
    return { state: 'attached' }
  }
  return { state: 'available' }
}

/** 将可信模块清单投影成右侧工具条所需的最小目录。 */
export function projectAgentSessionModuleEntries(
  modules: readonly AgentModuleManifest[],
  policy: AgentSessionModulePolicy,
): WorkspaceToolEntry[] {
  return modules
    .flatMap((module) => {
      const surfaceId = module.surfaceIds.find((surface) => HOST_SURFACES.has(surface))
      if (!surfaceId) return []
      const { state, reason } = resolveEntryState(module, policy)
      return [{
        id: module.id,
        displayName: module.displayName,
        description: module.description,
        icon: module.icon,
        group: module.source === 'installed' ? '插件工具' as const : '专业工具' as const,
        surfaceId,
        moduleVersion: module.version,
        activation: module.activation ?? 'message-explicit',
        state,
        ...(module.source ? { source: module.source } : {}),
        ...(module.pluginId ? { pluginId: module.pluginId } : {}),
        ...(module.packageHash ? { packageHash: module.packageHash } : {}),
        ...(reason ? { reason } : {}),
      }]
    })
    .sort((left, right) => left.displayName.localeCompare(right.displayName, 'zh-Hans'))
}
