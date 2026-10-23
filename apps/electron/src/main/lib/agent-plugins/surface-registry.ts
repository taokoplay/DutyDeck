import { randomUUID } from 'node:crypto'
import { isAbsolute, relative, resolve, sep } from 'node:path'
import type { PluginV3Surface } from '@dutydeck/plugin-sdk'

/** 一个插件版本的 Surface 注册信息。 */
export interface RegisteredPluginSurface {
  pluginId: string
  pluginVersion: string
  packageHash: string
  packageRoot: string
  epoch: number
  surfaces: PluginV3Surface[]
}

/** 打开 Surface 时由宿主绑定可信页面上下文。 */
export interface OpenPluginSurfaceInput {
  surfaceId: string
  moduleId: string
  sessionId: string
  projectId: string | null
  readOnly: boolean
}

/** Surface token 对应的只读上下文。 */
export interface OpenPluginSurfaceContext extends OpenPluginSurfaceInput {
  token: string
  pluginId: string
  pluginVersion: string
  packageHash: string
  epoch: number
}

/** 已授权 Surface bridge 调用。 */
export interface AuthorizedPluginSurfaceCall extends OpenPluginSurfaceContext {
  method: string
  entry: string
}

/** Surface 注册依赖。 */
export interface SurfaceRegistryOptions {
  uuid?: () => string
}

/** 创建稳定的 Surface 授权错误。 */
class SurfaceRegistryError extends Error {
  constructor(readonly code: string) {
    super(code)
    this.name = 'SurfaceRegistryError'
  }
}

/** 管理插件 Surface 声明、打开 token 与 epoch 撤销。 */
export class SurfaceRegistry {
  private readonly uuid: () => string
  private readonly plugins = new Map<string, RegisteredPluginSurface>()
  private readonly contexts = new Map<string, OpenPluginSurfaceContext>()

  constructor(options: SurfaceRegistryOptions = {}) {
    this.uuid = options.uuid ?? randomUUID
  }

  /** 注册一个插件版本的 Surface 元数据。 */
  register(input: RegisteredPluginSurface): void {
    if (this.plugins.has(input.pluginId)) throw new SurfaceRegistryError('PLUGIN_SURFACE_ALREADY_REGISTERED')
    if (!Number.isSafeInteger(input.epoch) || input.epoch < 1) throw new SurfaceRegistryError('PLUGIN_SURFACE_EPOCH_INVALID')
    const ids = new Set<string>()
    for (const surface of input.surfaces) {
      if (ids.has(surface.id)) throw new SurfaceRegistryError('PLUGIN_SURFACE_ID_DUPLICATE')
      ids.add(surface.id)
      const entry = this.safeEntry(input.packageRoot, surface.entry)
      if (!entry) throw new SurfaceRegistryError('PLUGIN_SURFACE_ENTRY_INVALID')
    }
    this.plugins.set(input.pluginId, {
      ...structuredClone(input),
      surfaces: input.surfaces.map(surface => structuredClone(surface)),
    })
  }

  /** 从已注册插件中打开一个只属于当前 Session 的 Surface。 */
  open(input: OpenPluginSurfaceInput): OpenPluginSurfaceContext {
    const plugin = this.findSurface(input.surfaceId, input.moduleId)
    const context: OpenPluginSurfaceContext = {
      ...input,
      token: this.uuid(),
      pluginId: plugin.pluginId,
      pluginVersion: plugin.pluginVersion,
      packageHash: plugin.packageHash,
      epoch: plugin.epoch,
    }
    this.contexts.set(context.token, context)
    return { ...context }
  }

  /** 校验 token、epoch 和 Surface 方法白名单。 */
  authorize(token: string, method: string): AuthorizedPluginSurfaceCall {
    const context = this.contexts.get(token)
    if (!context) throw new SurfaceRegistryError('PLUGIN_SURFACE_DISCONNECTED')
    const plugin = this.plugins.get(context.pluginId)
    if (!plugin || plugin.epoch !== context.epoch || plugin.packageHash !== context.packageHash) {
      throw new SurfaceRegistryError('PLUGIN_SURFACE_VERSION_CHANGED')
    }
    const surface = plugin.surfaces.find(item => item.id === context.surfaceId)
    if (!surface) throw new SurfaceRegistryError('PLUGIN_SURFACE_NOT_FOUND')
    if (!surface.methods.includes(method)) throw new SurfaceRegistryError('PLUGIN_SURFACE_METHOD_NOT_DECLARED')
    const entry = this.safeEntry(plugin.packageRoot, surface.entry)
    if (!entry) throw new SurfaceRegistryError('PLUGIN_SURFACE_ENTRY_INVALID')
    return { ...context, method, entry }
  }

  /** 返回不包含文件路径的打开上下文。 */
  openContext(token: string): OpenPluginSurfaceContext {
    const context = this.contexts.get(token)
    if (!context) throw new SurfaceRegistryError('PLUGIN_SURFACE_DISCONNECTED')
    return { ...context }
  }

  /** 返回 Surface HTML 的真实入口，用于受控自定义协议。 */
  resolveEntry(token: string): string {
    const context = this.openContext(token)
    const plugin = this.plugins.get(context.pluginId)
    if (!plugin || plugin.epoch !== context.epoch) throw new SurfaceRegistryError('PLUGIN_SURFACE_VERSION_CHANGED')
    const surface = plugin.surfaces.find(item => item.id === context.surfaceId)
    const entry = surface ? this.safeEntry(plugin.packageRoot, surface.entry) : undefined
    if (!entry) throw new SurfaceRegistryError('PLUGIN_SURFACE_ENTRY_INVALID')
    return entry
  }

  /**
   * 解析 Surface 文档请求的静态子资源。
   * @param token 当前打开 Surface token。
   * @param path URL 中的包内相对路径。
   * @returns 仅位于 surfaces/ 下的真实候选路径。
   */
  resolveResource(token: string, path: string): string {
    const context = this.openContext(token)
    const plugin = this.plugins.get(context.pluginId)
    if (!plugin || plugin.epoch !== context.epoch) throw new SurfaceRegistryError('PLUGIN_SURFACE_VERSION_CHANGED')
    if (!path.startsWith('surfaces/')) throw new SurfaceRegistryError('PLUGIN_SURFACE_RESOURCE_DENIED')
    const resource = this.safeEntry(plugin.packageRoot, path)
    if (!resource) throw new SurfaceRegistryError('PLUGIN_SURFACE_RESOURCE_DENIED')
    return resource
  }

  /** 关闭 Surface 并废弃所有 pending bridge 调用的 token。 */
  close(token: string): void {
    this.contexts.delete(token)
  }

  /** 插件升级或 reload 后使旧 token 全部失效。 */
  rotateEpoch(pluginId: string, epoch: number): void {
    const plugin = this.plugins.get(pluginId)
    if (!plugin) throw new SurfaceRegistryError('PLUGIN_SURFACE_NOT_FOUND')
    plugin.epoch = epoch
  }

  /** 卸载后移除 Surface 与所有 token。 */
  unregister(pluginId: string): void {
    this.plugins.delete(pluginId)
    for (const [token, context] of this.contexts) {
      if (context.pluginId === pluginId) this.contexts.delete(token)
    }
  }

  /** 根据 surface 和模块找到唯一注册插件。 */
  private findSurface(surfaceId: string, moduleId: string): RegisteredPluginSurface {
    const matches = [...this.plugins.values()].filter(plugin => plugin.surfaces.some(surface =>
      surface.id === surfaceId && surface.ownerModuleId === moduleId))
    if (matches.length !== 1) throw new SurfaceRegistryError(matches.length ? 'PLUGIN_SURFACE_AMBIGUOUS' : 'PLUGIN_SURFACE_NOT_FOUND')
    return matches[0]!
  }

  /** 将入口限制在不可变包目录内，并拒绝绝对路径和父目录逃逸。 */
  private safeEntry(packageRoot: string, entry: string): string | undefined {
    if (isAbsolute(entry)) return undefined
    const root = resolve(packageRoot)
    const absolute = resolve(root, entry)
    const relation = relative(root, absolute)
    if (!relation || relation.startsWith(`..${sep}`) || relation === '..') return undefined
    return absolute
  }
}
