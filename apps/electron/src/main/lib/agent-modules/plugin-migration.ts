import type { AgentPluginDiagnostic } from '@dutydeck/shared'

/**
 * 诊断旧插件 entry；manifest-only 之外的入口不执行、不迁移。
 * @param value 旧插件 manifest。
 * @returns 安全的加载诊断。
 */
export function diagnoseLegacyPluginEntry(value: unknown): AgentPluginDiagnostic | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const record = value as Record<string, unknown>
  const pluginId = typeof record.id === 'string' && record.id.trim() ? record.id.trim() : 'unknown'
  const entry = record.entry
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
    return { pluginId, path: 'plugin.json', status: 'rejected', warnings: [], errorCode: 'AGENT_PLUGIN_LEGACY_ENTRY_MISSING' }
  }
  const kind = (entry as Record<string, unknown>).kind
  if (kind === 'manifest-only') return null
  return { pluginId, path: 'plugin.json', status: 'rejected', warnings: [], errorCode: 'AGENT_PLUGIN_LEGACY_EXECUTABLE_ENTRY_UNSUPPORTED' }
}
