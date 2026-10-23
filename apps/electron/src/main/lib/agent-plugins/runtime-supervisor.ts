import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import type {
  PluginCapabilityResult,
  PluginRuntimeCommand,
  PluginRuntimeHello,
  PluginRuntimeMessage,
} from '@dutydeck/plugin-sdk'

/** Runtime 插件进程的最小可测试接口。 */
export interface PluginRuntimeProcess {
  postMessage(message: unknown): void
  kill(): boolean | void
  on(event: 'message' | 'error' | 'exit', listener: (...args: unknown[]) => void): void
}
/** 创建 utility runtime 的宿主依赖，测试可替换真实 Electron 进程。 */
export interface PluginRuntimeSupervisorDependencies {
  createProcess?: (
    runtimeEntry: string,
    packageRoot: string,
    metadata: {
      snapshot: PluginRuntimeSnapshot
      declaredModules: Array<{
        id: string
        version: string
        activation: 'message-explicit' | 'session-toggle'
      }>
    },
  ) => PluginRuntimeProcess
  uuid?: () => string
  startupTimeoutMs?: number
  invocationTimeoutGraceMs?: number
  onCapabilityRequest?: (input: {
    capability: string
    input: unknown
    invocationId: string | null
    moduleId: string | null
    sessionId: string | null
    projectId: string | null
    runId: string | null
    readOnly: boolean | null
    pluginId: string
    pluginVersion: string
    packageHash: string
  }) => Promise<PluginCapabilityResult>
  onEvent?: (input: { surfaceId?: string; type: string; data?: Record<string, unknown> }) => void
}

/** 启动 runtime 前由宿主冻结并校验的不可变快照。 */
export interface PluginRuntimeSnapshot {
  pluginId: string
  pluginVersion: string
  packageHash: string
  packageRoot: string
  runtimeEntry: string
  tools: readonly string[]
  surfaces: readonly string[]
  services: readonly string[]
  declaredModules: Array<{
    id: string
    version: string
    activation: 'message-explicit' | 'session-toggle'
  }>
  settingsRevision: number
  settings: Record<string, unknown>
}

/** `createPluginRuntimeSnapshot` 的公开输入。 */
export type PluginRuntimeSnapshotInput = PluginRuntimeSnapshot

/** Agent 工具调用由宿主注入的可信上下文。 */
export interface PluginRuntimeToolContext {
  moduleId: string
  sessionId: string
  projectId: string | null
  runId: string
  settingsRevision: number
  settings: Record<string, unknown>
  deadline: number
}

/** 对外健康快照，不包含异常正文。 */
export interface PluginRuntimeHealth {
  pluginId: string
  state: 'idle' | 'starting' | 'running' | 'draining' | 'stopped' | 'failed'
  epoch: number
  errorCode?: string
}

/** 正在等待 runtime 返回的调用。 */
interface PendingRequest {
  requestId: string
  kind: 'activate' | 'tool' | 'surface' | 'service' | 'configure' | 'dispose'
  promise: Promise<unknown>
  resolve: (value: unknown) => void
  reject: (error: Error) => void
  timer: ReturnType<typeof setTimeout>
  removeAbort?: () => void
  invocationId?: string
  moduleId?: string
  sessionId?: string
  projectId?: string | null
  runId?: string
  readOnly?: boolean
}

/** 宿主主动发送给 runtime 的请求方法。 */
type RuntimeHostMethod = 'runtime.activate' | 'tool.invoke' | 'surface.invoke' | 'service.command' | 'runtime.configure' | 'runtime.dispose'

/** 当前进程实例的独立代次。 */
interface RuntimeInstance {
  snapshot: PluginRuntimeSnapshot
  process: PluginRuntimeProcess
  epoch: number
  healthy: boolean
  draining: boolean
  pending: Map<string, PendingRequest>
  hello?: PluginRuntimeHello
  helloResolve?: (value: PluginRuntimeHello) => void
  helloReject?: (error: Error) => void
  startupTimer?: ReturnType<typeof setTimeout>
}

/** 默认启动真实 Electron utility；纯 Bun 测试不会走到此依赖。 */
const DEFAULT_DEPENDENCIES: PluginRuntimeSupervisorDependencies = {
  createProcess: (runtimeEntry, packageRoot, metadata) => {
    const { MessageChannelMain, utilityProcess } = require('electron') as typeof import('electron')
    const encodedMetadata = Buffer.from(JSON.stringify(metadata), 'utf8').toString('base64url')
    const child = utilityProcess.fork(join(__dirname, 'plugin-runtime.cjs'), [], {
      serviceName: 'DutyDeck Plugin Runtime',
    })
    const channel = new MessageChannelMain()
    channel.port1.start()
    child.once('spawn', () => {
      child.postMessage({
        type: 'plugin-runtime.bootstrap',
        runtimeEntry,
        packageRoot,
        metadata: encodedMetadata,
      }, [channel.port2])
    })
    return {
      postMessage: (message) => channel.port1.postMessage(message),
      kill: () => child.kill(),
      on: (event, listener) => {
        if (event === 'exit') child.on('exit', (code) => listener(code))
        else if (event === 'message') channel.port1.on('message', (message) => listener(message.data))
        else child.on('error', () => listener())
      },
    }
  },
}

/** 从可信安装记录构造不可变 runtime 快照。 */
export function createPluginRuntimeSnapshot(input: PluginRuntimeSnapshotInput): PluginRuntimeSnapshot {
  if (!input.pluginId || !input.pluginVersion || !/^[a-f0-9]{64}$/.test(input.packageHash)) {
    throw new Error('PLUGIN_RUNTIME_SNAPSHOT_INVALID')
  }
  if (!input.packageRoot || !input.runtimeEntry || !Number.isSafeInteger(input.settingsRevision)) {
    throw new Error('PLUGIN_RUNTIME_SNAPSHOT_INVALID')
  }
  return {
    ...structuredClone(input),
    tools: [...new Set(input.tools)],
    surfaces: [...new Set(input.surfaces)],
    services: [...new Set(input.services)],
  }
}

/** 创建带稳定错误码的 runtime 异常。 */
class RuntimeSupervisorError extends Error {
  constructor(readonly code: string) {
    super(code)
    this.name = 'RuntimeSupervisorError'
  }
}

/** 判断未知值是否具备 RPC 信封的最小结构。 */
function isRuntimeMessage(value: unknown): value is PluginRuntimeMessage {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value)
    && (value as Record<string, unknown>).protocolVersion === 1
    && typeof (value as Record<string, unknown>).requestId === 'string'
    && typeof (value as Record<string, unknown>).kind === 'string')
}

/** Electron utility 消息可能存在 data 包装，只解开一层明确包装。 */
function unwrapMessage(value: unknown): unknown {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value
  if (!('data' in value) || Object.keys(value).length !== 1) return value
  return (value as { data: unknown }).data
}

/** 比较 runtime 自报贡献和签名清单，不接受新增、缺失或重复。 */
function sameContributions(declared: readonly string[], reported: readonly string[]): boolean {
  const left = [...new Set(declared)].sort()
  const right = [...new Set(reported)].sort()
  return left.length === declared.length && right.length === reported.length
    && left.length === right.length && left.every((value, index) => value === right[index])
}

/** 管理一个插件版本从启动到退出的唯一 utility 实例。 */
export class PluginRuntimeSupervisor {
  private readonly createProcess: NonNullable<PluginRuntimeSupervisorDependencies['createProcess']>
  private readonly uuid: () => string
  private readonly startupTimeoutMs: number
  private readonly invocationTimeoutGraceMs: number
  private readonly onCapabilityRequest: PluginRuntimeSupervisorDependencies['onCapabilityRequest']
  private readonly onEvent: PluginRuntimeSupervisorDependencies['onEvent']
  private instance: RuntimeInstance | undefined
  private nextEpoch = 1
  private health: PluginRuntimeHealth = { pluginId: '', state: 'idle', epoch: 0 }

  constructor(dependencies: PluginRuntimeSupervisorDependencies = DEFAULT_DEPENDENCIES) {
    this.createProcess = dependencies.createProcess ?? DEFAULT_DEPENDENCIES.createProcess!
    this.uuid = dependencies.uuid ?? randomUUID
    this.startupTimeoutMs = Math.min(60_000, Math.max(1, dependencies.startupTimeoutMs ?? 15_000))
    this.invocationTimeoutGraceMs = Math.min(5_000, Math.max(0, dependencies.invocationTimeoutGraceMs ?? 250))
    this.onCapabilityRequest = dependencies.onCapabilityRequest
    this.onEvent = dependencies.onEvent
  }

  /** 启动 runtime，等待 hello 与 activate 成功后才进入 running。 */
  async start(snapshot: PluginRuntimeSnapshot): Promise<PluginRuntimeHealth> {
    if (this.instance) throw new RuntimeSupervisorError('PLUGIN_RUNTIME_ALREADY_STARTED')
    const frozen = createPluginRuntimeSnapshot(snapshot)
    this.health = { pluginId: frozen.pluginId, state: 'starting', epoch: this.nextEpoch }
    let child: PluginRuntimeProcess
    try {
      child = this.createProcess(frozen.runtimeEntry, frozen.packageRoot, {
        snapshot: frozen,
        declaredModules: structuredClone(frozen.declaredModules),
      })
    } catch {
      this.health = { ...this.health, state: 'failed', errorCode: 'PLUGIN_RUNTIME_START_FAILED' }
      throw new RuntimeSupervisorError('PLUGIN_RUNTIME_START_FAILED')
    }
    const instance: RuntimeInstance = {
      snapshot: frozen,
      process: child,
      epoch: this.nextEpoch++,
      healthy: false,
      draining: false,
      pending: new Map(),
    }
    this.instance = instance
    const hello = new Promise<PluginRuntimeHello>((resolve, reject) => {
      instance.helloResolve = resolve
      instance.helloReject = reject
    })
    instance.startupTimer = setTimeout(() => {
      this.fail(instance, 'PLUGIN_RUNTIME_START_TIMEOUT')
      this.kill(instance)
    }, this.startupTimeoutMs)
    child.on('message', (message) => this.handleMessage(instance, message))
    child.on('error', () => this.fail(instance, 'PLUGIN_RUNTIME_PROCESS_ERROR'))
    child.on('exit', (code) => this.handleExit(instance, typeof code === 'number' ? code : null))
    let reported: PluginRuntimeHello
    try {
      reported = await hello
      this.assertHello(instance, reported)
      await this.request(instance, 'activate', 'runtime.activate', {
        settingsRevision: frozen.settingsRevision,
        settings: structuredClone(frozen.settings),
      })
      instance.healthy = true
      if (instance.startupTimer) clearTimeout(instance.startupTimer)
      instance.startupTimer = undefined
      this.health = { pluginId: frozen.pluginId, state: 'running', epoch: instance.epoch }
      return { ...this.health }
    } catch (error) {
      this.fail(instance, error instanceof RuntimeSupervisorError ? error.code : 'PLUGIN_RUNTIME_START_FAILED')
      this.kill(instance)
      throw error
    }
  }

  /** 调用已声明的工具；返回 JSON 数据且拒绝超预算结果。 */
  async invokeTool(input: {
    toolId: string
    input: unknown
    context: PluginRuntimeToolContext
    signal: AbortSignal
  }): Promise<unknown> {
    const instance = this.requireRunning()
    if (!instance.snapshot.tools.includes(input.toolId)) throw new RuntimeSupervisorError('PLUGIN_TOOL_NOT_DECLARED')
    if (instance.pending.size >= 8) throw new RuntimeSupervisorError('PLUGIN_RUNTIME_BUSY')
    if (!Number.isFinite(input.context.deadline) || input.context.deadline <= Date.now()) {
      throw new RuntimeSupervisorError('PLUGIN_TOOL_DEADLINE_INVALID')
    }
    const invocationId = this.uuid()
    const result = await this.request(instance, 'tool', 'tool.invoke', {
      invocationId,
      toolId: input.toolId,
      moduleId: input.context.moduleId,
      sessionId: input.context.sessionId,
      projectId: input.context.projectId,
      runId: input.context.runId,
      settingsRevision: input.context.settingsRevision,
      settings: structuredClone(input.context.settings),
      input: input.input,
      deadline: input.context.deadline,
    }, input.signal, invocationId)
    const encoded = JSON.stringify(result)
    if (Buffer.byteLength(encoded) > 256 * 1024) throw new RuntimeSupervisorError('PLUGIN_TOOL_RESULT_TOO_LARGE')
    return result
  }

  /** 调用 Surface 声明的 bridge 方法。 */
  async invokeSurface(input: {
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
  }): Promise<unknown> {
    const instance = this.requireRunning()
    if (!instance.snapshot.surfaces.includes(input.surfaceId)) throw new RuntimeSupervisorError('PLUGIN_SURFACE_NOT_DECLARED')
    const invocationId = this.uuid()
    return this.request(instance, 'surface', 'surface.invoke', {
      invocationId,
      surfaceId: input.surfaceId,
      moduleId: input.moduleId,
      method: input.method,
      sessionId: input.sessionId,
      projectId: input.projectId,
      runId: `${input.sessionId}:surface`,
      readOnly: input.readOnly,
      settingsRevision: input.settingsRevision,
      settings: structuredClone(input.settings),
      input: input.input,
      deadline: input.deadline,
    }, input.signal, invocationId)
  }

  /** 在下一轮边界更新设置；当前在途调用继续使用原参数。 */
  async configure(settingsRevision: number, settings: Record<string, unknown>): Promise<void> {
    const instance = this.requireRunning()
    await this.request(instance, 'configure', 'runtime.configure', {
      settingsRevision,
      settings: structuredClone(settings),
    })
  }

  /** 正常停止 runtime；先请求释放，超时后由调用方决定强制终止。 */
  async stop(): Promise<void> {
    const instance = this.instance
    if (!instance) return
    if (instance.draining) throw new RuntimeSupervisorError('PLUGIN_RUNTIME_DRAINING')
    instance.draining = true
    this.health = { ...this.health, state: 'draining' }
    try {
      await this.request(instance, 'dispose', 'runtime.dispose', {}, undefined, undefined, 5_000)
    } catch {
      // 释放失败仍关闭进程，但稳定健康状态保持 failed。
    } finally {
      this.kill(instance)
      if (this.instance === instance) this.instance = undefined
      this.health = { pluginId: instance.snapshot.pluginId, state: 'stopped', epoch: instance.epoch }
    }
  }

  /** 立即终止进程并清理所有等待者。 */
  killCurrent(): void {
    if (this.instance) this.kill(this.instance)
  }

  /** 返回健康快照。 */
  listHealth(): PluginRuntimeHealth[] {
    return this.health.pluginId ? [{ ...this.health }] : []
  }

  /** 返回当前在途调用数量，供测试和诊断使用。 */
  listInvocations(): string[] {
    return this.instance ? [...this.instance.pending.values()].flatMap(entry => entry.invocationId ? [entry.invocationId] : []) : []
  }

  /** 校验 hello 的协议、实例身份和全部贡献。 */
  private assertHello(instance: RuntimeInstance, hello: PluginRuntimeHello): void {
    const snapshot = instance.snapshot
    if (hello.protocolVersion !== 1) throw new RuntimeSupervisorError('PLUGIN_RUNTIME_PROTOCOL_UNSUPPORTED')
    if (hello.pluginId !== snapshot.pluginId || hello.pluginVersion !== snapshot.pluginVersion
      || hello.packageHash !== snapshot.packageHash) throw new RuntimeSupervisorError('PLUGIN_RUNTIME_IDENTITY_MISMATCH')
    if (!sameContributions(snapshot.tools, hello.tools)
      || !sameContributions(snapshot.surfaces, hello.surfaces)
      || !sameContributions(snapshot.services, hello.services)) {
      throw new RuntimeSupervisorError('PLUGIN_RUNTIME_CONTRIBUTION_MISMATCH')
    }
    instance.hello = hello
  }

  /** 向 runtime 发送一次请求并等待同 requestId 的响应。 */
  private request(
    instance: RuntimeInstance,
    kind: PendingRequest['kind'],
    method: RuntimeHostMethod,
    payload: Record<string, unknown>,
    signal?: AbortSignal,
    invocationId?: string,
    timeoutMs?: number,
  ): Promise<unknown> {
    if (instance !== this.instance || instance.draining && kind !== 'dispose') {
      return Promise.reject(new RuntimeSupervisorError('PLUGIN_RUNTIME_NOT_RUNNING'))
    }
    if (signal?.aborted) return Promise.reject(new RuntimeSupervisorError('PLUGIN_TOOL_CANCELLED'))
    const requestId = this.uuid()
    let resolve!: (value: unknown) => void
    let reject!: (error: Error) => void
    const promise = new Promise<unknown>((accept, fail) => { resolve = accept; reject = fail })
    const limit = timeoutMs ?? Math.max(1, Math.min(10 * 60_000, Number(payload.deadline ?? Date.now() + 30_000) - Date.now()))
    const timer = setTimeout(() => {
      const pending = instance.pending.get(requestId)
      if (!pending) return
      instance.pending.delete(requestId)
      pending.removeAbort?.()
      this.send(instance, {
        protocolVersion: 1,
        kind: 'cancel',
        requestId: this.uuid(),
        targetRequestId: requestId,
        reason: 'timeout',
      })
      pending.reject(new RuntimeSupervisorError('PLUGIN_RPC_TIMEOUT'))
    }, limit + this.invocationTimeoutGraceMs)
    const pending: PendingRequest = {
      requestId,
      kind,
      promise,
      resolve,
      reject,
      timer,
      ...(invocationId ? { invocationId } : {}),
      ...(typeof payload.moduleId === 'string' ? { moduleId: payload.moduleId } : {}),
      ...(typeof payload.sessionId === 'string' ? { sessionId: payload.sessionId } : {}),
      ...(typeof payload.projectId === 'string' || payload.projectId === null ? { projectId: payload.projectId } : {}),
      ...(typeof payload.runId === 'string' ? { runId: payload.runId } : {}),
      ...(typeof payload.readOnly === 'boolean' ? { readOnly: payload.readOnly } : {}),
    }
    if (signal) {
      const abort = (): void => {
        if (!instance.pending.delete(requestId)) return
        clearTimeout(timer)
        this.send(instance, {
          protocolVersion: 1,
          kind: 'cancel',
          requestId: this.uuid(),
          targetRequestId: requestId,
          reason: 'abort',
        })
        reject(new RuntimeSupervisorError(kind === 'tool' ? 'PLUGIN_TOOL_CANCELLED' : 'PLUGIN_SURFACE_CANCELLED'))
      }
      signal.addEventListener('abort', abort, { once: true })
      pending.removeAbort = () => signal.removeEventListener('abort', abort)
    }
    instance.pending.set(requestId, pending)
    const command = {
      protocolVersion: 1,
      kind: 'request',
      requestId,
      method,
      payload,
    } as PluginRuntimeCommand
    try {
      this.send(instance, command)
    } catch {
      this.fail(instance, 'PLUGIN_RUNTIME_PROCESS_ERROR')
      this.kill(instance)
    }
    return promise
  }

  /** 发送消息并在失败时触发稳定错误。 */
  private send(instance: RuntimeInstance, message: PluginRuntimeCommand | PluginRuntimeMessage): void {
    instance.process.postMessage(message)
  }

  /** 处理 runtime 发来的握手、RPC 响应、事件和能力请求。 */
  private handleMessage(instance: RuntimeInstance, raw: unknown): void {
    if (instance !== this.instance) return
    const message = unwrapMessage(raw)
    if (!isRuntimeMessage(message)) {
      this.fail(instance, 'PLUGIN_RUNTIME_PROTOCOL_INVALID')
      this.kill(instance)
      return
    }
    if (message.kind === 'event' && message.event === 'runtime.hello') {
      if (instance.hello) {
        this.fail(instance, 'PLUGIN_RUNTIME_PROTOCOL_INVALID')
        return
      }
      const hello = message.payload
      const startupError = (() => {
        try {
          this.assertHello(instance, hello)
          return undefined
        } catch (error) {
          return error instanceof RuntimeSupervisorError ? error : new RuntimeSupervisorError('PLUGIN_RUNTIME_START_FAILED')
        }
      })()
      if (startupError) instance.helloReject?.(startupError)
      else instance.helloResolve?.(hello)
      instance.helloResolve = undefined
      instance.helloReject = undefined
      return
    }
    if (message.kind === 'response') {
      const pending = instance.pending.get(message.requestId)
      if (!pending) return
      instance.pending.delete(message.requestId)
      clearTimeout(pending.timer)
      pending.removeAbort?.()
      if (message.ok) pending.resolve(message.value)
      else pending.reject(new RuntimeSupervisorError(message.error.code))
      return
    }
    if (message.kind === 'request' && message.method === 'capability.invoke') {
      void this.handleCapabilityRequest(instance, message.requestId, message.payload)
      return
    }
    if (message.kind === 'request' && message.method === 'event.emit') {
      this.onEvent?.(message.payload)
      return
    }
    if (message.kind === 'request' && message.method === 'log.write') {
      return
    }
    this.fail(instance, 'PLUGIN_RUNTIME_PROTOCOL_INVALID')
    this.kill(instance)
  }

  /** 能力请求通过宿主注入的 Broker，响应必须使用同一 requestId。 */
  private async handleCapabilityRequest(
    instance: RuntimeInstance,
    requestId: string,
    payload: Extract<PluginRuntimeMessage, { kind: 'request'; method: 'capability.invoke' }>['payload'],
  ): Promise<void> {
    const activeInvocation = [...instance.pending.values()].find(entry => entry.kind === 'tool' || entry.kind === 'surface')
    let result: PluginCapabilityResult
    try {
      result = this.onCapabilityRequest
        ? await this.onCapabilityRequest({
          capability: payload.capability,
          input: payload.input,
          invocationId: payload.invocationId,
          moduleId: activeInvocation?.invocationId === payload.invocationId ? activeInvocation.moduleId ?? null : null,
          sessionId: activeInvocation?.sessionId ?? null,
          projectId: activeInvocation?.projectId ?? null,
          runId: activeInvocation?.runId ?? null,
          readOnly: activeInvocation?.readOnly ?? null,
          pluginId: instance.snapshot.pluginId,
          pluginVersion: instance.snapshot.pluginVersion,
          packageHash: instance.snapshot.packageHash,
        })
        : { ok: false, code: 'PLUGIN_CAPABILITY_NOT_AVAILABLE', message: '宿主未注册该能力', retryable: false }
    } catch {
      result = { ok: false, code: 'PLUGIN_CAPABILITY_FAILED', message: '宿主能力调用失败', retryable: false }
    }
    this.send(instance, {
      protocolVersion: 1,
      kind: 'response',
      requestId,
      ok: true,
      value: result,
    })
  }

  /** 进程退出时拒绝所有未完成调用；只要不是宿主主动 stop 都标记失败。 */
  private handleExit(instance: RuntimeInstance, code: number | null): void {
    if (instance !== this.instance) return
    const wasDraining = instance.draining
    const codeName = code === null ? 'unknown' : String(code)
    for (const pending of instance.pending.values()) {
      clearTimeout(pending.timer)
      pending.removeAbort?.()
      pending.reject(new RuntimeSupervisorError('PLUGIN_RUNTIME_EXITED'))
    }
    instance.pending.clear()
    instance.helloReject?.(new RuntimeSupervisorError('PLUGIN_RUNTIME_EXITED'))
    instance.helloReject = undefined
    instance.helloResolve = undefined
    if (instance.startupTimer) clearTimeout(instance.startupTimer)
    if (this.instance === instance) this.instance = undefined
    this.health = {
      pluginId: instance.snapshot.pluginId,
      state: wasDraining ? 'stopped' : 'failed',
      epoch: instance.epoch,
      ...(wasDraining ? {} : { errorCode: code === 0 ? 'PLUGIN_RUNTIME_EXITED' : `PLUGIN_RUNTIME_EXITED:${codeName}` }),
    }
  }

  /** 标记实例失败并拒绝等待中的启动。 */
  private fail(instance: RuntimeInstance, errorCode: string): void {
    if (instance !== this.instance) return
    instance.healthy = false
    this.health = { pluginId: instance.snapshot.pluginId, state: 'failed', epoch: instance.epoch, errorCode }
    const error = new RuntimeSupervisorError(errorCode)
    instance.helloReject?.(error)
    instance.helloReject = undefined
    for (const pending of instance.pending.values()) {
      clearTimeout(pending.timer)
      pending.removeAbort?.()
      pending.reject(error)
    }
    instance.pending.clear()
  }

  /** 只向当前有效实例发送 kill，丢失 exit 时仍由健康状态阻断调用。 */
  private kill(instance: RuntimeInstance): void {
    try { instance.process.kill() } catch { /* 以后续 exit 或上层超时为准。 */ }
  }

  /** 返回健康实例，否则 fail closed。 */
  private requireRunning(): RuntimeInstance {
    const instance = this.instance
    if (!instance || !instance.healthy || this.health.state !== 'running') {
      throw new RuntimeSupervisorError('PLUGIN_RUNTIME_NOT_RUNNING')
    }
    return instance
  }
}
