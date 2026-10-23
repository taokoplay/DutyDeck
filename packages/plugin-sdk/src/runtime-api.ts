import type { PluginCapabilityId } from './capabilities.js'
import type { PluginProgress } from './runtime-protocol.js'

/** runtime 可读取的冻结设置值，不接受嵌套对象。 */
export type PluginSettingValue = string | number | boolean | null

/** 调用级能力客户端；只能使用宿主已授予的 ID。 */
export interface PluginCapabilityClient {
  request<TResult = unknown>(capability: PluginCapabilityId, input: unknown): Promise<TResult>
}

/** 工具处理函数可见的可信调用上下文。 */
export interface PluginToolCallContext {
  readonly invocationId: string
  readonly moduleId: string
  readonly sessionId: string
  readonly projectId: string | null
  readonly runId: string
  readonly signal: AbortSignal
  readonly deadline: number
  readonly settings: Readonly<Record<string, PluginSettingValue>>
  readonly capabilities: PluginCapabilityClient
  progress(value: PluginProgress): void
}

/** Surface bridge 调用 runtime 时的上下文。 */
export interface PluginSurfaceCallContext {
  readonly requestId: string
  readonly surfaceId: string
  readonly sessionId: string
  readonly projectId: string | null
  readonly runId: string
  readonly readOnly: boolean
  readonly signal: AbortSignal
  readonly deadline: number
  readonly settings: Readonly<Record<string, PluginSettingValue>>
  readonly capabilities: PluginCapabilityClient
  progress(value: PluginProgress): void
}

/** 工具 handler 的唯一注册表。 */
export interface PluginToolHandlerRegistry {
  handle(id: string, handler: (input: unknown, call: PluginToolCallContext) => unknown | Promise<unknown>): void
}

/** Surface 方法 handler 的唯一注册表。 */
export interface PluginSurfaceHandlerRegistry {
  handle(
    surfaceId: string,
    method: string,
    handler: (input: unknown, call: PluginSurfaceCallContext) => unknown | Promise<unknown>,
  ): void
}

/** 插件服务生命周期实现。 */
export interface PluginServiceImplementation {
  start?(): void | Promise<void>
  health?(): PluginHealth | Promise<PluginHealth>
  drain?(signal: AbortSignal): void | Promise<void>
  stop?(): void | Promise<void>
}

/** 服务健康由插件自行声明，宿主仍独立判断进程健康。 */
export interface PluginHealth {
  state: 'healthy' | 'degraded' | 'failed'
  detail?: string
}

/** 插件服务 handler 注册表。 */
export interface PluginServiceRegistry {
  handle(id: string, implementation: PluginServiceImplementation): void
}

/** 插件向自己的 Surface 发布短生命周期事件。 */
export interface PluginEventEmitter {
  emit(input: {
    surfaceId?: string
    type: string
    payload?: Record<string, unknown>
  }): void
}

/** 插件日志只允许有界、脱敏文本。 */
export interface PluginLogger {
  debug(message: string, data?: Record<string, unknown>): void
  info(message: string, data?: Record<string, unknown>): void
  warn(message: string, data?: Record<string, unknown>): void
  error(message: string, data?: Record<string, unknown>): void
}

/** 插件私有状态 API，不接收文件路径。 */
export interface PluginStateApi {
  read<T>(key: string): Promise<T | null>
  write<T>(key: string, value: T, options: {
    schemaVersion: number
    expectedRevision?: number
  }): Promise<{ revision: number }>
}

/** 插件 runtime 启动时获得的实例级上下文。 */
export interface PluginRuntimeContext {
  readonly plugin: {
    id: string
    version: string
    packageHash: string
  }
  readonly declaredModules: ReadonlyArray<{
    id: string
    version: string
    activation: 'message-explicit' | 'session-toggle'
  }>
  readonly tools: PluginToolHandlerRegistry
  readonly surfaces: PluginSurfaceHandlerRegistry
  readonly services: PluginServiceRegistry
  readonly events: PluginEventEmitter
  readonly state: PluginStateApi
  readonly settings: Readonly<Record<string, PluginSettingValue>>
  readonly log: PluginLogger
}

/** 插件 runtime 必须导出的生命周期定义。 */
export interface PluginRuntimeDefinition {
  activate(context: PluginRuntimeContext): void | Promise<void>
  deactivate?(context: PluginRuntimeContext): void | Promise<void>
}

/**
 * 在作者侧保留定义字面量类型并做基本形态校验。
 * @param definition 插件 runtime 定义。
 * @returns 原定义对象，不执行激活逻辑。
 */
export function definePlugin<TDefinition extends PluginRuntimeDefinition>(definition: TDefinition): TDefinition {
  if (!definition || typeof definition.activate !== 'function') {
    throw new Error('PLUGIN_RUNTIME_ACTIVATE_REQUIRED')
  }
  return definition
}
