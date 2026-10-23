import { atom } from 'jotai'

/** renderer 持有的已打开插件 Surface；token 只能来自 main。 */
export interface PluginSurfaceInstance {
  sessionId: string
  moduleId: string
  tabId: `plugin:${string}`
  surfaceId: string
  title: string
  token: string
  sourceUrl: string
  readOnly: boolean
}

/** 以动态 right-panel tab ID 为键保存 Surface。 */
export const pluginSurfaceInstancesAtom = atom<Record<string, PluginSurfaceInstance>>({})

/** 原子替换同一 Surface tab，旧实例只能由关闭流程显式撤销。 */
export function rememberPluginSurface(
  state: Readonly<Record<string, PluginSurfaceInstance>>,
  instance: PluginSurfaceInstance,
): Record<string, PluginSurfaceInstance> {
  return { ...state, [instance.tabId]: instance }
}

/** 从 renderer 状态移除 tab；main token 由关闭 IPC 独立撤销。 */
export function forgetPluginSurface(
  state: Readonly<Record<string, PluginSurfaceInstance>>,
  tabId: string,
): Record<string, PluginSurfaceInstance> {
  if (!Object.hasOwn(state, tabId)) return state as Record<string, PluginSurfaceInstance>
  const next = { ...state }
  delete next[tabId]
  return next
}
