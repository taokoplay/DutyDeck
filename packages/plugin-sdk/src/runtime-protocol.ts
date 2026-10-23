import type { PluginCapabilityRequest, PluginCapabilityResult } from './capabilities.js'

/** Utility runtime 与宿主之间的协议版本。 */
export const PLUGIN_RUNTIME_PROTOCOL_VERSION = 1 as const

/** Runtime 启动后报告的实际贡献身份；宿主必须与签名 manifest 对照。 */
export interface PluginRuntimeHello {
  pluginId: string
  pluginVersion: string
  packageHash: string
  protocolVersion: typeof PLUGIN_RUNTIME_PROTOCOL_VERSION
  tools: string[]
  surfaces: string[]
  services: string[]
}

/** 只暴露给插件运行时的稳定错误；异常正文不得跨越信任边界。 */
export interface PluginRuntimeError {
  code: string
  message: string
  retryable: boolean
}

/** 长任务进度事件，不改变工具最终结果。 */
export interface PluginProgress {
  message?: string
  current?: number
  total?: number
  data?: Record<string, unknown>
}

/** Host 到 runtime 的请求或取消信封。 */
export type PluginRuntimeCommand =
  | {
    protocolVersion: typeof PLUGIN_RUNTIME_PROTOCOL_VERSION
    kind: 'request'
    requestId: string
    method: 'runtime.activate'
    payload: {
      settingsRevision: number
      settings: Record<string, unknown>
    }
  }
  | {
    protocolVersion: typeof PLUGIN_RUNTIME_PROTOCOL_VERSION
    kind: 'request'
    requestId: string
    method: 'tool.invoke'
    payload: {
      invocationId: string
      toolId: string
      moduleId: string
      sessionId: string
      projectId: string | null
      runId: string
      settingsRevision: number
      settings: Record<string, unknown>
      input: unknown
      deadline: number
    }
  }
  | {
    protocolVersion: typeof PLUGIN_RUNTIME_PROTOCOL_VERSION
    kind: 'request'
    requestId: string
    method: 'surface.invoke'
    payload: {
      invocationId: string
      surfaceId: string
      moduleId: string
      method: string
      sessionId: string
      projectId: string | null
      runId: string
      readOnly: boolean
      settingsRevision: number
      settings: Record<string, unknown>
      input: unknown
      deadline: number
    }
  }
  | {
    protocolVersion: typeof PLUGIN_RUNTIME_PROTOCOL_VERSION
    kind: 'request'
    requestId: string
    method: 'service.command'
    payload: {
      serviceId: string
      command: 'start' | 'health' | 'drain' | 'stop'
    }
  }
  | {
    protocolVersion: typeof PLUGIN_RUNTIME_PROTOCOL_VERSION
    kind: 'request'
    requestId: string
    method: 'runtime.configure'
    payload: {
      settingsRevision: number
      settings: Record<string, unknown>
    }
  }
  | {
    protocolVersion: typeof PLUGIN_RUNTIME_PROTOCOL_VERSION
    kind: 'cancel'
    requestId: string
    targetRequestId: string
    reason: string
  }
  | {
    protocolVersion: typeof PLUGIN_RUNTIME_PROTOCOL_VERSION
    kind: 'request'
    requestId: string
    method: 'runtime.dispose'
    payload: Record<string, never>
  }

/** Runtime 到宿主的请求与事件信封。 */
export type PluginRuntimeMessage =
  | {
    protocolVersion: typeof PLUGIN_RUNTIME_PROTOCOL_VERSION
    kind: 'response'
    requestId: string
    ok: true
    value: unknown
  }
  | {
    protocolVersion: typeof PLUGIN_RUNTIME_PROTOCOL_VERSION
    kind: 'response'
    requestId: string
    ok: false
    error: PluginRuntimeError
  }
  | {
    protocolVersion: typeof PLUGIN_RUNTIME_PROTOCOL_VERSION
    kind: 'event'
    requestId: string
    event: 'runtime.hello'
    payload: PluginRuntimeHello
  }
  | {
    protocolVersion: typeof PLUGIN_RUNTIME_PROTOCOL_VERSION
    kind: 'request'
    requestId: string
    method: 'capability.invoke'
    payload: PluginCapabilityRequest & {
      invocationId: string
    }
  }
  | {
    protocolVersion: typeof PLUGIN_RUNTIME_PROTOCOL_VERSION
    kind: 'request'
    requestId: string
    method: 'event.emit'
    payload: {
      surfaceId?: string
      type: string
      data?: Record<string, unknown>
    }
  }
  | {
    protocolVersion: typeof PLUGIN_RUNTIME_PROTOCOL_VERSION
    kind: 'request'
    requestId: string
    method: 'log.write'
    payload: {
      level: 'debug' | 'info' | 'warn' | 'error'
      message: string
      data?: Record<string, unknown>
    }
  }

/** Host 对 runtime capability 请求返回的统一结果。 */
export type PluginRuntimeCapabilityResponse = PluginCapabilityResult
