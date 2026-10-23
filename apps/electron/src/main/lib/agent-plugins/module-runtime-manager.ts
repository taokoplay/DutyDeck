import type { ToolDefinition } from '@earendil-works/pi-coding-agent'
import type { PluginHealth, PluginV3Manifest, PluginV3Surface } from '@dutydeck/plugin-sdk'
import type { AgentPluginRegistry } from '../agent-modules/plugin-registry'
import {
  ContributionRegistry,
  type RegisteredPluginTool,
} from './contribution-registry'
import { projectRuntimePluginModules } from './runtime-module-projection'
import {
  createPluginRuntimeSnapshot,
  type PluginRuntimeHealth,
  type PluginRuntimeSnapshot,
  type PluginRuntimeToolContext,
} from './runtime-supervisor'
import {
  SurfaceRegistry,
  type AuthorizedPluginSurfaceCall,
  type OpenPluginSurfaceContext,
  type OpenPluginSurfaceInput,
} from './surface-registry'
import { buildPluginToolProxies, type PluginToolProxyContext } from './tool-proxy'

/** Supervisor 的最小可替换接口，便于 manager 独立测试。 */
export interface ManagedRuntime {
  start(snapshot: PluginRuntimeSnapshot): Promise<PluginRuntimeHealth>
  invokeTool(input: {
    toolId: string
    input: unknown
    context: PluginRuntimeToolContext
    signal: AbortSignal
  }): Promise<unknown>
  invokeSurface?(input: {
    surfaceId: string
    moduleId: string
    method: string
    input: unknown
    sessionId: string
    projectId: string | null
    readOnly: boolean
    settingsRevision: number
    settings: Record<string, unknown>
    deadline: number
    signal: AbortSignal
  }): Promise<unknown>
  stop(): Promise<void>
}

/** 一个 V3 插件在宿主中的注册记录。 */
export interface ManagedRuntimePlugin {
  manifest: PluginV3Manifest
  packageHash: string
  packageRoot: string
  prompts: Record<string, string>
  settingsRevision?: number
  settings?: Record<string, unknown>
}

/** Manager 依赖。 */
export interface ModuleRuntimeManagerOptions {
  moduleRegistry: AgentPluginRegistry
  createSupervisor: (plugin: ManagedRuntimePlugin) => ManagedRuntime
  onModulesChanged?: (modules: ReturnType<AgentPluginRegistry['listModules']>, prompts: ReturnType<AgentPluginRegistry['getPromptCatalog']>) => void
}

/** 单插件运行记录。 */
interface RuntimeEntry {
  plugin: ManagedRuntimePlugin
  supervisor: ManagedRuntime
  started?: Promise<PluginRuntimeHealth>
}

/** 把 V3 插件声明、运行实例、工具和 Surface 绑成一个宿主级管理器。 */
export class ModuleRuntimeManager {
  private readonly moduleRegistry: AgentPluginRegistry
  private readonly createSupervisor: ModuleRuntimeManagerOptions['createSupervisor']
  private readonly onModulesChanged: ModuleRuntimeManagerOptions['onModulesChanged']
  private readonly contributions = new ContributionRegistry()
  private readonly surfaces = new SurfaceRegistry()
  private readonly entries = new Map<string, RuntimeEntry>()

  constructor(options: ModuleRuntimeManagerOptions) {
    this.moduleRegistry = options.moduleRegistry
    this.createSupervisor = options.createSupervisor
    this.onModulesChanged = options.onModulesChanged
  }

  /** 注册已校验的 V3 插件；所有目录一起发布。 */
  register(plugin: ManagedRuntimePlugin): void {
    if (this.entries.has(plugin.manifest.id)) throw new Error('PLUGIN_RUNTIME_ALREADY_REGISTERED')
    const entry: RuntimeEntry = {
      plugin: structuredClone(plugin),
      supervisor: this.createSupervisor(plugin),
    }
    this.entries.set(plugin.manifest.id, entry)
    try {
      this.contributionRegistry().register({
        manifest: plugin.manifest,
        packageHash: plugin.packageHash,
      })
      this.surfaces.register({
        pluginId: plugin.manifest.id,
        pluginVersion: plugin.manifest.version,
        packageHash: plugin.packageHash,
        packageRoot: plugin.packageRoot,
        epoch: 1,
        surfaces: plugin.manifest.surfaces,
      })
      this.publishModules()
    } catch (error) {
      this.entries.delete(plugin.manifest.id)
      this.contributions.unregister(plugin.manifest.id)
      this.surfaces.unregister(plugin.manifest.id)
      this.publishModules()
      throw error
    }
  }

  /** 停用并移除插件全部可执行贡献。 */
  async unregister(pluginId: string): Promise<void> {
    const entry = this.entries.get(pluginId)
    if (!entry) return
    await entry.supervisor.stop()
    this.entries.delete(pluginId)
    this.contributions.unregister(pluginId)
    this.surfaces.unregister(pluginId)
    this.publishModules()
  }

  /** 返回插件声明的 Surface；不存在时 undefined。 */
  getSurface(surfaceId: string, moduleId: string): (PluginV3Surface & { pluginId: string }) | undefined {
    const contribution = this.contributions.contributionsForModules([moduleId]).surfaces.find(surface => surface.id === surfaceId)
    return contribution ? { ...contribution, pluginId: contribution.pluginId } : undefined
  }

  /** 打开插件 Surface token。 */
  openSurface(input: OpenPluginSurfaceInput): OpenPluginSurfaceContext {
    return this.surfaces.open(input)
  }

  /** 授权一次 Surface bridge 方法。 */
  authorizeSurface(token: string, method: string): AuthorizedPluginSurfaceCall {
    return this.surfaces.authorize(token, method)
  }

  /** 关闭 Surface token。 */
  closeSurface(token: string): void {
    this.surfaces.close(token)
  }

  /** 通过 Surface token 解析只读静态资源，不暴露包内其它目录。 */
  resolveSurfaceResource(token: string, path: string): string {
    return this.surfaces.resolveResource(token, path)
  }

  /**
   * 将已授权 Surface bridge 调用转发给所属 runtime。
   * @param input 当前 Session、Surface token、声明方法和业务参数。
   * @returns 插件 runtime 的 JSON 结果。
   */
  async invokeSurface(input: {
    sessionId: string
    token: string
    method: string
    input: unknown
    signal?: AbortSignal
  }): Promise<unknown> {
    const authorized = this.surfaces.authorize(input.token, input.method)
    if (authorized.sessionId !== input.sessionId) throw new Error('PLUGIN_SURFACE_SESSION_MISMATCH')
    await this.startPlugin(authorized.pluginId)
    const entry = this.entries.get(authorized.pluginId)
    if (!entry?.supervisor.invokeSurface) throw new Error('PLUGIN_SURFACE_RUNTIME_UNAVAILABLE')
    return entry.supervisor.invokeSurface({
      surfaceId: authorized.surfaceId,
      moduleId: authorized.moduleId,
      method: authorized.method,
      input: input.input,
      sessionId: authorized.sessionId,
      projectId: authorized.projectId,
      readOnly: authorized.readOnly,
      settingsRevision: entry.plugin.settingsRevision ?? 1,
      settings: structuredClone(entry.plugin.settings ?? {}),
      deadline: Date.now() + 10 * 60_000,
      signal: input.signal ?? new AbortController().signal,
    })
  }

  /** 为激活模块启动一次 runtime 并构造 Pi 工具闭包。 */
  async buildToolsForModules(input: {
    sdk: { defineTool(definition: ToolDefinition): ToolDefinition }
    moduleIds: readonly string[]
    context: PluginToolProxyContext
  }): Promise<ToolDefinition[]> {
    const moduleIds = [...new Set(input.moduleIds)]
    const tools = this.contributions.toolsForModules(moduleIds)
    if (tools.length === 0) return []
    const pluginIds = new Set(tools.map(tool => tool.pluginId))
    for (const pluginId of pluginIds) await this.startPlugin(pluginId)
    return buildPluginToolProxies({
      sdk: input.sdk,
      contributions: tools,
      context: input.context,
      invokeTool: (call) => this.invokeTool(call),
    })
  }

  /** 返回工具所属模块，供通用工具门禁使用。 */
  modulesForTool(agentName: string): string[] {
    const tool = this.contributions.getTool(agentName)
    return tool ? [tool.ownerModuleId] : []
  }

  /** 返回工具所属插件；未知工具返回 undefined。 */
  pluginForTool(agentName: string): string | undefined {
    return this.contributions.getToolOwner(agentName)
  }

  /** 停止全部 runtime；用于应用退出。 */
  async dispose(): Promise<void> {
    await Promise.all([...this.entries.values()].map(entry => entry.supervisor.stop()))
    for (const pluginId of this.entries.keys()) {
      this.contributions.unregister(pluginId)
      this.surfaces.unregister(pluginId)
    }
    this.entries.clear()
    this.publishModules()
  }

  /** 只启动一次插件 runtime，后续调用复用同一 Promise。 */
  private async startPlugin(pluginId: string): Promise<void> {
    const entry = this.entries.get(pluginId)
    if (!entry) throw new Error(`PLUGIN_RUNTIME_NOT_INSTALLED:${pluginId}`)
    if (!entry.started) {
      const manifest = entry.plugin.manifest
      entry.started = entry.supervisor.start(createPluginRuntimeSnapshot({
        pluginId: manifest.id,
        pluginVersion: manifest.version,
        packageHash: entry.plugin.packageHash,
        packageRoot: entry.plugin.packageRoot,
        runtimeEntry: manifest.runtime.entry,
        tools: manifest.tools.map(tool => tool.id),
        surfaces: manifest.surfaces.map(surface => surface.id),
        services: manifest.services.map(service => service.id),
        declaredModules: manifest.modules.map(module => ({
          id: module.id,
          version: manifest.version,
          activation: module.activation,
        })),
        settingsRevision: entry.plugin.settingsRevision ?? 1,
        settings: structuredClone(entry.plugin.settings ?? {}),
      }))
    }
    const health = await entry.started
    if (health.state !== 'running') throw new Error(health.errorCode ?? 'PLUGIN_RUNTIME_NOT_RUNNING')
  }

  /** 路由工具到所属 supervisor，不接受调用方指定插件。 */
  private async invokeTool(input: {
    toolId: string
    input: unknown
    context: PluginRuntimeToolContext
    signal: AbortSignal
  }): Promise<unknown> {
    const tool = this.contributions.getTool(
      this.contributions.toolsForModules([input.context.moduleId]).find(candidate => candidate.id === input.toolId)?.agentName ?? '',
    )
    if (!tool) throw new Error('PLUGIN_TOOL_NOT_FOUND')
    const entry = this.entries.get(tool.pluginId)
    if (!entry) throw new Error('PLUGIN_RUNTIME_NOT_INSTALLED')
    return entry.supervisor.invokeTool(input)
  }

  /** 重算所有已注册插件的模块与提示目录。 */
  private publishModules(): void {
    const modules = []
    const prompts: Record<string, string> = {}
    for (const entry of this.entries.values()) {
      const projection = projectRuntimePluginModules({
        manifest: entry.plugin.manifest,
        packageHash: entry.plugin.packageHash,
        prompts: entry.plugin.prompts,
      })
      modules.push(...projection.modules)
      Object.assign(prompts, projection.prompts)
    }
    this.moduleRegistry.setRuntimeModules(modules, prompts)
    this.onModulesChanged?.(this.moduleRegistry.listModules(), this.moduleRegistry.getPromptCatalog())
  }

  /** 以单例方式保留 contribution registry，避免插件之间覆盖。 */
  private contributionRegistry(): ContributionRegistry {
    return this.contributions
  }
}
