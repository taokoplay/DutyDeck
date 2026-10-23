/** 宿主可授予 V3 插件的最小能力集合；声明不代表授权。 */
export const PLUGIN_CAPABILITY_IDS = [
  'session.read',
  'project.files.read',
  'project.files.write',
  'project.changes.subscribe',
  'plugin.state.read',
  'plugin.state.write',
  'artifact.read',
  'artifact.write',
  'job.runtime',
  'agent.progress',
  'agent.delegate',
  'surface.emit',
  'http.request',
  'remote.execute',
  'media.catalog',
  'media.execute',
  'media.export',
] as const

/** V3 插件能力身份。 */
export type PluginCapabilityId = typeof PLUGIN_CAPABILITY_IDS[number]

/** 判断未知字符串是否属于当前宿主支持的能力。 */
export function isPluginCapabilityId(value: string): value is PluginCapabilityId {
  return (PLUGIN_CAPABILITY_IDS as readonly string[]).includes(value)
}

/** Runtime 向宿主发起能力调用时使用的通用信封。 */
export interface PluginCapabilityRequest {
  capability: PluginCapabilityId
  input: unknown
}

/** 能力返回值必须是 JSON 可序列化数据；大型内容使用 artifact 句柄。 */
export type PluginCapabilityResult<T = unknown> = {
  ok: true
  value: T
} | {
  ok: false
  code: string
  message: string
  retryable: boolean
}
