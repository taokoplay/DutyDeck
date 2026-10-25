import type { PluginCapabilityId } from './capabilities.js'
import type {
  PluginCapabilityClient,
  PluginRuntimeDefinition,
  PluginRuntimeContext,
  PluginServiceImplementation,
  PluginSettingValue,
  PluginSurfaceCallContext,
  PluginToolCallContext,
} from './runtime-api.js'
import type {
  PluginProgress,
  PluginRuntimeCommand,
  PluginRuntimeError,
  PluginRuntimeHello,
  PluginRuntimeMessage,
} from './runtime-protocol.js'

/** 工具 handler 的稳定内部形状。 */
type ToolHandler = (input: unknown, call: PluginToolCallContext) => unknown | Promise<unknown>
/** Surface handler 的稳定内部形状。 */
type SurfaceHandler = (input: unknown, call: PluginSurfaceCallContext) => unknown | Promise<unknown>

/** runtime 向宿主发送消息的最小端口。 */
export interface PluginRuntimeTransport {
  postMessage(message: PluginRuntimeMessage | {
    protocolVersion: 1
    kind: 'response'
    requestId: string
    ok: true
    value: unknown
  }): void
}

/** runtime session 的实例信息和依赖。 */
export interface CreatePluginRuntimeSessionInput {
  definition: PluginRuntimeDefinition
  transport: PluginRuntimeTransport
  plugin: PluginRuntimeContext['plugin']
  declaredModules: PluginRuntimeContext['declaredModules']
  settingsRevision: number
  settings: Record<string, PluginSettingValue>
  uuid: () => string
  invokeCapability: (
    capability: PluginCapabilityId,
    input: unknown,
    invocationId: string,
    signal: AbortSignal,
  ) => Promise<unknown>
  state: PluginRuntimeContext['state']
  logger?: PluginRuntimeContext['log']
}

/** 已激活 runtime 的命令入口。 */
export interface PluginRuntimeSession {
  hello: PluginRuntimeHello
  handleCommand(command: PluginRuntimeCommand): Promise<void>
}

/** 插件异常只向宿主返回稳定错误。 */
function runtimeError(code: string): PluginRuntimeError {
  return { code, message: '插件调用失败', retryable: false }
}

/** 能力层只暴露受控的 PLUGIN_* 错误码，其他异常统一回退到调用类型错误。 */
function stableErrorCode(error: unknown, fallback: string): string {
  const candidate = error && typeof error === 'object' && 'code' in error
    ? (error as { code?: unknown }).code
    : error instanceof Error
      ? error.message
      : undefined
  return typeof candidate === 'string' && /^PLUGIN_[A-Z0-9_]{1,80}$/.test(candidate)
    ? candidate
    : fallback
}

/** 校验插件注册 ID，避免 handler 覆盖其它贡献。 */
function assertId(value: string, code: string): void {
  if (!/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/.test(value)) throw new Error(code)
}

/**
 * 加载插件定义并建立 runtime handler 注册表。
 * @param input 插件定义、宿主元数据和 RPC 适配器。
 * @returns 已完成注册并可直接处理宿主命令的 session。
 */
export async function createPluginRuntimeSession(input: CreatePluginRuntimeSessionInput): Promise<PluginRuntimeSession> {
  const toolHandlers = new Map<string, ToolHandler>()
  const surfaceHandlers = new Map<string, SurfaceHandler>()
  const serviceHandlers = new Map<string, PluginServiceImplementation>()
  const capabilityControllers = new Map<string, AbortController>()
  const hostRequestControllers = new Map<string, AbortController>()
  const progress = (invocationId: string, value: PluginProgress): void => {
    input.transport.postMessage({
      protocolVersion: 1,
      kind: 'request',
      requestId: input.uuid(),
      method: 'event.emit',
      payload: { type: 'progress', data: { invocationId, ...value } },
    })
  }
  const defaultLogger = {
    debug() {}, info() {}, warn() {}, error() {},
  }
  const context: PluginRuntimeContext = {
    plugin: input.plugin,
    declaredModules: input.declaredModules,
    settings: input.settings,
    state: input.state,
    log: input.logger ?? defaultLogger,
    tools: {
      handle(id, handler) {
        assertId(id, 'PLUGIN_TOOL_ID_INVALID')
        if (toolHandlers.has(id)) throw new Error('PLUGIN_TOOL_HANDLER_DUPLICATE')
        toolHandlers.set(id, handler)
      },
    },
    surfaces: {
      handle(surfaceId, method, handler) {
        assertId(surfaceId, 'PLUGIN_SURFACE_ID_INVALID')
        if (!/^[a-z][A-Za-z0-9_]{0,63}$/.test(method)) throw new Error('PLUGIN_SURFACE_METHOD_INVALID')
        const key = `${surfaceId}\0${method}`
        if (surfaceHandlers.has(key)) throw new Error('PLUGIN_SURFACE_HANDLER_DUPLICATE')
        surfaceHandlers.set(key, handler)
      },
    },
    services: {
      handle(id, implementation) {
        assertId(id, 'PLUGIN_SERVICE_ID_INVALID')
        if (serviceHandlers.has(id)) throw new Error('PLUGIN_SERVICE_HANDLER_DUPLICATE')
        serviceHandlers.set(id, implementation)
      },
    },
    events: {
      emit(event) {
        input.transport.postMessage({
          protocolVersion: 1,
          kind: 'request',
          requestId: input.uuid(),
          method: 'event.emit',
          payload: {
            ...(event.surfaceId ? { surfaceId: event.surfaceId } : {}),
            type: event.type,
            ...(event.payload ? { data: event.payload } : {}),
          },
        })
      },
    },
  }

  await input.definition.activate(context)
  const hello: PluginRuntimeHello = {
    pluginId: input.plugin.id,
    pluginVersion: input.plugin.version,
    packageHash: input.plugin.packageHash,
    protocolVersion: 1,
    tools: [...toolHandlers.keys()].sort(),
    surfaces: [...surfaceHandlers.keys()].map(key => key.split('\0')[0]!).filter((value, index, all) => all.indexOf(value) === index).sort(),
    services: [...serviceHandlers.keys()].sort(),
  }
  input.transport.postMessage({
    protocolVersion: 1,
    kind: 'event',
    requestId: input.uuid(),
    event: 'runtime.hello',
    payload: hello,
  })

  let active = false
  let disposed = false
  /** 发送成功响应，异常路径只暴露稳定错误。 */
  const respond = (requestId: string, value: unknown): void => {
    input.transport.postMessage({ protocolVersion: 1, kind: 'response', requestId, ok: true, value })
  }
  /** 发送失败响应，不把任意异常正文透给宿主或模型。 */
  const fail = (requestId: string, error: PluginRuntimeError): void => {
    input.transport.postMessage({ protocolVersion: 1, kind: 'response', requestId, ok: false, error })
  }
  /** 绑定 invocation 的能力客户端；插件不能改变 invocation 身份。 */
  const capabilityClient = (invocationId: string, signal: AbortSignal): PluginCapabilityClient => ({
    async request<TResult = unknown>(capability: PluginCapabilityId, requestInput: unknown): Promise<TResult> {
      return await input.invokeCapability(capability, requestInput, invocationId, signal) as TResult
    },
  })
  return {
    hello,
    async handleCommand(command) {
      if (command.kind === 'cancel') {
        hostRequestControllers.get(command.targetRequestId)?.abort()
        return
      }
      if (command.kind !== 'request') return
      if (command.method === 'runtime.dispose') {
        if (disposed) return
        disposed = true
        active = false
        for (const controller of capabilityControllers.values()) controller.abort()
        capabilityControllers.clear()
        hostRequestControllers.clear()
        await input.definition.deactivate?.(context)
        for (const service of serviceHandlers.values()) await service.stop?.()
        respond(command.requestId, { disposed: true })
        return
      }
      if (command.method === 'runtime.activate' || command.method === 'runtime.configure') {
        active = true
        respond(command.requestId, { ready: true })
        return
      }
      if (!active || disposed) {
        fail(command.requestId, runtimeError('PLUGIN_RUNTIME_NOT_ACTIVE'))
        return
      }
      if (command.method === 'service.command') {
        const service = serviceHandlers.get(command.payload.serviceId)
        if (!service) {
          fail(command.requestId, runtimeError('PLUGIN_SERVICE_NOT_FOUND'))
          return
        }
        const controller = new AbortController()
        capabilityControllers.set(command.requestId, controller)
        hostRequestControllers.set(command.requestId, controller)
        try {
          if (command.payload.command === 'start') await service.start?.()
          else if (command.payload.command === 'drain') await service.drain?.(controller.signal)
          else if (command.payload.command === 'stop') await service.stop?.()
          else {
            respond(command.requestId, await service.health?.() ?? { state: 'healthy' })
            return
          }
          respond(command.requestId, { ok: true })
        } catch {
          fail(command.requestId, runtimeError('PLUGIN_SERVICE_FAILED'))
        } finally {
          capabilityControllers.delete(command.requestId)
          hostRequestControllers.delete(command.requestId)
        }
        return
      }
      const invocationId = command.payload.invocationId
      const controller = new AbortController()
      capabilityControllers.set(invocationId, controller)
      hostRequestControllers.set(command.requestId, controller)
      try {
        if (command.method === 'tool.invoke') {
          const handler = toolHandlers.get(command.payload.toolId)
          if (!handler) {
            fail(command.requestId, runtimeError('PLUGIN_TOOL_NOT_FOUND'))
            return
          }
          const result = await handler(command.payload.input, {
            invocationId,
            moduleId: command.payload.moduleId,
            sessionId: command.payload.sessionId,
            projectId: command.payload.projectId,
            runId: command.payload.runId,
            signal: controller.signal,
            deadline: command.payload.deadline,
            settings: command.payload.settings as Record<string, PluginSettingValue>,
            capabilities: capabilityClient(invocationId, controller.signal),
            progress: (value) => progress(invocationId, value),
          })
          respond(command.requestId, result)
          return
        }
        if (command.method === 'surface.invoke') {
          const handler = surfaceHandlers.get(`${command.payload.surfaceId}\0${command.payload.method}`)
          if (!handler) {
            fail(command.requestId, runtimeError('PLUGIN_SURFACE_METHOD_NOT_FOUND'))
            return
          }
          const result = await handler(command.payload.input, {
            requestId: command.requestId,
            surfaceId: command.payload.surfaceId,
            sessionId: command.payload.sessionId,
            projectId: command.payload.projectId,
            runId: command.payload.runId,
            readOnly: command.payload.readOnly,
            signal: controller.signal,
            deadline: command.payload.deadline,
            settings: command.payload.settings as Record<string, PluginSettingValue>,
            capabilities: capabilityClient(invocationId, controller.signal),
            progress: (value) => progress(invocationId, value),
          })
          respond(command.requestId, result)
        }
      } catch (error) {
        fail(command.requestId, runtimeError(stableErrorCode(
          error,
          command.method === 'tool.invoke' ? 'PLUGIN_TOOL_FAILED' : 'PLUGIN_SURFACE_FAILED',
        )))
      } finally {
        capabilityControllers.delete(invocationId)
        hostRequestControllers.delete(command.requestId)
      }
    },
  }
}
