import type { createStore } from 'jotai'
import type { AgentModuleManifest, AgentPluginHealth, AgentSessionModulePolicy, AgentSessionModulePolicyUpdateInput } from '@dutydeck/shared'
import {
  agentModulesAtom, agentModulesLoadedAtom, agentModulesLoadingAtom, agentModulesErrorAtom,
  agentPluginHealthAtom, agentSessionModulePolicyAtomFamily, agentModulePolicyBusyAtomFamily,
  agentModulePolicyErrorAtomFamily,
} from '@/atoms/agent-module-atoms'

/** 仅策略与目录 IPC；刻意不提供命令/Skill 执行入口。 */
export interface AgentModuleLoaderAPI {
  getAgentModules(): Promise<AgentModuleManifest[]>
  getAgentPluginHealth(): Promise<AgentPluginHealth[]>
  getSessionModulePolicy(sessionId: string): Promise<AgentSessionModulePolicy>
  setSessionModulePolicy(input: AgentSessionModulePolicyUpdateInput): Promise<AgentSessionModulePolicy>
}

/** Store 生命周期持有请求结果，不因 React Effect 重跑而丢弃全局目录；失败可显式重试。 */
export async function loadAgentModuleCatalog(store: ReturnType<typeof createStore>, api: AgentModuleLoaderAPI): Promise<void> {
  if (store.get(agentModulesLoadedAtom) || store.get(agentModulesLoadingAtom)) return
  store.set(agentModulesLoadingAtom, true)
  store.set(agentModulesErrorAtom, null)
  try {
    /** 两份宿主快照一起发布，防止目录与健康显示半次加载。 */
    const [modules, health] = await Promise.all([api.getAgentModules(), api.getAgentPluginHealth()])
    store.set(agentModulesAtom, modules)
    store.set(agentPluginHealthAtom, health)
    store.set(agentModulesLoadedAtom, true)
  } catch (cause) {
    store.set(agentModulesErrorAtom, cause instanceof Error ? cause.message : String(cause))
  } finally {
    store.set(agentModulesLoadingAtom, false)
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
