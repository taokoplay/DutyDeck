import type { AgentModuleManifest, AgentPluginDiagnostic, AgentPluginManifest } from '@dutydeck/shared'
import { loadAgentPluginManifests } from './plugin-manifest-loader'

/**
 * 统一插件注册表；内置模块先注册，第三方插件只能添加未占用的模块 ID。
 * 插件注册表不执行 JS，仅提供经过校验的声明给 Agent 能力解析器。
 */
export class AgentPluginRegistry {
  private readonly builtinModules = new Map<string, AgentModuleManifest>()
  private readonly plugins = new Map<string, AgentPluginManifest>()
  private readonly diagnostics: AgentPluginDiagnostic[] = []

  /** 注册内置模块，调用顺序固定且可重复。 */
  registerBuiltinModules(modules: readonly AgentModuleManifest[]): void {
    this.builtinModules.clear()
    for (const module of modules) this.builtinModules.set(module.id, cloneModule(module))
  }

  /** 读取受管插件目录；坏插件只进入诊断，不影响内置模块。 */
  loadInstalledPlugins(pluginRoot?: string): AgentPluginDiagnostic[] {
    this.plugins.clear()
    this.diagnostics.length = 0
    const loaded = loadAgentPluginManifests(pluginRoot)
    this.diagnostics.push(...loaded.diagnostics.filter((entry) => entry.status === 'rejected'))
    /** 全局预算只计已接纳插件，防止许多合法小清单无限增大启动快照。 */
    let moduleCount = 0
    let promptLength = 0
    for (const plugin of loaded.plugins) {
      const nextPromptLength = Object.values(plugin.prompts ?? {}).reduce((total, content) => total + content.length, 0)
      if (moduleCount + plugin.modules.length > 256 || promptLength + nextPromptLength > 512 * 1024) {
        this.diagnostics.push({ pluginId: plugin.id, path: 'plugin.json', status: 'rejected', warnings: [], errorCode: 'AGENT_PLUGIN_CATALOG_LIMIT_EXCEEDED' })
        continue
      }
      if (plugin.id.startsWith('builtin.') || this.plugins.has(plugin.id)) {
        this.diagnostics.push({ pluginId: plugin.id, path: 'plugin.json', status: 'rejected', warnings: [], errorCode: 'AGENT_PLUGIN_ID_DUPLICATE' })
        continue
      }
      const conflictingModule = plugin.modules.find((module) => this.builtinModules.has(module.id) || [...this.plugins.values()].some((registered) => registered.modules.some((candidate) => candidate.id === module.id)))
      if (conflictingModule) {
        this.diagnostics.push({ pluginId: plugin.id, path: 'plugin.json', status: 'rejected', warnings: [], errorCode: `AGENT_PLUGIN_MODULE_ID_CONFLICT:${conflictingModule.id}` })
        continue
      }
      const prompts = this.getPromptCatalog()
      if (Object.keys(plugin.prompts ?? {}).some((id) => Object.hasOwn(prompts, id))) {
        this.diagnostics.push({ pluginId: plugin.id, path: 'plugin.json', status: 'rejected', warnings: [], errorCode: 'AGENT_PLUGIN_PROMPT_ID_CONFLICT' })
        continue
      }
      this.plugins.set(plugin.id, clonePlugin(plugin))
      moduleCount += plugin.modules.length
      promptLength += nextPromptLength
      const diagnostic = loaded.diagnostics.find((entry) => entry.pluginId === plugin.id && entry.status === 'loaded')
      if (diagnostic) this.diagnostics.push(diagnostic)
    }
    return this.getDiagnostics()
  }

  /** 返回内置优先、插件按 manifest ID 稳定排序的模块目录。 */
  listModules(): AgentModuleManifest[] {
    const modules: AgentModuleManifest[] = [...this.builtinModules.values()].map((module) => ({ ...cloneModule(module), source: 'builtin' as const, pluginId: `builtin.${module.id}` }))
    for (const plugin of [...this.plugins.values()].sort((left, right) => left.id.localeCompare(right.id))) {
      modules.push(...plugin.modules.map((module) => ({ ...cloneModule(module), source: 'installed' as const, pluginId: plugin.id })))
    }
    return modules
  }

  /** 根据模块 ID查找宿主已注册模块，供命令总线复用。 */
  getModule(moduleId: string): AgentModuleManifest | undefined {
    const module = this.listModules().find((candidate) => candidate.id === moduleId)
    return module
  }

  /** 只发布已接纳插件声明的提示副本；拒绝或冲突插件不贡献内容。 */
  getPromptCatalog(): Record<string, string> {
    const prompts: Record<string, string> = {}
    for (const plugin of this.plugins.values()) Object.assign(prompts, plugin.prompts ?? {})
    return prompts
  }

  /** 返回已接纳清单副本，用于卸载时比较完整内容。 */
  getPlugin(pluginId: string): AgentPluginManifest | undefined {
    const plugin = this.plugins.get(pluginId)
    return plugin ? clonePlugin(plugin) : undefined
  }

  /** 返回插件健康诊断副本，供目录 UI 展示。 */
  getDiagnostics(): AgentPluginDiagnostic[] {
    return this.diagnostics.map((diagnostic) => ({ ...diagnostic, warnings: [...diagnostic.warnings] }))
  }
}

function cloneModule(module: AgentModuleManifest): AgentModuleManifest {
  return {
    ...module,
    contributions: [...module.contributions], skillRefs: [...module.skillRefs], promptRefs: [...module.promptRefs], toolRefs: [...module.toolRefs],
    artifactTypes: [...module.artifactTypes], surfaceIds: [...module.surfaceIds], requiredPermissions: [...module.requiredPermissions],
  }
}

function clonePlugin(plugin: AgentPluginManifest): AgentPluginManifest {
  return { ...plugin, modules: plugin.modules.map(cloneModule), entry: { ...plugin.entry }, ...(plugin.prompts ? { prompts: { ...plugin.prompts } } : {}) }
}
