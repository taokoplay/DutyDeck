import { resolveVisualShotOutputs } from '@dutydeck/shared'
import { createHash, randomUUID } from 'node:crypto'
import type { VisualMedia, VisualProductionSnapshot } from '@dutydeck/shared'
import type { VisualProductionExecutor } from './access'
import type { VisualTaskContextEvent } from './context-contract'
import type { MediaDeliveryInspectionResult, MediaDeliveryInspectionSummary } from '../media/media-delivery-inspection-service'

/** 精确对象范围，作品级范围只提供元数据，不隐式授权全部素材。 */
export type VisualTaskTarget = { kind: 'production' } | { kind: 'shot'; shotId: string } | { kind: 'asset'; assetId: string }
/** 打开范围的模型输入，不包含任意路径或客户端授权。 */
export interface VisualTaskContextOpenInput {
  productionId: string
  productionRevision: number
  target: VisualTaskTarget
  objective: string
  continuityShotIds?: string[]
  candidateId?: string
}
/** 单项检查的宿主事实；模型结论与技术检测分开保存。 */
export interface VisualContextEvidence {
  evidenceId: string
  mediaId: string
  mediaHash: string
  kind: VisualMedia['kind']
  /** technical 表示仅检查技术事实，不能作为看图或听觉验收。 */
  inspectionKind?: 'visual' | 'technical'
  inspection?: MediaDeliveryInspectionSummary
  unchecked: string[]
}
/** 可追溯模型观察，不代表重新打开后已经重新看过图片。 */
export interface VisualContextObservation {
  version: 1
  id: string
  workspaceId: string
  sessionId: string
  runId: string
  contextId: string
  productionId: string
  productionRevision: number
  scopeKey: string
  target: VisualTaskTarget
  objective: string
  conclusion: string
  unchecked: string[]
  evidence: VisualContextEvidence[]
  createdAt: number
}
/** 可信主进程持久化端口，禁止持久化本轮授权。 */
export interface VisualContextEvidenceStore {
  list(productionId: string, scopeKey: string, runId?: string): VisualContextObservation[]
  append(observation: VisualContextObservation): void
}
/** 主/子运行共用的只读范围描述。 */
export interface VisualTaskContextDescription {
  contextId: string
  runId: string
  workspaceId: string
  sessionId: string
  openInput: VisualTaskContextOpenInput
  media: VisualMedia[]
  observations: VisualContextObservation[]
}
/** 工具样本仅留给 Pi 临时请求投影，正文保存可追溯身份。 */
export interface VisualTaskToolResult {
  content: Array<{ type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string }>
  details: { visualTaskContext: VisualTaskContextEvent; [key: string]: unknown }
}
/** 写结论输入只有已登记证据身份，不接受外部素材地址。 */
export interface VisualTaskRecordInput {
  contextId: string
  evidenceIds: string[]
  objective: string
  conclusion: string
  unchecked: string[]
}
/** 运行依赖只从可信宿主装配。 */
export interface VisualTaskContextRuntimeOptions {
  runId: string
  sessionId: string
  access: VisualProductionExecutor
  evidenceStore?: VisualContextEvidenceStore
  assertWrite?: () => void | Promise<void>
  inspectMedia?: (input: { productionId: string; media: VisualMedia; bytes: Uint8Array }, signal?: AbortSignal) => Promise<MediaDeliveryInspectionResult>
}
/** 生命周期 API；describe 复核范围可供受限子任务撤销检查。 */
export interface VisualTaskContextRuntime {
  open(input: VisualTaskContextOpenInput, signal?: AbortSignal): Promise<VisualTaskToolResult>
  describe(contextId: string, signal?: AbortSignal, observationRunId?: string): Promise<VisualTaskContextDescription>
  /** 同步复验父范围，防异步撤销间隙写入迟到结论。 */
  assertContextActive(contextId: string): void
  inspect(input: { contextId: string; mediaId: string }, signal?: AbortSignal): Promise<VisualTaskToolResult>
  record(input: VisualTaskRecordInput, signal?: AbortSignal): Promise<VisualTaskToolResult>
  close(input: { contextId: string }): Promise<VisualTaskToolResult>
  dispose(): void
}
/** 内存范围与结论文件分离；fingerprint 防同版本资料被替换。 */
interface ActiveScope { description: VisualTaskContextDescription; fingerprint: string; evidence: Map<string, VisualContextEvidence> }
/** 有界可打印文本，不静默截断用户检查要求。 */
function assertText(value: string, max: number): void {
  if (typeof value !== 'string' || !value.trim() || value.length > max) throw new Error('VISUAL_CONTEXT_INVALID_INPUT')
}
/** 根据正式对象关系选图，候选只能扩展同一个对象的候选输出。 */
function resolveMedia(snapshot: VisualProductionSnapshot, input: VisualTaskContextOpenInput): VisualMedia[] {
  if (snapshot.document.id !== input.productionId || snapshot.document.revision !== input.productionRevision) throw new Error('VISUAL_CONTEXT_VERSION_CHANGED: 请重新读取正式作品')
  /** 正式绑定才构成素材授权，连续性必须显式声明。 */
  const selected = new Set<string>()
  /** 单次索引仅解析当前范围内的正式或显式候选输出。 */
  const mediaById = new Map(snapshot.media.map(item => [item.id, item]))
  const add = (id: string | null | undefined): void => { if (id) selected.add(id) }
  const assets = new Map(snapshot.document.assets.map(asset => [asset.id, asset]))
  const addShot = (shotId: string): void => {
    const shot = snapshot.document.shots.find(item => item.id === shotId)
    if (!shot) throw new Error('VISUAL_CONTEXT_TARGET_MISSING')
    Object.values(resolveVisualShotOutputs(shot, mediaById)).forEach(add)
    for (const assetId of shot.assetIds) {
      const asset = assets.get(assetId)
      if (!asset) throw new Error('VISUAL_CONTEXT_TARGET_MISSING')
      add(asset.mediaId)
    }
  }
  if (input.target.kind === 'shot') addShot(input.target.shotId)
  else if (input.target.kind === 'asset') {
    const asset = assets.get(input.target.assetId)
    if (!asset) throw new Error('VISUAL_CONTEXT_TARGET_MISSING')
    add(asset.mediaId)
  } else if (input.target.kind !== 'production') throw new Error('VISUAL_CONTEXT_INVALID_INPUT')
  if ((input.continuityShotIds?.length ?? 0) > 4) throw new Error('VISUAL_CONTEXT_SCOPE_LIMIT')
  for (const shotId of input.continuityShotIds ?? []) addShot(shotId)
  if (input.candidateId) {
    const candidate = snapshot.candidates.find(item => item.id === input.candidateId)
    if (!candidate || !((candidate.status === 'ready' && candidate.baseRevision === input.productionRevision) || (candidate.status === 'adopted' && candidate.adoptedRevision === input.productionRevision))) throw new Error('VISUAL_CONTEXT_CANDIDATE_STALE')
    const job = snapshot.jobs.find(item => item.id === candidate.jobId)
    if (!job || job.status === 'cancelled' || job.status === 'failed' || job.status === 'interrupted') throw new Error('VISUAL_CONTEXT_CANDIDATE_STALE')
    if (input.target.kind === 'shot') {
      const targetId = input.target.shotId
      if (job.shotId && job.shotId !== targetId) throw new Error('VISUAL_CONTEXT_OUT_OF_SCOPE')
      const shot = candidate.draft.shots.find(item => item.id === targetId)
      if (!shot) throw new Error('VISUAL_CONTEXT_TARGET_MISSING')
      Object.values(resolveVisualShotOutputs(shot, mediaById)).forEach(add)
    } else if (input.target.kind === 'asset') {
      if (job.shotId) throw new Error('VISUAL_CONTEXT_OUT_OF_SCOPE')
      const targetId = input.target.assetId
      const asset = candidate.draft.assets.find(item => item.id === targetId)
      if (!asset) throw new Error('VISUAL_CONTEXT_TARGET_MISSING')
      add(asset.mediaId)
    }
  }
  if (selected.size > 32) throw new Error('VISUAL_CONTEXT_SCOPE_LIMIT: 请缩小检查对象')
  const media = [...selected].map(id => {
    const item = snapshot.media.find(value => value.id === id)
    if (!item) throw new Error('VISUAL_CONTEXT_MEDIA_MISSING')
    return item
  })
  return media
}
/** 对象和媒体版本共同决定历史结论是否仍可参考。 */
function fingerprint(snapshot: VisualProductionSnapshot, input: VisualTaskContextOpenInput, media: VisualMedia[]): string {
  const { objective: _objective, ...identity } = input
  return createHash('sha256').update(JSON.stringify({ input: identity, media: media.map(item => [item.id, item.hash, item.kind, item.mime]), assetVersions: snapshot.assetVersions, shotStates: snapshot.shotStates })).digest('hex')
}
/** 建立本轮单一视觉范围；新范围替换旧范围，但不改正式作品和原始素材。 */
export function createVisualTaskContextRuntime(options: VisualTaskContextRuntimeOptions): VisualTaskContextRuntime {
  let active: ActiveScope | undefined
  let disposed = false
  let generation = 0
  /** 所有异步返回后复验，防取消、切项目和范围替换产生迟到授权。 */
  const assertCurrent = (signal?: AbortSignal): void => {
    signal?.throwIfAborted()
    if (disposed) throw new Error('VISUAL_CONTEXT_DISPOSED')
    options.access.assertCurrent()
  }
  /** 固定会话 load，调用者不能提供路径或改写归属。 */
  const load = async (input: VisualTaskContextOpenInput, signal?: AbortSignal): Promise<VisualProductionSnapshot> => {
    assertCurrent(signal)
    const snapshot = await options.access.execute('load', { sessionId: options.sessionId, productionId: input.productionId }, signal)
    assertCurrent(signal)
    return snapshot
  }
  /** 活跃身份检查不从持久摘要重新发放权限。 */
  const get = (contextId: string): ActiveScope => {
    assertCurrent()
    if (!active || active.description.contextId !== contextId) throw new Error('VISUAL_CONTEXT_INACTIVE')
    return active
  }
  /** 统一输出身份协议，正文始终有界。 */
  const result = (contextId: string, action: VisualTaskContextEvent['action'], body: object, extra: Partial<VisualTaskContextEvent> = {}): VisualTaskToolResult => {
    const text = JSON.stringify(body)
    if (text.length > 48 * 1024) throw new Error('VISUAL_CONTEXT_RESPONSE_LIMIT')
    return { content: [{ type: 'text', text }], details: { ...body, visualTaskContext: { version: 1, runId: options.runId, contextId, action, ...extra } } }
  }
  /** 历史摘要有独立预算，避免长结论再次撑爆下一轮上下文。 */
  const observationsFor = (productionId: string, scopeKey: string, runId?: string): VisualContextObservation[] => {
    const records = (options.evidenceStore?.list(productionId, scopeKey, runId) ?? []).filter(item => item.workspaceId === options.access.workspaceId && item.scopeKey === scopeKey && (runId === undefined || item.runId === runId)).slice(-4)
    while (records.length && JSON.stringify(records).length > 24 * 1024) records.pop()
    return records
  }
  /** 每次检查刷新正式版本与内容身份，旧结论只作追溯。 */
  const describe = async (contextId: string, signal?: AbortSignal, observationRunId?: string): Promise<VisualTaskContextDescription> => {
    const scope = get(contextId)
    const snapshot = await load(scope.description.openInput, signal)
    const media = resolveMedia(snapshot, scope.description.openInput)
    if (get(contextId) !== scope || fingerprint(snapshot, scope.description.openInput, media) !== scope.fingerprint) throw new Error('VISUAL_CONTEXT_VERSION_CHANGED')
    scope.description.observations = observationsFor(scope.description.openInput.productionId, scope.fingerprint, observationRunId)
    assertCurrent(signal)
    return structuredClone(scope.description)
  }
  return {
    async open(rawInput, signal) {
      assertText(rawInput.objective, 2000)
      if (!Number.isSafeInteger(rawInput.productionRevision) || rawInput.productionRevision < 1) throw new Error('VISUAL_CONTEXT_INVALID_INPUT')
      const input = structuredClone(rawInput)
      const ticket = ++generation
      const snapshot = await load(input, signal)
      const media = resolveMedia(snapshot, input)
      const scopeKey = fingerprint(snapshot, input, media)
      const observations = observationsFor(input.productionId, scopeKey)
      assertCurrent(signal)
      if (ticket !== generation) throw new Error('VISUAL_CONTEXT_SUPERSEDED')
      const description: VisualTaskContextDescription = { contextId: randomUUID(), runId: options.runId, workspaceId: options.access.workspaceId, sessionId: options.sessionId, openInput: input, media, observations }
      const response = result(description.contextId, 'open', { ...description, guidance: '已有结论仅供追溯；需要视觉判断时调用 inspect_media。作品范围不隐式加载全作品图片。' })
      active = { description, fingerprint: scopeKey, evidence: new Map() }
      return response
    },
    describe,
    assertContextActive(contextId) { get(contextId) },
    async inspect(input, signal) {
      const description = await describe(input.contextId, signal)
      const scope = get(input.contextId)
      const media = description.media.find(item => item.id === input.mediaId)
      if (!media) throw new Error('VISUAL_CONTEXT_OUT_OF_SCOPE')
      if (scope.evidence.size >= 32) throw new Error('VISUAL_CONTEXT_EVIDENCE_LIMIT')
      const content = await options.access.execute('mediaContent', { sessionId: options.sessionId, productionId: description.openInput.productionId, mediaId: media.id }, signal)
      assertCurrent(signal)
      if (content.mime !== media.mime || content.bytes.length !== media.byteSize || createHash('sha256').update(content.bytes).digest('hex') !== media.hash) throw new Error('VISUAL_CONTEXT_MEDIA_CHANGED')
      const evidence: VisualContextEvidence = { evidenceId: randomUUID(), mediaId: media.id, mediaHash: media.hash, kind: media.kind, unchecked: [] }
      const images: VisualTaskToolResult['content'] = []
      if (media.kind === 'image') images.push({ type: 'image', data: Buffer.from(content.bytes).toString('base64'), mimeType: media.mime })
      else if (options.inspectMedia) {
        const inspection = await options.inspectMedia({ productionId: description.openInput.productionId, media, bytes: content.bytes }, signal)
        if (inspection.summary.asset.hash !== media.hash || inspection.summary.asset.mediaKind !== media.kind) throw new Error('VISUAL_CONTEXT_MEDIA_CHANGED')
        if (inspection.samples.length > 12 || inspection.samples.reduce((sum, sample) => sum + sample.bytes.length, 0) > 32 * 1024 * 1024) throw new Error('VISUAL_CONTEXT_SAMPLE_LIMIT')
        evidence.inspection = inspection.summary
        evidence.unchecked = [...inspection.summary.unchecked]
        if (media.kind === 'video') for (const sample of inspection.samples) images.push({ type: 'image', data: Buffer.from(sample.bytes).toString('base64'), mimeType: sample.mediaType })
      } else if (media.kind === 'video') throw new Error('VISUAL_CONTEXT_INSPECTION_UNAVAILABLE: 视频抽帧服务尚未就绪')
      else evidence.unchecked = ['仅核对媒体身份和字节，未检查音频技术规格或声音内容']
      evidence.inspectionKind = images.length ? 'visual' : 'technical'
      if (!images.length) evidence.unchecked = [...new Set([...evidence.unchecked, '未查看视觉内容或听取声音内容；技术检查结果不代表内容验收'])]
      await describe(input.contextId, signal)
      if (get(input.contextId) !== scope) throw new Error('VISUAL_CONTEXT_INACTIVE')
      const response = result(input.contextId, 'inspect', { evidence, guidance: media.kind === 'audio' ? '没有听取声音内容，不能宣称听觉验收通过。' : '样本用于当前范围推理；完成后记录结论并关闭范围。视频抽帧不代表全片视觉验收。' }, { evidenceId: evidence.evidenceId, mediaId: media.id, mediaHash: media.hash, inspectionKind: evidence.inspectionKind })
      scope.evidence.set(evidence.evidenceId, evidence)
      response.content.push(...images)
      return response
    },
    async record(input, signal) {
      assertText(input.objective, 2000); assertText(input.conclusion, 8000)
      if (!Array.isArray(input.unchecked) || input.unchecked.length > 32 || input.unchecked.some(item => typeof item !== 'string' || item.length > 1000)) throw new Error('VISUAL_CONTEXT_INVALID_INPUT')
      const description = await describe(input.contextId, signal)
      const scope = get(input.contextId)
      if (!input.evidenceIds.length || input.evidenceIds.length > 32) throw new Error('VISUAL_CONTEXT_EVIDENCE_REQUIRED')
      const evidence = [...new Set(input.evidenceIds)].map(id => {
        const item = scope.evidence.get(id)
        if (!item) throw new Error('VISUAL_CONTEXT_EVIDENCE_REQUIRED')
        return item
      })
      await options.assertWrite?.()
      await describe(input.contextId, signal)
      await options.assertWrite?.()
      assertCurrent(signal)
      if (get(input.contextId) !== scope) throw new Error('VISUAL_CONTEXT_INACTIVE')
      const observation: VisualContextObservation = { version: 1, id: randomUUID(), workspaceId: description.workspaceId, sessionId: options.sessionId, runId: options.runId, contextId: input.contextId, productionId: description.openInput.productionId, productionRevision: description.openInput.productionRevision, scopeKey: scope.fingerprint, target: description.openInput.target, objective: input.objective, conclusion: input.conclusion, unchecked: [...new Set([...input.unchecked, ...evidence.flatMap(item => item.unchecked)])], evidence, createdAt: Date.now() }
      if (!options.evidenceStore) throw new Error('VISUAL_CONTEXT_EVIDENCE_STORE_UNAVAILABLE')
      if (JSON.stringify(observation).length > 24 * 1024 - 2) throw new Error('VISUAL_CONTEXT_EVIDENCE_LIMIT: 请拆分检查目标')
      const response = result(input.contextId, 'observation', { observation })
      options.evidenceStore.append(observation)
      scope.description.observations = [...scope.description.observations, observation].slice(-4)
      return response
    },
    async close(input) {
      get(input.contextId)
      active = undefined
      generation++
      return result(input.contextId, 'close', { closed: true })
    },
    dispose() { active = undefined; disposed = true; generation++ },
  }
}
