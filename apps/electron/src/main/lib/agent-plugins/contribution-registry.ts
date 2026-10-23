import type {
  PluginV3Artifact,
  PluginV3Manifest,
  PluginV3Service,
  PluginV3Surface,
  PluginV3Tool,
} from '@dutydeck/plugin-sdk'

/** 一个插件版本注册到宿主的不可变贡献集合。 */
export interface RegisteredPluginContribution {
  manifest: PluginV3Manifest
  packageHash: string
}

/** 工具查询结果保留归属模块和签名声明。 */
export interface RegisteredPluginTool extends PluginV3Tool {
  pluginId: string
  pluginVersion: string
  packageHash: string
}

/** 模块级 Surface、服务和产物查询结果。 */
export interface RegisteredPluginModuleContribution {
  tools: RegisteredPluginTool[]
  surfaces: Array<PluginV3Surface & { pluginId: string; packageHash: string }>
  services: Array<PluginV3Service & { pluginId: string; packageHash: string }>
  artifacts: Array<PluginV3Artifact & { pluginId: string; packageHash: string }>
}

/** 校验并保存所有可执行贡献，拒绝跨插件工具名覆盖。 */
export class ContributionRegistry {
  private readonly plugins = new Map<string, RegisteredPluginContribution>()
  private readonly tools = new Map<string, RegisteredPluginTool>()

  /** 注册一个已解析的 V3 插件版本。 */
  register(input: RegisteredPluginContribution): void {
    if (this.plugins.has(input.manifest.id)) throw new Error('PLUGIN_CONTRIBUTION_ALREADY_REGISTERED')
    for (const tool of input.manifest.tools) {
      if (this.tools.has(tool.agentName)) throw new Error('PLUGIN_TOOL_NAME_CONFLICT')
    }
    const contribution: RegisteredPluginContribution = {
      manifest: structuredClone(input.manifest),
      packageHash: input.packageHash,
    }
    const pluginId = contribution.manifest.id
    const pluginVersion = contribution.manifest.version
    this.plugins.set(pluginId, contribution)
    for (const tool of contribution.manifest.tools) {
      this.tools.set(tool.agentName, {
        ...structuredClone(tool),
        pluginId,
        pluginVersion,
        packageHash: contribution.packageHash,
      })
    }
  }

  /** 移除插件全部工具映射；其它插件保持不变。 */
  unregister(pluginId: string): void {
    const plugin = this.plugins.get(pluginId)
    if (!plugin) return
    for (const tool of plugin.manifest.tools) this.tools.delete(tool.agentName)
    this.plugins.delete(pluginId)
  }

  /** 返回激活模块所属工具，顺序按 Agent 工具名稳定排序。 */
  toolsForModules(moduleIds: readonly string[]): RegisteredPluginTool[] {
    const active = new Set(moduleIds)
    return [...this.tools.values()]
      .filter(tool => active.has(tool.ownerModuleId))
      .sort((left, right) => left.agentName.localeCompare(right.agentName))
  }

  /** 返回激活模块的 Surface/服务/产物声明。 */
  contributionsForModules(moduleIds: readonly string[]): RegisteredPluginModuleContribution {
    const active = new Set(moduleIds)
    const result: RegisteredPluginModuleContribution = { tools: [], surfaces: [], services: [], artifacts: [] }
    for (const plugin of this.plugins.values()) {
      result.tools.push(...plugin.manifest.tools
        .filter(tool => active.has(tool.ownerModuleId))
        .map(tool => ({ ...structuredClone(tool), pluginId: plugin.manifest.id, pluginVersion: plugin.manifest.version, packageHash: plugin.packageHash })))
      result.surfaces.push(...plugin.manifest.surfaces
        .filter(surface => active.has(surface.ownerModuleId))
        .map(surface => ({ ...structuredClone(surface), pluginId: plugin.manifest.id, packageHash: plugin.packageHash })))
      result.services.push(...plugin.manifest.services
        .map(service => ({ ...structuredClone(service), pluginId: plugin.manifest.id, packageHash: plugin.packageHash })))
      result.artifacts.push(...plugin.manifest.artifacts
        .filter(artifact => active.has(artifact.ownerModuleId))
        .map(artifact => ({ ...structuredClone(artifact), pluginId: plugin.manifest.id, packageHash: plugin.packageHash })))
    }
    return result
  }

  /** 根据 Agent 工具名返回所属插件。 */
  getToolOwner(agentName: string): string | undefined {
    return this.tools.get(agentName)?.pluginId
  }

  /** 根据 Agent 工具名返回可信工具声明。 */
  getTool(agentName: string): RegisteredPluginTool | undefined {
    const tool = this.tools.get(agentName)
    return tool ? structuredClone(tool) : undefined
  }

  /** 返回当前注册快照，供诊断和测试使用。 */
  listPlugins(): RegisteredPluginContribution[] {
    return [...this.plugins.values()].map(plugin => structuredClone(plugin))
  }
}
