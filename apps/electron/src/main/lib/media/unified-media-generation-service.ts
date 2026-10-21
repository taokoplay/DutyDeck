import type { MediaAssetRef, MediaGenerationRequest, MediaGenerationSnapshot, MediaInputValue, MediaKind } from '@dutydeck/shared'
import { assertVisualProductionId, parseMediaGenerationRequest } from '@dutydeck/shared'
import type { UnifiedMediaModelRoute } from './unified-media-model-catalog'
import { UnifiedMediaGenerationStore, mediaIdentityHash, mediaOperationRunId, parseMediaRemoteTask, type StoredMediaGeneration } from './unified-media-generation-store'

/** 适配器生成的原始媒体结果；字节只在主进程内流转。 */
export interface UnifiedMediaGenerationAdapterOutput {
  bytes: Uint8Array
  contentType: string
  outputKey?: string
}

/** 供应商异步任务的最小可恢复身份，不允许附带路由与响应体。 */
export interface UnifiedMediaRemoteTask {
  /** 供应商返回的稳定任务标识。 */
  taskId: string
}

/** 各供应商适配器只负责请求与响应，任务归属和资产登记由 Facade 统一处理。 */
export interface UnifiedMediaGenerationAdapter {
  id: string
  /** 明确支持按已保存任务只查询，禁止恢复时再次提交生成。 */
  supportsResume?: boolean
  /** 同步校验并冻结实际默认输入；不得访问网络或产生文件。 */
  prepareInputs?(input: { request: MediaGenerationRequest; route: UnifiedMediaModelRoute }): Record<string, MediaInputValue>
  generate(input: { request: MediaGenerationRequest; route: UnifiedMediaModelRoute; signal: AbortSignal; remoteTask?: UnifiedMediaRemoteTask; onRemoteTask?: (task: UnifiedMediaRemoteTask) => void }): Promise<UnifiedMediaGenerationAdapterOutput[]>
}

/** 仅承载主进程适配器明确映射的安全用户提示，原始供应商日志仍统一屏蔽。 */
export class MediaGenerationUserError extends Error {}

/** 可安全展示但无法确认供应商结果的错误，不能指导自动重新提交。 */
export class MediaGenerationOutcomeUnknownError extends MediaGenerationUserError {}

/** 主进程统一媒体运行入口，Agent 与 Canvas 可共享同一实例。 */
export interface UnifiedMediaGenerationServiceOptions {
  resolveModel(modelRef: string): UnifiedMediaModelRoute
  adapters: readonly UnifiedMediaGenerationAdapter[]
  registerOutput(projectId: string, operationId: string, bytes: Uint8Array, contentType: string, origin: { mediaRunId: string; sourceSessionId: string }, expectedMediaKind: MediaKind): Promise<MediaAssetRef>
  /** 生产宿主注入的专用任务目录；省略仅用于临时内存实例。 */
  storageDirectory?: string
  now?: () => number
}

/** 可信主进程冻结的影像归属，不开放为 Agent 工具参数。 */
export interface UnifiedMediaVisualProductionBinding {
  /** 所属影像作品。 */
  productionId: string
  /** 发起制作任务。 */
  jobId: string
  /** 任务冻结的正式版本。 */
  baseRevision: number
}

/** 内存只补充控制句柄；路由凭据只在一次实际请求的局部参数内存活。 */
interface GenerationRecord extends StoredMediaGeneration {
  /** 当前查询/生成的取消句柄。 */
  controller?: AbortController
  /** 同进程并发执行共享一个 Promise。 */
  task?: Promise<void>
  /** 当前正在等待 revision 的订阅者。 */
  waiters: Set<() => void>
}

/** 统一媒体运行 Facade；每个 Agent 会话只能访问自己准备的任务。 */
export class UnifiedMediaGenerationService {
  private readonly records = new Map<string, GenerationRecord>()
  private readonly adapters = new Map<string, UnifiedMediaGenerationAdapter>()
  private readonly now: () => number
  /** 可选文件存储由宿主提供目录，测试可保留内存模式。 */
  private readonly store?: UnifiedMediaGenerationStore

  constructor(private readonly options: UnifiedMediaGenerationServiceOptions) {
    this.now = options.now ?? Date.now
    this.store = options.storageDirectory ? new UnifiedMediaGenerationStore(options.storageDirectory) : undefined
    for (const adapter of options.adapters) this.adapters.set(adapter.id, adapter)
  }

  /** 校验模型并冻结一次生成意图，不触发远端请求。 */
  prepare(ownerSessionId: string, raw: MediaGenerationRequest): MediaGenerationSnapshot {
    const parsed = parseMediaGenerationRequest(raw)
    /** 固定身份与原始意图摘要用于跨重启幂等，不依赖当前默认参数。 */
    const runId = mediaOperationRunId(ownerSessionId, parsed)
    const intentHash = mediaIdentityHash(parsed)
    const existing = this.findOwned(ownerSessionId, runId)
    if (existing) {
      if (existing.intentHash !== intentHash) throw new Error('MEDIA_GENERATION_OPERATION_CONFLICT')
      return this.copy(existing.snapshot)
    }
    const route = this.options.resolveModel(parsed.modelRef)
    if (!route.option.available) throw new Error('MEDIA_MODEL_UNAVAILABLE')
    /** 适配器只可补全输入，不能改变项目、模型、操作或提示词身份。 */
    const adapter = route.option.adapterId ? this.adapters.get(route.option.adapterId) : undefined
    if (!adapter) throw new Error('MEDIA_MODEL_UNAVAILABLE')
    const request = adapter.prepareInputs ? parseMediaGenerationRequest({ ...parsed, inputs: adapter.prepareInputs({ request: parsed, route }) }) : parsed
    validateMediaInputCompatibility(request, route)
    const now = this.now()
    const snapshot: MediaGenerationSnapshot = {
      id: runId, projectId: request.projectId, revision: 0, phase: 'prepared', modelRef: request.modelRef,
      mediaKind: route.option.kind, createdAt: now, updatedAt: now, outputs: [], error: null,
    }
    /** 先持久化准备状态，失败时不暴露可执行任务。 */
    const record: GenerationRecord = { version: 1, ownerSessionId, request, intentHash, routeHash: routeIdentity(route), adapterId: adapter.id, snapshot, waiters: new Set() }
    this.persist(record, null)
    this.records.set(snapshot.id, record)
    return this.copy(snapshot)
  }

  /**
   * 为尚未执行的媒体任务固定影像归属；同值调用幂等，禁止跨会话或改派。
   * @param ownerSessionId 已授权会话身份。
   * @param runId 该会话准备的媒体任务。
   * @param binding 宿主已验证的影像任务身份，不接受工具直接填报。
   */
  bindVisualProduction(ownerSessionId: string, runId: string, binding: UnifiedMediaVisualProductionBinding): void {
    const record = this.requireOwned(ownerSessionId, runId)
    assertVisualProductionId(binding.productionId)
    assertVisualProductionId(binding.jobId)
    if (!Number.isSafeInteger(binding.baseRevision) || binding.baseRevision < 1) throw new Error('MEDIA_VISUAL_BINDING_INVALID')
    const previous = record.visualProduction
    if (previous) {
      if (previous.productionId !== binding.productionId || previous.jobId !== binding.jobId || previous.baseRevision !== binding.baseRevision) throw new Error('MEDIA_VISUAL_BINDING_CONFLICT')
      return
    }
    if (record.snapshot.phase !== 'prepared') throw new Error('MEDIA_VISUAL_BINDING_TOO_LATE')
    /** 绑定不修改对外 revision，但必须在暴露前原子落盘。 */
    const visualProduction = { productionId: binding.productionId, jobId: binding.jobId, baseRevision: binding.baseRevision }
    this.persist({ ...record, visualProduction }, record.snapshot.revision)
    record.visualProduction = visualProduction
  }

  /** 启动已准备任务；完成由内部任务推进，返回 running 快照。 */
  async execute(ownerSessionId: string, runId: string, expectedRevision: number, visualBinding?: UnifiedMediaVisualProductionBinding): Promise<MediaGenerationSnapshot> {
    const record = this.requireOwned(ownerSessionId, runId)
    /** 已绑定任务只能由复核过存活状态的影像包装器执行，普通跨轮调用不得绕过。 */
    const binding = record.visualProduction
    if (binding && (!visualBinding || binding.productionId !== visualBinding.productionId || binding.jobId !== visualBinding.jobId || binding.baseRevision !== visualBinding.baseRevision)) throw new Error('MEDIA_VISUAL_BINDING_REQUIRED')
    if (record.snapshot.revision !== expectedRevision) throw new Error('MEDIA_GENERATION_REVISION_CONFLICT')
    if (record.snapshot.phase === 'succeeded' || record.snapshot.phase === 'failed' || record.snapshot.phase === 'cancelled') return this.copy(record.snapshot)
    if (record.task) return this.copy(record.snapshot)
    if (record.snapshot.phase === 'unknown' && !record.remoteTask) throw new Error('MEDIA_GENERATION_OUTCOME_UNKNOWN')
    /** 每次开始/续查都重新解析凭据；密钥轮换允许，路由身份变化拒绝。 */
    const route = this.options.resolveModel(record.request.modelRef)
    if (!route.option.available) throw new Error('MEDIA_MODEL_UNAVAILABLE')
    if (routeIdentity(route) !== record.routeHash) throw new Error('MEDIA_GENERATION_MODEL_CHANGED')
    validateMediaInputCompatibility(record.request, route)
    const adapter = this.adapters.get(record.adapterId)
    if (!adapter) throw new Error('MEDIA_MODEL_UNAVAILABLE')
    if (record.snapshot.phase !== 'prepared' && (!record.remoteTask || !adapter.supportsResume)) throw new Error('MEDIA_GENERATION_OUTCOME_UNKNOWN')
    record.controller = new AbortController()
    this.update(record, { phase: 'running', error: null })
    record.task = this.runAdapter(record, adapter, route).finally(() => { record.task = undefined })
    return this.copy(record.snapshot)
  }

  /** 获取指定会话持有的任务快照。 */
  get(ownerSessionId: string, runId: string): MediaGenerationSnapshot {
    return this.copy(this.requireOwned(ownerSessionId, runId).snapshot)
  }

  /** 为原卡回填读取指定会话的冻结输入与运行事实；返回独立副本，不包含路由凭据。 */
  getAttachmentSource(ownerSessionId: string, runId: string): { request: MediaGenerationRequest; snapshot: MediaGenerationSnapshot; visualProduction?: UnifiedMediaVisualProductionBinding } {
    /** 所有权验证与普通查询使用同一入口。 */
    const record = this.requireOwned(ownerSessionId, runId)
    return structuredClone({ request: record.request, snapshot: record.snapshot, ...(record.visualProduction ? { visualProduction: record.visualProduction } : {}) })
  }

  /** 等待 revision 变化或终态；超时只返回当前快照，不取消远端任务。 */
  async wait(ownerSessionId: string, runId: string, timeoutMs = 30_000, afterRevision?: number, signal?: AbortSignal): Promise<MediaGenerationSnapshot> {
    const record = this.requireOwned(ownerSessionId, runId)
    const baseline = afterRevision ?? -1
    if (signal?.aborted) throw new Error('MEDIA_GENERATION_WAIT_ABORTED')
    /** wait 仅恢复已保存的远端查询，永远不启动 prepared 或未知提交。 */
    if (!record.visualProduction && !record.task && record.remoteTask && ['running', 'unknown'].includes(record.snapshot.phase) && this.adapters.get(record.adapterId)?.supportsResume) {
      await this.execute(ownerSessionId, runId, record.snapshot.revision)
    }
    if (record.snapshot.revision > baseline || ['succeeded', 'failed', 'cancelled', 'unknown'].includes(record.snapshot.phase)) return this.copy(record.snapshot)
    if (signal?.aborted) throw new Error('MEDIA_GENERATION_WAIT_ABORTED')
    await new Promise<void>((resolve, reject) => {
      /** 所有结束路径都移除订阅，避免未知远端任务反复 wait 时累积闭包。 */
      const cleanup = (): void => {
        clearTimeout(timer)
        signal?.removeEventListener('abort', onAbort)
        record.waiters.delete(wake)
      }
      /** revision 更新或等待超时只结束本次等待，不取消供应商任务。 */
      const wake = (): void => { cleanup(); resolve() }
      /** 调用方取消只释放本次订阅。 */
      const onAbort = (): void => { cleanup(); reject(new Error('MEDIA_GENERATION_WAIT_ABORTED')) }
      /** 限制每次等待时长，远端任务状态由后台执行持有。 */
      const timer = setTimeout(wake, Math.max(0, Math.min(timeoutMs, 30_000)))
      record.waiters.add(wake)
      signal?.addEventListener('abort', onAbort, { once: true })
    })
    return this.copy(record.snapshot)
  }

  /** 明确取消任务；迟到的供应商响应不会复活已取消任务。 */
  cancel(ownerSessionId: string, runId: string): MediaGenerationSnapshot {
    const record = this.requireOwned(ownerSessionId, runId)
    if (['succeeded', 'failed', 'cancelled'].includes(record.snapshot.phase)) return this.copy(record.snapshot)
    this.update(record, { phase: 'cancelled', error: null })
    record.controller?.abort()
    return this.copy(record.snapshot)
  }

  /** 执行适配器并把结果登记为项目媒体资产。 */
  private async runAdapter(record: GenerationRecord, adapter: UnifiedMediaGenerationAdapter, route: UnifiedMediaModelRoute): Promise<void> {
    try {
      const outputs = await adapter.generate({
        request: structuredClone(record.request), route, signal: record.controller!.signal,
        ...(record.remoteTask ? { remoteTask: { ...record.remoteTask } } : {}),
        onRemoteTask: (task) => {
          if (this.isCancelled(record)) throw new Error('MEDIA_GENERATION_CANCELLED')
          const remoteTask = parseMediaRemoteTask(task)
          if (record.remoteTask && record.remoteTask.taskId !== remoteTask.taskId) throw new Error('MEDIA_REMOTE_TASK_CONFLICT')
          /** 回调同步完成磁盘提交后，适配器才可继续轮询。 */
          this.persist({ ...record, remoteTask }, record.snapshot.revision)
          record.remoteTask = remoteTask
        },
      })
      if (this.isCancelled(record)) return
      const assets: MediaGenerationSnapshot['outputs'] = []
      for (const [index, output] of outputs.entries()) {
        if (this.isCancelled(record)) return
        const outputKey = output.outputKey ?? `output-${index + 1}`
        const asset = await this.options.registerOutput(record.request.projectId, `${record.snapshot.id}:${outputKey}`, output.bytes, output.contentType, {
          mediaRunId: record.snapshot.id, sourceSessionId: record.ownerSessionId,
        }, record.snapshot.mediaKind)
        /** 资产服务可带额外内部字段，任务协议仅保存严格的引用投影。 */
        assets.push({ outputKey, asset: { assetId: asset.assetId, revision: asset.revision, hash: asset.hash, mediaKind: asset.mediaKind } })
      }
      /** 登记产物期间也可能收到取消；取消状态拥有终态优先级，不能被迟到结果覆盖。 */
      if (this.isCancelled(record)) return
      if (assets.length === 0) throw new Error('MEDIA_GENERATION_OUTPUT_MISSING')
      this.update(record, { phase: 'succeeded', outputs: assets, error: null })
    } catch (error) {
      if (this.isCancelled(record)) return
      const message = error instanceof MediaGenerationUserError ? error.message : error instanceof Error && /^[A-Z][A-Z0-9_]+$/.test(error.message) ? error.message : 'MEDIA_GENERATION_FAILED'
      /** 请求一旦开始，普通网络/超时错误不能证明未收费；保存 unknown 禁止盲重发。 */
      /** 远端明确终态或首次提交被明确拒绝才算失败；续查鉴权错误仍可修复后恢复。 */
      const confirmedFailure = (error instanceof MediaGenerationUserError && !(error instanceof MediaGenerationOutcomeUnknownError)) || message === 'MEDIA_ADAPTER_REMOTE_FAILED'
        || (!record.remoteTask && ['MEDIA_ADAPTER_AUTH_FAILED', 'MEDIA_ADAPTER_QUOTA_EXCEEDED', 'MEDIA_ADAPTER_RATE_LIMITED'].includes(message))
      const phase = confirmedFailure ? 'failed' : 'unknown'
      try { this.update(record, { phase, error: message }) } catch {
        /** 落盘失败保留磁盘 running 证据，内存 fail closed 且避免后台未处理拒绝。 */
        record.snapshot = { ...record.snapshot, phase: 'unknown', error: 'MEDIA_GENERATION_PERSISTENCE_FAILED' }
        for (const wake of record.waiters) wake()
        record.waiters.clear()
      }
    }
  }

  /** 按会话校验任务归属，避免模型通过猜测 ID 读取其它会话产物。 */
  private requireOwned(ownerSessionId: string, runId: string): GenerationRecord {
    const record = this.findOwned(ownerSessionId, runId)
    if (!record || record.ownerSessionId !== ownerSessionId) throw new Error('MEDIA_GENERATION_NOT_OWNED')
    return record
  }

  /** 原子推进 revision 并唤醒等待者。 */
  private update(record: GenerationRecord, patch: Partial<MediaGenerationSnapshot>): void {
    const snapshot = { ...record.snapshot, ...patch, revision: record.snapshot.revision + 1, updatedAt: this.now() }
    this.persist({ ...record, snapshot }, record.snapshot.revision)
    record.snapshot = snapshot
    const waiters = [...record.waiters]
    record.waiters.clear()
    for (const wake of waiters) wake()
  }

  /** 懒加载指定 owner/run；无法安全续查的崩溃任务冻结为 unknown。 */
  private findOwned(ownerSessionId: string, runId: string): GenerationRecord | undefined {
    const cached = this.records.get(runId)
    if (cached) {
      if (cached.ownerSessionId !== ownerSessionId) throw new Error('MEDIA_GENERATION_NOT_OWNED')
      return cached
    }
    const stored = this.store?.load(ownerSessionId, runId)
    if (!stored) return undefined
    const record: GenerationRecord = { ...stored, waiters: new Set() }
    if (['running', 'queued'].includes(record.snapshot.phase) && (!record.remoteTask || !this.adapters.get(record.adapterId)?.supportsResume)) {
      this.update(record, { phase: 'unknown', error: 'MEDIA_GENERATION_OUTCOME_UNKNOWN' })
    }
    this.records.set(runId, record)
    return record
  }

  /** 显式白名单投影，控制器、Promise、route 和凭据永远不进入 JSON。 */
  private persist(record: GenerationRecord, expectedRevision: number | null): void {
    this.store?.save({
      version: 1, ownerSessionId: record.ownerSessionId, request: record.request,
      intentHash: record.intentHash, routeHash: record.routeHash, adapterId: record.adapterId, snapshot: record.snapshot,
      ...(record.remoteTask ? { remoteTask: record.remoteTask } : {}),
      ...(record.visualProduction ? { visualProduction: record.visualProduction } : {}),
    }, expectedRevision)
  }

  /** 返回脱离内部可变对象的任务快照。 */
  private copy(snapshot: MediaGenerationSnapshot): MediaGenerationSnapshot {
    return { ...snapshot, outputs: snapshot.outputs.map((output) => ({ ...output, asset: { ...output.asset } })) }
  }

  /** 通过方法读取可变任务状态，避免 TypeScript 把跨 await 的快照错误收窄。 */
  private isCancelled(record: GenerationRecord): boolean {
    return record.snapshot.phase === 'cancelled'
  }
}

/** 仅取出标量输入供供应商请求体使用，媒体资产由未来图生视频适配器按引用读取。 */
export function scalarInput(inputs: Record<string, MediaInputValue>, key: string): string | number | boolean | undefined {
  const value = inputs[key]
  return value?.kind === 'scalar' ? value.value : undefined
}

/** 根据模型能力校验素材输入，阻止把错误媒体类型或未支持的输入静默交给供应商。 */
function validateMediaInputCompatibility(request: MediaGenerationRequest, route: UnifiedMediaModelRoute): void {
  const assets = Object.values(request.inputs).filter((value): value is Extract<MediaInputValue, { kind: 'asset' }> => value.kind === 'asset')
  const capabilities = new Set(route.option.capabilities)
  const hasAssets = assets.length > 0
  if (route.option.kind === 'audio') {
    if (hasAssets && !capabilities.has('voice-cloning')) throw new Error('MEDIA_GENERATION_INPUT_INVALID')
    if (!hasAssets && !capabilities.has('text-to-speech') && !capabilities.has('text-to-music')) throw new Error('MEDIA_GENERATION_INPUT_INVALID')
    return
  }
  if (assets.some((value) => value.asset.mediaKind !== 'image')) throw new Error('MEDIA_GENERATION_INPUT_INVALID')
  if (route.option.kind === 'image') {
    /** 即梦执行器保留全部十张参考，其他执行器继续遵守当前单图协议。 */
    const maxReferences = route.option.adapterId === 'dreamina-image' ? 10 : 1
    if (assets.length > maxReferences) throw new Error('MEDIA_GENERATION_MULTIPLE_REFERENCES_UNSUPPORTED')
    if (hasAssets && !capabilities.has('image-to-image')) throw new Error('MEDIA_GENERATION_INPUT_INVALID')
    if (!hasAssets && !capabilities.has('text-to-image')) throw new Error('MEDIA_GENERATION_INPUT_INVALID')
    return
  }
  if (assets.length > 1) throw new Error('MEDIA_GENERATION_INPUT_INVALID')
  if (hasAssets && !capabilities.has('image-to-video')) throw new Error('MEDIA_GENERATION_INPUT_INVALID')
  if (!hasAssets && !capabilities.has('text-to-video')) throw new Error('MEDIA_GENERATION_INPUT_INVALID')
}

/** 冻结模型、执行器与端点身份，但不包括可轮换 API Key；磁盘仅保存摘要。 */
function routeIdentity(route: UnifiedMediaModelRoute): string {
  return mediaIdentityHash({ ref: route.ref, adapterId: route.option.adapterId, kind: route.option.kind, baseUrl: route.baseUrl, cliPath: route.cliPath, groupId: route.groupId, resolutionType: route.resolutionType })
}
