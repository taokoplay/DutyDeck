import type { AgentModuleManifest } from '@dutydeck/shared'
import { getPluginRuntimeSurfaceId } from '@dutydeck/shared'
import type { PluginV3Manifest } from '@dutydeck/plugin-sdk'

/** 把 V3 插件模块投影到共享模块目录，同时携带可注入提示文本。 */
export interface RuntimePluginProjection {
  modules: AgentModuleManifest[]
  prompts: Record<string, string>
}

/** 投影输入只接受已签名/已校验清单和宿主读取的提示正文。 */
export interface ProjectRuntimePluginInput {
  manifest: PluginV3Manifest
  packageHash: string
  prompts: Readonly<Record<string, string>>
}

/**
 * 将 V3 模块、工具与 Surface 声明投影成现有 Session 目录合同。
 * 工具执行仍由 Contribution Registry 和 runtime supervisor 提供，不从字符串声明推导权限。
 * @param input 已校验 V3 清单、包 hash 和提示正文。
 * @returns 现有目录可消费的模块和提示目录。
 */
export function projectRuntimePluginModules(input: ProjectRuntimePluginInput): RuntimePluginProjection {
  const prompts: Record<string, string> = {}
  const promptIds = new Map<string, string>()
  for (const prompt of input.manifest.prompts) {
    const fullId = `${input.manifest.id}/prompts/${prompt.id}`
    const content = input.prompts[fullId]
    if (typeof content !== 'string' || !content.trim()) {
      throw new Error(`PLUGIN_PROMPT_UNAVAILABLE:${prompt.id}`)
    }
    promptIds.set(prompt.id, fullId)
    prompts[fullId] = content
  }
  const modules = input.manifest.modules.map((module): AgentModuleManifest => {
    const tools = input.manifest.tools.filter(tool => tool.ownerModuleId === module.id)
    const surfaces = input.manifest.surfaces.filter(surface => surface.ownerModuleId === module.id)
    const artifacts = input.manifest.artifacts.filter(artifact => artifact.ownerModuleId === module.id)
    return {
      id: module.id,
      version: input.manifest.version,
      apiVersion: 1,
      displayName: module.displayName,
      description: module.description,
      icon: module.icon,
      scope: module.scope ?? 'project',
      contributions: [
        ...(tools.length ? ['tool' as const] : []),
        ...(surfaces.length ? ['surface' as const] : []),
        ...(module.skillRefs.length ? ['skill' as const] : []),
        ...(module.promptRefs.length ? ['prompt' as const] : []),
        ...(artifacts.length ? ['artifact' as const] : []),
      ],
      skillRefs: module.skillRefs.map(ref => ref.id),
      promptRefs: module.promptRefs.map(id => promptIds.get(id) ?? id),
      toolRefs: tools.map(tool => tool.id),
      artifactTypes: artifacts.map(artifact => artifact.id),
      surfaceIds: surfaces.map(surface => getPluginRuntimeSurfaceId(input.manifest.id, surface.id)),
      requiredPermissions: [...input.manifest.capabilities],
      activation: module.activation,
      source: 'installed',
      pluginId: input.manifest.id,
      packageHash: input.packageHash,
    }
  })
  return { modules, prompts }
}
