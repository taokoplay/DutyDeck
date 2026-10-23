import { pathToFileURL } from 'node:url'
import { resolve, sep } from 'node:path'
import {
  createPluginRuntimeSession,
  type PluginCapabilityId,
  type PluginRuntimeCommand,
  type PluginRuntimeDefinition,
  type PluginRuntimeMessage,
  type PluginRuntimeTransport,
} from '@dutydeck/plugin-sdk'

/** Electron utility process 暴露的父端口最小接口。 */
interface RuntimeParentPort {
  on(event: 'message', listener: (event: { data: unknown; ports?: unknown[] }) => void): void
  postMessage(message: PluginRuntimeMessage): void
  start?: () => void
}

/** 从 main 转移而来的专用 MessagePort。 */
interface RuntimeMessagePort {
  on(event: 'message', listener: (event: { data: unknown }) => void): void
  postMessage(message: PluginRuntimeMessage): void
  start?: () => void
  close?: () => void
}

/** 宿主传入的已验证 bootstrap 元数据。 */
interface RuntimeMetadata {
  snapshot: {
    pluginId: string
    pluginVersion: string
    packageHash: string
    settingsRevision: number
    settings: Record<string, string | number | boolean | null>
  }
  declaredModules: Array<{
    id: string
    version: string
    activation: 'message-explicit' | 'session-toggle'
  }>
}

/** 能力调用的超时错误，避免插件永久等待宿主响应。 */
class CapabilityCallTimeoutError extends Error {
  readonly code = 'PLUGIN_CAPABILITY_TIMEOUT'
}

/** Electron utility 消息可能带 data 包装。 */
function unwrap(value: unknown): unknown {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value
  if (!('data' in value) || Object.keys(value).length !== 1) return value
  return (value as { data: unknown }).data
}

/** 校验宿主传入的 runtime 路径和 bootstrap 元数据。 */
function parseMetadata(packageRoot: string, runtimeEntry: string, encoded: string): { metadata: RuntimeMetadata; runtimeEntry: string } {
  if (!runtimeEntry || !encoded) throw new Error('PLUGIN_RUNTIME_BOOTSTRAP_INVALID')
  const root = resolve(packageRoot)
  const absolute = resolve(root, runtimeEntry)
  if (!absolute.startsWith(`${root}${sep}`)) throw new Error('PLUGIN_RUNTIME_PATH_INVALID')
  let value: unknown
  try { value = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8')) } catch { throw new Error('PLUGIN_RUNTIME_BOOTSTRAP_INVALID') }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('PLUGIN_RUNTIME_BOOTSTRAP_INVALID')
  return { metadata: value as RuntimeMetadata, runtimeEntry: absolute }
}

/** 建立父端口消息分发与能力请求关联。 */
function createTransport(parentPort: RuntimeMessagePort): {
  transport: PluginRuntimeTransport
  nextRequestId: () => string
  capability: (capability: PluginCapabilityId, input: unknown, invocationId: string, signal: AbortSignal) => Promise<unknown>
  onCommand: (listener: (command: PluginRuntimeCommand) => void) => void
} {
  let counter = 0
  const pending = new Map<string, {
    resolve: (value: unknown) => void
    reject: (error: Error) => void
    timer: ReturnType<typeof setTimeout>
    signal: AbortSignal
    removeAbort: () => void
  }>()
  const commandListeners: Array<(command: PluginRuntimeCommand) => void> = []
  const nextRequestId = (): string => `runtime-${++counter}`
  parentPort.on('message', (event) => {
    const message = unwrap(event.data)
    if (!message || typeof message !== 'object' || Array.isArray(message)) return
    const record = message as Record<string, unknown>
    if (record.kind === 'response' && typeof record.requestId === 'string') {
      const entry = pending.get(record.requestId)
      if (!entry) return
      pending.delete(record.requestId)
      clearTimeout(entry.timer)
      entry.removeAbort()
      if (record.ok === true) {
        const value = record.value
        if (value && typeof value === 'object' && !Array.isArray(value) && 'ok' in value) {
          const result = value as { ok: boolean; code?: unknown; value?: unknown }
          if (!result.ok) entry.reject(new Error(typeof result.code === 'string' ? result.code : 'PLUGIN_CAPABILITY_FAILED'))
          else entry.resolve(result.value)
        } else {
          entry.resolve(value)
        }
      }
      else entry.reject(new Error(typeof record.error === 'object' && record.error && 'code' in record.error
        ? String((record.error as { code: unknown }).code)
        : 'PLUGIN_CAPABILITY_FAILED'))
      return
    }
    for (const listener of commandListeners) listener(message as PluginRuntimeCommand)
  })
  return {
    transport: {
      postMessage(message) {
        parentPort.postMessage(message)
      },
    },
    nextRequestId,
    onCommand(listener) {
      commandListeners.push(listener)
    },
    capability(capability, input, invocationId, signal) {
      if (signal.aborted) return Promise.reject(new Error('PLUGIN_TOOL_CANCELLED'))
      const requestId = nextRequestId()
      return new Promise<unknown>((resolvePromise, reject) => {
        let abort: () => void = () => undefined
        const timer = setTimeout(() => {
          const entry = pending.get(requestId)
          if (!entry) return
          pending.delete(requestId)
          signal.removeEventListener('abort', entry.removeAbort)
          reject(new CapabilityCallTimeoutError())
        }, 60_000)
        abort = (): void => {
          if (!pending.delete(requestId)) return
          clearTimeout(timer)
          reject(new Error('PLUGIN_TOOL_CANCELLED'))
        }
        const removeAbort = (): void => signal.removeEventListener('abort', abort)
        pending.set(requestId, { resolve: resolvePromise, reject, timer, signal, removeAbort })
        signal.addEventListener('abort', abort, { once: true })
        parentPort.postMessage({
          protocolVersion: 1,
          kind: 'request',
          requestId,
          method: 'capability.invoke',
          payload: { capability, input, invocationId },
        })
      })
    },
  }
}

/**
 * utility 入口：加载包内已签名 runtime，建立插件 session 并处理宿主命令。
 * @returns 创建成功时保持进程运行，不产生未处理 Promise。
 */
async function run(parentPort: RuntimeMessagePort, runtimeEntry: string, packageRoot: string, encodedMetadata: string): Promise<void> {
  if (!packageRoot) throw new Error('PLUGIN_RUNTIME_BOOTSTRAP_INVALID')
  const parsed = parseMetadata(packageRoot, runtimeEntry, encodedMetadata)
  const metadata = parsed.metadata
  const runtimeModule = await import(pathToFileURL(parsed.runtimeEntry).href) as { default?: unknown }
  const definition = runtimeModule.default
  if (!definition || typeof definition !== 'object' || typeof (definition as { activate?: unknown }).activate !== 'function') {
    throw new Error('PLUGIN_RUNTIME_DEFINITION_INVALID')
  }
  const messages = createTransport(parentPort)
  const session = await createPluginRuntimeSession({
    definition: definition as PluginRuntimeDefinition,
    transport: messages.transport,
    plugin: {
      id: metadata.snapshot.pluginId,
      version: metadata.snapshot.pluginVersion,
      packageHash: metadata.snapshot.packageHash,
    },
    declaredModules: metadata.declaredModules,
    settingsRevision: metadata.snapshot.settingsRevision,
    settings: metadata.snapshot.settings,
    uuid: messages.nextRequestId,
    invokeCapability: messages.capability,
    state: {
      read: async <T>(key: string): Promise<T | null> => {
        const controller = new AbortController()
        return await messages.capability('plugin.state.read', { key }, 'plugin-instance', controller.signal) as T | null
      },
      write: async <T>(key: string, value: T, options: { schemaVersion: number; expectedRevision?: number }) => {
        const controller = new AbortController()
        return await messages.capability('plugin.state.write', {
          key,
          value,
          schemaVersion: options.schemaVersion,
          ...(options.expectedRevision === undefined ? {} : { expectedRevision: options.expectedRevision }),
        }, 'plugin-instance', controller.signal) as { revision: number }
      },
    },
  })
  messages.onCommand((command) => {
    void session.handleCommand(command).then(() => {
      if (command.kind === 'request' && command.method === 'runtime.dispose') {
        parentPort.close?.()
        setImmediate(() => process.exit(0))
      }
    }).catch(() => {
      if (command.kind === 'request' && command.method === 'runtime.dispose') {
        parentPort.close?.()
        setImmediate(() => process.exit(1))
      }
      parentPort.postMessage({
        protocolVersion: 1,
        kind: 'response',
        requestId: command.requestId,
        ok: false,
        error: { code: 'PLUGIN_RUNTIME_COMMAND_FAILED', message: '插件运行命令失败', retryable: false },
      })
    })
  })
  parentPort.start?.()
}

const parentPort = (process as typeof process & { parentPort?: RuntimeParentPort }).parentPort
if (parentPort) {
  parentPort.on('message', (event) => {
    const raw = unwrap(event.data)
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return
    const bootstrap = raw as Record<string, unknown>
    if (bootstrap.type !== 'plugin-runtime.bootstrap'
      || typeof bootstrap.runtimeEntry !== 'string'
      || typeof bootstrap.packageRoot !== 'string'
      || typeof bootstrap.metadata !== 'string'
      || !event.ports?.[0]) return
    void run(
      event.ports[0] as RuntimeMessagePort,
      bootstrap.runtimeEntry,
      bootstrap.packageRoot,
      bootstrap.metadata,
    ).catch((error: unknown) => {
      console.error('[PluginRuntime] 启动失败:', error instanceof Error ? error.message : 'UNKNOWN')
      process.exit(1)
    })
  })
  parentPort.start?.()
}
