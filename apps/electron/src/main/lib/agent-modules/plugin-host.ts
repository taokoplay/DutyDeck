import type { AgentPluginHealth, AgentPluginLifecycleState, AgentPluginManifest } from '@dutydeck/shared'
import { AgentPluginHostEventBus, type AgentPluginHostEventListener } from './plugin-host-events'

export interface AgentPluginHostContext {
  pluginId: string
  manifest: AgentPluginManifest
  sessionId?: string
}

export interface AgentPluginLifecycle {
  /** 注册宿主能力；不得直接获取 ipcMain、BrowserWindow 或未授权文件根。 */
  register?(context: AgentPluginHostContext): void | Promise<void>
  /** 启动插件级资源；重复调用必须幂等。 */
  start?(context: AgentPluginHostContext): void | Promise<void>
  /** 停止插件级资源；重复调用必须幂等。 */
  stop?(context: AgentPluginHostContext): void | Promise<void>
  /** 释放插件持有的监听器和缓存。 */
  dispose?(context: AgentPluginHostContext): void | Promise<void>
}

export interface AgentPluginHostRegistration {
  manifest: AgentPluginManifest
  lifecycle: AgentPluginLifecycle
}

interface PluginHostEntry {
  registration: AgentPluginHostRegistration
  context: AgentPluginHostContext
  health: AgentPluginHealth
  disposed: boolean
}

/**
 * 内置插件生命周期宿主。
 *
 * 第三方 manifest-only 插件没有 lifecycle，因此不会进入此宿主；宿主只接收
 * 已由主进程创建并受权限边界约束的内置适配器。
 */
export class AgentPluginHost {
  private readonly entries = new Map<string, PluginHostEntry>()
  private readonly eventBus: AgentPluginHostEventBus

  constructor(options: { eventBus?: AgentPluginHostEventBus } = {}) {
    this.eventBus = options.eventBus ?? new AgentPluginHostEventBus()
  }

  /** 注册一个插件并执行一次 register；重复 ID 或注册失败会被拒绝。 */
  async register(registration: AgentPluginHostRegistration): Promise<void> {
    const pluginId = registration.manifest.id
    if (this.entries.has(pluginId)) throw new Error(`AGENT_PLUGIN_HOST_DUPLICATE:${pluginId}`)
    const entry: PluginHostEntry = {
      registration,
      context: { pluginId, manifest: registration.manifest },
      health: this.createHealth(pluginId, 'registered'),
      disposed: false,
    }
    this.entries.set(pluginId, entry)
    try {
      await registration.lifecycle.register?.(entry.context)
      this.publish(entry)
    } catch (error) {
      this.markFailed(entry, error)
      throw error
    }
  }

  /** 按注册顺序启动所有插件；单个失败不会阻断其它模块。 */
  async start(): Promise<AgentPluginHealth[]> {
    for (const entry of this.entries.values()) {
      if (entry.disposed || entry.health.state === 'running' || entry.health.state === 'failed') continue
      await this.runLifecycle(entry, 'starting', 'running', entry.registration.lifecycle.start)
    }
    return this.listHealth()
  }

  /** 按逆序停止插件；重复 stop 不再调用适配器。 */
  async stop(): Promise<AgentPluginHealth[]> {
    const entries = [...this.entries.values()].reverse()
    for (const entry of entries) {
      if (entry.disposed || entry.health.state !== 'running') continue
      await this.runLifecycle(entry, 'stopping', 'stopped', entry.registration.lifecycle.stop)
    }
    return this.listHealth()
  }

  /** 释放所有插件资源；会先停止仍在运行的插件。 */
  async dispose(): Promise<AgentPluginHealth[]> {
    await this.stop()
    for (const entry of this.entries.values()) {
      if (entry.disposed) continue
      try {
        await entry.registration.lifecycle.dispose?.(entry.context)
        entry.disposed = true
        this.setState(entry, 'stopped')
      } catch (error) {
        this.markFailed(entry, error)
      }
    }
    return this.listHealth()
  }

  /** 获取当前宿主健康快照。 */
  listHealth(): AgentPluginHealth[] {
    return [...this.entries.values()].map((entry) => ({ ...entry.health }))
  }

  /** 订阅健康状态变化。 */
  subscribe(listener: AgentPluginHostEventListener): () => void {
    return this.eventBus.subscribe(listener)
  }

  private async runLifecycle(
    entry: PluginHostEntry,
    activeState: Extract<AgentPluginLifecycleState, 'starting' | 'stopping'>,
    successState: Extract<AgentPluginLifecycleState, 'running' | 'stopped'>,
    operation: AgentPluginLifecycle['start'] | AgentPluginLifecycle['stop'],
  ): Promise<void> {
    this.setState(entry, activeState)
    try {
      await operation?.(entry.context)
      this.setState(entry, successState)
    } catch (error) {
      this.markFailed(entry, error)
    }
  }

  private createHealth(pluginId: string, state: AgentPluginLifecycleState): AgentPluginHealth {
    return { pluginId, state, updatedAt: Date.now() }
  }

  private setState(entry: PluginHostEntry, state: AgentPluginLifecycleState): void {
    entry.health = { ...entry.health, state, updatedAt: Date.now(), errorCode: undefined }
    this.publish(entry)
  }

  private markFailed(entry: PluginHostEntry, error: unknown): void {
    const code = error instanceof Error && /^AGENT_PLUGIN_[A-Z0-9_:-]+$/.test(error.message) ? error.message : 'AGENT_PLUGIN_HOST_LIFECYCLE_FAILED'
    entry.health = { ...entry.health, state: 'failed', updatedAt: Date.now(), errorCode: code }
    this.publish(entry)
  }

  private publish(entry: PluginHostEntry): void {
    this.eventBus.emit({ type: 'plugin-health', health: { ...entry.health } })
  }
}
