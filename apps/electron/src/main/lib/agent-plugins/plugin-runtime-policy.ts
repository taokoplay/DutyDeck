import type { PluginCapabilityId } from '@dutydeck/plugin-sdk'
import type { AgentToolApprovalPolicy } from '../agent-run-extensions'

/** 仅列出当前生产组合根真实接线的能力；未实现能力不因 manifest 声明而可用。 */
export const AVAILABLE_PLUGIN_CAPABILITIES: readonly PluginCapabilityId[] = [
  'session.read', 'plugin.state.read', 'plugin.state.write',
  'artifact.read', 'artifact.write', 'artifact.migrate', 'project.files.read',
]
/** 按名单组合既有媒体/内部策略，不让 automatic 覆盖插件逐次审批。 */
export function composePluginApprovalPolicy(pluginToolNames: readonly string[], sources: ReadonlyArray<{
  toolNames: readonly string[]
  toolApprovalPolicy?: AgentToolApprovalPolicy
}>): AgentToolApprovalPolicy {
  const plugins = new Set(pluginToolNames)
  return {
    getMode(name, input) {
      if (plugins.has(name)) return 'ask'
      const owners = sources.filter(source => source.toolNames.includes(name))
      if (!owners.length) return 'ask'
      return owners.every(source => source.toolApprovalPolicy?.getMode(name, input) === 'automatic') ? 'automatic' : 'ask'
    },
    subscribe(listener) {
      const releases = sources.flatMap(source => source.toolApprovalPolicy ? [source.toolApprovalPolicy.subscribe(listener)] : [])
      return () => { for (const release of releases) release() }
    },
  }
}

const READ_CAPABILITIES: readonly PluginCapabilityId[] = ['session.read', 'plugin.state.read', 'artifact.read', 'project.files.read']

/** 只读按正向名单准入；未知能力和迁移操作不能漏过写门禁。 */
export function assertPluginCapabilityPolicy(capability: PluginCapabilityId, readOnly: boolean): void {
  if (!AVAILABLE_PLUGIN_CAPABILITIES.includes(capability)) throw new Error('PLUGIN_CAPABILITY_NOT_AVAILABLE')
  if (readOnly && !READ_CAPABILITIES.includes(capability)) throw new Error('PLUGIN_CAPABILITY_READ_ONLY')
}
