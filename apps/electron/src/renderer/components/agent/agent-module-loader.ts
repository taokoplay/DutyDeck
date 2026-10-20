import type { createStore } from 'jotai'
import type { AgentModuleManifest, AgentPluginHealth, AgentSessionModuleCatalog, AgentSessionModulePolicy, AgentSessionModulePolicyUpdateInput, AgentSessionModuleToggleInput } from '@dutydeck/shared'
import {
  agentModulesAtom, agentModulesLoadedAtom, agentModulesLoadingAtom, agentModulesErrorAtom,
  agentPluginHealthAtom, agentSessionModulePolicyAtomFamily, agentModulePolicyBusyAtomFamily,
  agentModulePolicyErrorAtomFamily, agentSessionModuleCatalogAtomFamily, agentSessionModuleCatalogBusyAtomFamily,
  agentSessionModuleCatalogErrorAtomFamily,
} from '@/atoms/agent-module-atoms'

/** 仅策略与目录 IPC；刻意不提供命令/Skill 执行入口。 */
export interface AgentModuleLoaderAPI {
  getAgentModules(): Promise<AgentModuleManifest[]>
  getAgentPluginHealth(): Promise<AgentPluginHealth[]>
  getSessionModulePolicy(sessionId: string): Promise<AgentSessionModulePolicy>
  setSessionModulePolicy(input: AgentSessionModulePolicyUpdateInput): Promise<AgentSessionModulePolicy>
  getSessionModuleCatalog?(sessionId: string): Promise<AgentSessionModuleCatalog>
  toggleSessionModule?(input: AgentSessionModuleToggleInput): Promise<AgentSessionModuleCatalog>
}

/** 每个 Store 的目录请求代次，插件变更后丢弃旧请求。 */
const catalogGenerations = new WeakMap<ReturnType<typeof createStore>, number>()
/** 每个 Store/Session 的目录请求代次，插件切换或快速导航时丢弃迟到结果。 */
const sessionCatalogGenerations = new WeakMap<ReturnType<typeof createStore>, Map<string, number>>()

/** Store 生命周期持有请求结果，不因 React Effect 重跑而丢弃全局目录；失败可显式重试。 */
export async function loadAgentModuleCatalog(store: ReturnType<typeof createStore>, api: AgentModuleLoaderAPI, force = false): Promise<void> {
  if (!force && (store.get(agentModulesLoadedAtom) || store.get(agentModulesLoadingAtom))) return
  /** 强制刷新独立递增代次，旧请求不得覆盖新目录。 */
  const generation = (catalogGenerations.get(store) ?? 0) + 1
  catalogGenerations.set(store, generation)
  store.set(agentModulesLoadingAtom, true)
  store.set(agentModulesErrorAtom, null)
  try {
    /** 两份宿主快照一起发布，防止目录与健康显示半次加载。 */
    const [modules, health] = await Promise.all([api.getAgentModules(), api.getAgentPluginHealth()])
    if (catalogGenerations.get(store) !== generation) return
    store.set(agentModulesAtom, modules)
    store.set(agentPluginHealthAtom, health)
    store.set(agentModulesLoadedAtom, true)
  } catch (cause) {
    if (catalogGenerations.get(store) !== generation) return
    store.set(agentModulesErrorAtom, cause instanceof Error ? cause.message : String(cause))
  } finally {
    if (catalogGenerations.get(store) === generation) store.set(agentModulesLoadingAtom, false)
  }
}

/** 每次进入会话重读策略；所有迟到结果仍写入请求开始时的会话 atom。 */
export async function loadAgentModulePolicy(store: ReturnType<typeof createStore>, api: AgentModuleLoaderAPI, sessionId: string): Promise<void> {
  /** 请求期间禁止同一会话重复加载或保存。 */
  const busyAtom = agentModulePolicyBusyAtomFamily(sessionId)
  /** 错误和策略都以显式会话标识绑定。 */
  const errorAtom = agentModulePolicyErrorAtomFamily(sessionId)
  if (store.get(busyAtom)) return
  store.set(busyAtom, true)
  store.set(errorAtom, null)
  try {
    /** 持久化策略是事实源，目录缓存不影响本次读取。 */
    const policy = await api.getSessionModulePolicy(sessionId)
    store.set(agentSessionModulePolicyAtomFamily(sessionId), policy)
  } catch (cause) {
    store.set(agentSessionModulePolicyAtomFamily(sessionId), null)
    store.set(errorAtom, cause instanceof Error ? cause.message : String(cause))
  } finally {
    store.set(busyAtom, false)
  }
}

/** 读取当前 Session 的右侧模块目录，目录和策略绑定到同一 session。 */
export async function loadAgentSessionModuleCatalog(
  store: ReturnType<typeof createStore>,
  api: AgentModuleLoaderAPI,
  sessionId: string,
  force = false,
): Promise<void> {
  const busyAtom = agentSessionModuleCatalogBusyAtomFamily(sessionId)
  const errorAtom = agentSessionModuleCatalogErrorAtomFamily(sessionId)
  if ((store.get(busyAtom) && !force) || !api.getSessionModuleCatalog) return
  const generations = sessionCatalogGenerations.get(store) ?? new Map<string, number>()
  const generation = (generations.get(sessionId) ?? 0) + 1
  generations.set(sessionId, generation)
  sessionCatalogGenerations.set(store, generations)
  store.set(busyAtom, true)
  store.set(errorAtom, null)
  try {
    const catalog = await api.getSessionModuleCatalog(sessionId)
    if (sessionCatalogGenerations.get(store)?.get(sessionId) !== generation) return
    store.set(agentSessionModuleCatalogAtomFamily(sessionId), catalog)
    store.set(agentSessionModulePolicyAtomFamily(sessionId), catalog.policy)
  } catch (cause) {
    if (sessionCatalogGenerations.get(store)?.get(sessionId) !== generation) return
    store.set(agentSessionModuleCatalogAtomFamily(sessionId), null)
    store.set(errorAtom, cause instanceof Error ? cause.message : String(cause))
  } finally {
    if (sessionCatalogGenerations.get(store)?.get(sessionId) === generation) store.set(busyAtom, false)
  }
}

/** 右侧菜单原子接入或移除模块；面板打开/关闭由调用方管理。 */
export async function setAgentModuleAttachment(
  store: ReturnType<typeof createStore>,
  api: AgentModuleLoaderAPI,
  sessionId: string,
  moduleId: string,
  enabled: boolean,
): Promise<AgentSessionModuleCatalog | null> {
  const catalog = store.get(agentSessionModuleCatalogAtomFamily(sessionId))
  if (!catalog) return null
  if (store.get(agentSessionModuleCatalogBusyAtomFamily(sessionId))) return null
  const entry = catalog?.entries.find((candidate) => candidate.id === moduleId)
  if (!entry || entry.state === 'unavailable' || !api.toggleSessionModule) return null
  const busyAtom = agentModulePolicyBusyAtomFamily(sessionId)
  const errorAtom = agentSessionModuleCatalogErrorAtomFamily(sessionId)
  if (store.get(busyAtom)) return null
  store.set(busyAtom, true)
  store.set(errorAtom, null)
  try {
    const next = await api.toggleSessionModule({
      sessionId,
      moduleId,
      enabled,
      expectedRevision: catalog.revision,
    })
    store.set(agentSessionModuleCatalogAtomFamily(sessionId), next)
    store.set(agentSessionModulePolicyAtomFamily(sessionId), next.policy)
    return next
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause)
    store.set(errorAtom, message)
    /** CAS 失败说明另一个窗口已提交新 revision，立即刷新目录让下一次点击可继续。 */
    if (message === 'AGENT_MODULE_POLICY_REVISION_CONFLICT') {
      await loadAgentSessionModuleCatalog(store, api, sessionId, true)
    }
    return null
  } finally {
    store.set(busyAtom, false)
  }
}

/** 点击右侧模块时接入当前 Session。 */
export function attachAgentModule(
  store: ReturnType<typeof createStore>,
  api: AgentModuleLoaderAPI,
  sessionId: string,
  moduleId: string,
): Promise<AgentSessionModuleCatalog | null> {
  return setAgentModuleAttachment(store, api, sessionId, moduleId, true)
}

/** 从当前 Session 移除模块，不改变右侧面板的历史布局。 */
export function detachAgentModule(
  store: ReturnType<typeof createStore>,
  api: AgentModuleLoaderAPI,
  sessionId: string,
  moduleId: string,
): Promise<AgentSessionModuleCatalog | null> {
  return setAgentModuleAttachment(store, api, sessionId, moduleId, false)
}

/** 切换一个模块的会话策略，返回保存完成；不发送消息、不执行模块动作。 */
export async function toggleAgentModule(store: ReturnType<typeof createStore>, api: AgentModuleLoaderAPI, sessionId: string, moduleId: string): Promise<void> {
  /** 捕获会话 atom，避免异步完成时写入新选中的会话。 */
  const policyAtom = agentSessionModulePolicyAtomFamily(sessionId)
  /** 同会话串行提交，防止快速点击产生相同 revision 的竞争写入。 */
  const busyAtom = agentModulePolicyBusyAtomFamily(sessionId)
  /** 保存错误仅显示在对应会话。 */
  const errorAtom = agentModulePolicyErrorAtomFamily(sessionId)
  /** 当前服务端策略及显式禁用优先级。 */
  const policy = store.get(policyAtom)
  if (!policy || store.get(busyAtom)) return
  const enabled = policy.enabledModuleIds.includes(moduleId) && !policy.disabledModuleIds.includes(moduleId)
  /** 移除目标旧状态后再写入新状态，确保启用与禁用集合不矛盾。 */
  const enabledModuleIds = policy.enabledModuleIds.filter((id) => id !== moduleId)
  const disabledModuleIds = policy.disabledModuleIds.filter((id) => id !== moduleId)
  const pinnedModuleIds = policy.pinnedModuleIds.filter((id) => id !== moduleId)
  if (enabled) disabledModuleIds.push(moduleId)
  else { enabledModuleIds.push(moduleId); pinnedModuleIds.push(moduleId) }
  store.set(busyAtom, true)
  store.set(errorAtom, null)
  try {
    /** 仅提交策略 CAS，由主进程持久化。 */
    const next = await api.setSessionModulePolicy({
      sessionId, expectedRevision: policy.revision,
      policy: { mode: pinnedModuleIds.length > 0 ? 'pinned' : 'auto', enabledModuleIds, disabledModuleIds, pinnedModuleIds },
    })
    store.set(policyAtom, next)
  } catch (cause) {
    store.set(errorAtom, cause instanceof Error ? cause.message : String(cause))
  } finally {
    store.set(busyAtom, false)
  }
}
