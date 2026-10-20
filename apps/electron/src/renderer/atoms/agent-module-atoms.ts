import { atom } from 'jotai'
import { atomFamily } from 'jotai-family'
import type { AgentModuleManifest, AgentPluginHealth, AgentSessionModuleCatalog, AgentSessionModulePolicy } from '@dutydeck/shared'

/** 当前宿主注册的模块目录；加载失败时保持空列表并由组件显示错误态。 */
export const agentModulesAtom = atom<AgentModuleManifest[]>([])

/** 模块目录加载中的状态，避免组件重复发起 IPC。 */
export const agentModulesLoadingAtom = atom(false)

/** 模块目录最近一次加载错误。 */
export const agentModulesErrorAtom = atom<string | null>(null)

/** Plugin Host 生命周期健康快照；模块目录仍由 manifest 投影驱动。 */
export const agentPluginHealthAtom = atom<AgentPluginHealth[]>([])

/** 按 Session 保存模块策略投影；策略事实仍由主进程持久化。 */
export const agentSessionModulePolicyAtomFamily = atomFamily((sessionId: string) => atom<AgentSessionModulePolicy | null>(null))

/** 右侧菜单的 Session 模块目录；主进程返回的 revision 与策略保持一致。 */
export const agentSessionModuleCatalogAtomFamily = atomFamily((sessionId: string) => atom<AgentSessionModuleCatalog | null>(null))

/** 右侧目录的独立加载锁，不阻塞 AgentView 读取完整 Session 策略。 */
export const agentSessionModuleCatalogBusyAtomFamily = atomFamily((_sessionId: string) => atom(false))

/** 当前 Session 模块目录下拉层是否打开。 */
export const agentModulePickerOpenAtomFamily = atomFamily((sessionId: string) => atom(false))

/** 成功读取过目录（包括空目录），避免空列表导致反复请求。 */
export const agentModulesLoadedAtom = atom(false)

/** 会话独立的加载/保存状态，避免切换会话时共享请求状态。 */
export const agentModulePolicyBusyAtomFamily = atomFamily((_sessionId: string) => atom(false))

/** 会话策略保存/读取错误，绑定到对应 Session。 */
export const agentModulePolicyErrorAtomFamily = atomFamily((_sessionId: string) => atom<string | null>(null))

/** 右侧目录读取/接入错误独立保存，避免覆盖旧模块栏的策略错误。 */
export const agentSessionModuleCatalogErrorAtomFamily = atomFamily((_sessionId: string) => atom<string | null>(null))
