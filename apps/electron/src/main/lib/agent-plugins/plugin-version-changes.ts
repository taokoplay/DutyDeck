import type { PluginV3Manifest } from '@dutydeck/plugin-sdk'
import type { ModuleRuntimePluginChanges } from '@dutydeck/shared'

/** 只比较可信包清单。不扫描用户项目，也不把相同声明推断为数据兼容。 */
export function pluginVersionChanges(previous: { manifest: PluginV3Manifest; packageHash: string } | undefined, next: PluginV3Manifest): ModuleRuntimePluginChanges {
  const before = previous?.manifest
  const artifactIds = [...new Set([...(before?.artifacts ?? []).map(item => item.id), ...next.artifacts.map(item => item.id)])]
  const artifacts = artifactIds.map(id => ({ id, fromSchema: before?.artifacts.find(item => item.id === id)?.schemaVersion ?? null, toSchema: next.artifacts.find(item => item.id === id)?.schemaVersion ?? null }))
    .filter(item => item.fromSchema !== item.toSchema)
  const settingsKeys = [...new Set([...(before?.settings ?? []).map(item => item.key), ...next.settings.map(item => item.key)])]
  return {
    previousPackageHash: previous?.packageHash ?? null,
    capabilitiesAdded: next.capabilities.filter(item => !before?.capabilities.includes(item)),
    capabilitiesRemoved: before?.capabilities.filter(item => !next.capabilities.includes(item)) ?? [],
    settingsChanged: settingsKeys.filter(key => JSON.stringify(before?.settings.find(item => item.key === key)) !== JSON.stringify(next.settings.find(item => item.key === key))),
    artifacts,
    runtimeContractChanged: Boolean(before && before.compatibility.runtimeProtocol !== next.compatibility.runtimeProtocol),
    dataCompatibility: 'unknown',
    // 未提供逆向迁移合同；即使提高包版本号也不能暗中降低同一产物schema。
    blockers: [
      ...(artifacts.some(item => item.fromSchema !== null && item.toSchema !== null && item.toSchema < item.fromSchema) ? ['PLUGIN_ARTIFACT_SCHEMA_DOWNGRADE'] : []),
      ...(artifacts.some(item => item.fromSchema !== null && item.toSchema === null) ? ['PLUGIN_ARTIFACT_REMOVAL_UNSUPPORTED'] : []),
    ],
  }
}
