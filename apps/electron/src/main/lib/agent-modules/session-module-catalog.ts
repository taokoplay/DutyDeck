import type {
  AgentSessionModuleCatalog,
  AgentSessionModuleToggleInput,
  AgentSessionModulePolicy,
} from '@dutydeck/shared'
import type { UpdateSessionModulePolicyOptions } from './module-policy'
import type { AgentPluginRegistry } from './plugin-registry'
import { isHostWorkspaceSurface, projectAgentSessionModuleEntries } from './session-module-catalog-projection'

/** Session 策略读写边界；生产环境接入持久化 store，测试可使用内存实现。 */
export interface AgentSessionModulePolicyStore {
  get(sessionId: string, now?: number): AgentSessionModulePolicy
  update(sessionId: string, requested: Partial<AgentSessionModulePolicy>, options?: UpdateSessionModulePolicyOptions): AgentSessionModulePolicy
}

/** 将可信模块清单投影成右侧工具条所需的最小目录。 */
export function buildAgentSessionModuleCatalog(
  sessionId: string,
  registry: AgentPluginRegistry,
  policyStore: AgentSessionModulePolicyStore,
  now = Date.now(),
): AgentSessionModuleCatalog {
  const policy = policyStore.get(sessionId, now)
  const entries = projectAgentSessionModuleEntries(registry.listModules(), policy)
  return { sessionId, revision: policy.revision, policy, entries }
}

/** 原子切换 Session 模块；宿主在这里确认模块身份、激活模式和 revision。 */
export function toggleAgentSessionModule(
  input: AgentSessionModuleToggleInput,
  registry: AgentPluginRegistry,
  policyStore: AgentSessionModulePolicyStore,
  now = Date.now(),
): AgentSessionModuleCatalog {
  const module = registry.getModule(input.moduleId)
  if (!module) throw new Error('AGENT_MODULE_NOT_AVAILABLE')
  if (module.activation !== 'session-toggle') throw new Error('AGENT_MODULE_SESSION_TOGGLE_UNSUPPORTED')
  const surfaceId = module.surfaceIds.find(isHostWorkspaceSurface)
  if (!surfaceId) throw new Error('AGENT_MODULE_SURFACE_UNAVAILABLE')
  const current = policyStore.get(input.sessionId, now)
  if (input.expectedRevision !== undefined && input.expectedRevision !== current.revision) {
    throw new Error('AGENT_MODULE_POLICY_REVISION_CONFLICT')
  }
  const enabled = new Set(current.enabledModuleIds)
  const disabled = new Set(current.disabledModuleIds)
  const pinned = new Set(current.pinnedModuleIds)
  const bindings = new Map((current.moduleBindings ?? []).map((binding) => [binding.moduleId, binding]))
  enabled.delete(input.moduleId)
  disabled.delete(input.moduleId)
  pinned.delete(input.moduleId)
  bindings.delete(input.moduleId)
  if (input.enabled) {
    enabled.add(input.moduleId)
    pinned.add(input.moduleId)
    bindings.set(input.moduleId, {
      moduleId: module.id,
      moduleVersion: module.version,
      ...(module.packageHash ? { packageHash: module.packageHash } : {}),
    })
  }
  policyStore.update(input.sessionId, {
    mode: pinned.size > 0 ? 'pinned' : 'auto',
    enabledModuleIds: [...enabled],
    disabledModuleIds: [...disabled],
    pinnedModuleIds: [...pinned],
    moduleBindings: [...bindings.values()],
  }, { expectedRevision: current.revision, now })
  return buildAgentSessionModuleCatalog(input.sessionId, registry, policyStore, now)
}
