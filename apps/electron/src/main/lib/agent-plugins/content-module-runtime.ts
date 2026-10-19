import { getModuleId, getSkillId } from '@dutydeck/plugin-sdk'
import type { AgentModuleManifest } from '@dutydeck/shared'
import type { ContentPluginSnapshot } from './content-plugin-service'

/** 将已启用内容包投影成既有消息模块目录；不读取正文或声明任何新工具权限。 */
export function projectContentPluginModules(snapshot: ContentPluginSnapshot): AgentModuleManifest[] {
  return snapshot.plugins.filter(plugin => plugin.enabled).flatMap(plugin => plugin.manifest.modules.map(module => ({
    id: getModuleId(plugin.manifest.id, module.id), version: plugin.manifest.version, apiVersion: 1,
    displayName: module.displayName, description: plugin.manifest.description, icon: 'blocks', scope: 'session',
    contributions: [...(module.skills.length ? ['skill' as const] : []), ...(module.prompts.length || module.styles?.length ? ['prompt' as const] : [])],
    skillRefs: module.skills.map(id => getSkillId(plugin.manifest.id, id)),
    promptRefs: [...module.prompts.map(id => `${plugin.manifest.id}/prompts/${id}`), ...(module.styles ?? []).map(id => `${plugin.manifest.id}/styles/${id}`)],
    toolRefs: [], artifactTypes: [], surfaceIds: [], requiredPermissions: [], source: 'installed',
    pluginId: plugin.manifest.id, resourceSource: 'package', packageHash: plugin.packageHash,
  })))
}
