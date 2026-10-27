import { createHash, randomUUID } from 'node:crypto'
import { existsSync, opendirSync } from 'node:fs'
import { basename, join } from 'node:path'
import { mergeLegacyVisualShotOutputs, resolveVisualShotOutputs, visualProductionMediaSourceAllows, parseVisualCandidateReview, parseVisualProductionMediaConfiguration, parseVisualProductionMediaExecution, parseVisualProductionCommand, parseVisualProductionDraft, VISUAL_PRODUCTION_LIMITS, VISUAL_PRODUCTION_READ_METHODS, VISUAL_PRODUCTION_STORAGE_SEGMENTS, assertVisualProductionId } from '@dutydeck/shared'
import type { MediaAssetRef, VisualCandidate, VisualEditingDocument, VisualEditingExportSettings, VisualProductionInputs, VisualProductionMethod, VisualProductionResults, VisualProductionSnapshot, VisualProductionDraft, VisualMedia, VisualJob, VisualProductionMediaOption, VisualProductionMediaExecution, VisualShotOutputs } from '@dutydeck/shared'
import { acquireMediaFileLock } from '../media/media-file-lock'
import { readAtomicFileState, writeJsonFileAtomicSecure } from '../safe-file'
import type { AtomicFileState } from '../safe-file'
import { interactionDirectory, interactionSourcePath, readInteractionFile } from '../interaction-design/paths'
import { resolveProjectStorageDirectory } from '../project-storage/project-storage-paths'
import { interactionImageMime } from '../interaction-design/asset-service'
import { VisualEditingStore } from './editing-store'
import { shotOutputChanges, withShotOutputs } from './shot-outputs'

/** 宿主注入的可信项目边界；媒体与来源读取均需独立复核。 */
export interface VisualProductionServiceDependencies {
  /** 读取当前授权项目公开制作目录，不返回凭据。 */
  listMediaOptions?: () => Promise<VisualProductionMediaOption[]>
  /** 按精确版本解析 Agent 选择的工作流，不枚举服务器模板。 */
  resolveMediaWorkflow?: (source: Extract<VisualProductionMediaOption['source'], { type: 'workflow' }>, kind: VisualProductionMediaOption['kind']) => Promise<VisualProductionMediaOption>
  /** 按会话读取真实运行回执，不接受调用者编造内容。 */
  readMediaExecution?: (sessionId: string, runId: string, engine: 'model' | 'workflow') => Promise<VisualProductionMediaExecution>
  workspaceId: string
  projectRoot: string
  assertCurrent?: () => void
  readSourceFile?: (relativePath: string, maxBytes: number) => Promise<Buffer>
  /** 将已校验的正式参考副本登记到同项目媒体库。 */
  registerReference?: (input: { sessionId: string; productionId: string; media: VisualMedia; bytes: Uint8Array }) => Promise<MediaAssetRef>
  readMediaAsset?: (reference: MediaAssetRef) => Promise<Uint8Array>
  /** 真实成片编码器；缺失时剪辑任务会明确失败。 */
  renderExport?: (input: { productionId: string; episodeId: string; timeline: VisualEditingDocument; settings: VisualEditingExportSettings; sourceMedia: VisualMedia[]; readMedia: (mediaId: string) => { bytes: Uint8Array; mime: string } }) => Promise<{ encoderId: string; artifactMedia: VisualMedia; artifactBytes: Uint8Array }>
  /** Agent 正式修改锁定资产时复用宿主权限弹窗；手工 UI 入口不注入此能力。 */
  authorizeLockedAssetChanges?: (request: VisualLockedAssetApprovalRequest, signal?: AbortSignal) => Promise<boolean>
}

/** 单个锁定资产字段的前后值，供项目原生权限弹窗精确展示。 */
export interface VisualLockedAssetFieldChange {
  /** 用户可读字段名。 */
  field: string
  /** 当前正式值。 */
  before: string | boolean | null
  /** 拟采用值。 */
  after: string | boolean | null
}

/** 一个锁定角色的完整待授权变更。 */
export interface VisualLockedAssetChange {
  /** 稳定资产身份。 */
  assetId: string
  /** 资产名称。 */
  name: string
  /** 本次变更字段。 */
  fields: VisualLockedAssetFieldChange[]
}

/** 宿主要求用户授权的锁定资产变更身份。 */
export interface VisualLockedAssetApprovalRequest {
  /** 发起操作的会话。 */
  sessionId: string
  /** 所属作品。 */
  productionId: string
  /** 本次待采用的精确候选，批准不能复用于其他候选。 */
  candidateId: string
  /** 候选基于的正式 revision。 */
  revision: number
  /** 当前正式写入锁定资产的唯一入口。 */
  action: 'adopt'
  /** 精确的锁定资产差异。 */
  changes: VisualLockedAssetChange[]
}
/** 内容摘要用于不可变媒体与版本比较。 */
function hash(bytes: Uint8Array): string { return createHash('sha256').update(bytes).digest('hex') }
/** 只投影可编辑字段，系统身份不得作为不可信草稿输入。 */
function editable(document: VisualProductionDraft): VisualProductionDraft {
  const { title, kind, brief, ratio, fps, voice, music, episodes, assets, shots } = document
  /** 所有可编辑集合必须独立复制，候选构造不能借共享引用提前修改正式作品。 */
  return structuredClone({ title, kind, brief, ratio, fps, voice, music, episodes, assets, shots })
}
/** 比较已通过解析的普通领域对象。 */
function same(left: unknown, right: unknown): boolean { return JSON.stringify(left) === JSON.stringify(right) }
/** 比较来源的语义身份，不依赖宿主对象字段顺序。 */
function sameSource(left: VisualProductionMediaOption['source'], right: VisualProductionMediaOption['source']): boolean {
  return visualProductionMediaSourceAllows(left, right) && visualProductionMediaSourceAllows(right, left)
}
/** 只识别被动媒体格式，不允许 HTML/SVG 或任意可执行内容。 */
function mediaFormat(bytes: Buffer): { mime: string; kind: VisualMedia['kind'] } {
  try { return { mime: interactionImageMime(bytes), kind: 'image' } } catch { /* 继续识别视频和音频。 */ }
  if (bytes.length >= 12 && bytes.subarray(4, 8).toString() === 'ftyp') return { mime: 'video/mp4', kind: 'video' }
  if (bytes.length >= 12 && bytes.subarray(0, 4).toString() === 'RIFF' && bytes.subarray(8, 12).toString() === 'WAVE') return { mime: 'audio/wav', kind: 'audio' }
  if (bytes.length >= 3 && (bytes.subarray(0, 3).toString() === 'ID3' || (bytes[0] === 255 && (bytes[1]! & 224) === 224))) return { mime: 'audio/mpeg', kind: 'audio' }
  throw new Error('不支持的媒体格式，仅允许 PNG/JPEG/GIF/WebP、MP4、MP3、WAV')
}
/** 每个作品一个原子快照，避免候选采纳与正式版本出现半提交。 */
export class VisualProductionService {
  private readonly editing: VisualEditingStore

  constructor(private readonly dependencies: VisualProductionServiceDependencies) {
    /** 剪辑文件与作品快照共用当前工作区和调用者存活校验。 */
    this.editing = new VisualEditingStore({ projectRoot: dependencies.projectRoot, assertCurrent: dependencies.assertCurrent, getCurrentSnapshot: productionId => this.load(productionId).snapshot, renderExport: dependencies.renderExport, saveExportArtifact: (snapshot, media, bytes) => this.saveExportArtifact(snapshot, media, bytes) })
  }
  /** 固定受管目录；所有层级禁止软链接。 */
  private directory(id?: string, create = false): string {
    return interactionDirectory(this.dependencies.projectRoot, [...VISUAL_PRODUCTION_STORAGE_SEGMENTS, 'projects', ...(id ? [id] : [])], create)
  }
  /** 有界枚举作品目录，损坏对象不能静默忽略。 */
  private ids(): string[] {
    /** 只读解析真实命名空间，空项目不创建目录，旧项目继续枚举旧作品。 */
    const storageDirectory = resolveProjectStorageDirectory(this.dependencies.projectRoot, 'visual-production', false)
    if (!existsSync(join(storageDirectory, 'projects'))) return []
    const directory = opendirSync(this.directory())
    const ids: string[] = []
    try {
      for (let entry = directory.readSync(); entry; entry = directory.readSync()) {
        if (!entry.isDirectory() || entry.isSymbolicLink()) throw new Error('影像作品目录损坏')
        ids.push(entry.name)
        if (ids.length > VISUAL_PRODUCTION_LIMITS.projects) throw new Error('作品数量超过预算')
      }
    } finally { directory.closeSync() }
    return ids
  }
  /** 读取时验证快照身份、预算与领域草稿，绝不空白重置。 */
  private load(id: string): { snapshot: VisualProductionSnapshot; state: AtomicFileState } {
    const path = join(this.directory(id), 'snapshot.json')
    const state = readAtomicFileState(path)
    if (!state) throw new Error('影像作品不存在')
    const snapshot = JSON.parse(readInteractionFile(path, VISUAL_PRODUCTION_LIMITS.metadataBytes).toString()) as VisualProductionSnapshot
    if (!snapshot || snapshot.document?.id !== id || snapshot.document.schemaVersion !== 1 || !Number.isSafeInteger(snapshot.document.revision) || snapshot.document.revision < 1) throw new Error('影像作品快照损坏')
    parseVisualProductionDraft(editable(snapshot.document))
    if (snapshot.mediaConfiguration) snapshot.mediaConfiguration = parseVisualProductionMediaConfiguration(snapshot.mediaConfiguration)
    if (!Array.isArray(snapshot.media) || snapshot.media.length > VISUAL_PRODUCTION_LIMITS.media || !Array.isArray(snapshot.candidates) || snapshot.candidates.length > VISUAL_PRODUCTION_LIMITS.candidates || !Array.isArray(snapshot.jobs) || snapshot.jobs.length > VISUAL_PRODUCTION_LIMITS.jobs || !snapshot.assetVersions || !snapshot.shotStates) throw new Error('影像作品索引损坏')
    for (const media of snapshot.media) {
      if (!media || !['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'video/mp4', 'audio/mpeg', 'audio/wav'].includes(media.mime) || media.mime.split('/')[0] !== media.kind || !/^[a-f0-9]{64}$/.test(media.hash) || media.id !== media.hash || !Number.isSafeInteger(media.byteSize) || media.byteSize < 1 || media.byteSize > VISUAL_PRODUCTION_LIMITS.mediaBytes) throw new Error('媒体索引损坏')
    }
    const unique = (ids: string[]): void => { ids.forEach(assertVisualProductionId); if (new Set(ids).size !== ids.length) throw new Error('持久化身份重复') }
    unique(snapshot.media.map(item => item.id)); unique(snapshot.jobs.map(item => item.id)); unique(snapshot.candidates.map(item => item.id))
    for (const job of snapshot.jobs) {
      assertVisualProductionId(job.sessionId)
      if (!['running', 'candidate', 'cancelled', 'failed', 'interrupted'].includes(job.status) || !Number.isSafeInteger(job.baseRevision) || job.baseRevision < 1 || job.baseRevision > snapshot.document.revision || typeof job.instruction !== 'string' || typeof job.createdAt !== 'number') throw new Error('任务索引损坏')
      if (job.compatibleRevision !== undefined && (!job.shotId || !Number.isSafeInteger(job.compatibleRevision) || job.compatibleRevision < job.baseRevision || job.compatibleRevision > snapshot.document.revision)) throw new Error('任务兼容版本损坏')
      if (job.stage !== undefined && !['preparing', 'generating', 'reviewing'].includes(job.stage)) throw new Error('任务阶段索引损坏')
      if (job.mediaKind !== undefined && !['image', 'video', 'audio', 'mixed'].includes(job.mediaKind)) throw new Error('任务媒体类别损坏')
      if (job.workflowDiscovery !== undefined) {
        const discovery = job.workflowDiscovery
        const selected = discovery.selectedWorkflow
        const selectedValid = selected === undefined || (Boolean(selected)
          && typeof selected.workflowId === 'string' && selected.workflowId.length > 0 && selected.workflowId.length <= 128
          && Number.isSafeInteger(selected.workflowRevision) && selected.workflowRevision >= 1
          && typeof selected.contentHash === 'string' && /^[a-f0-9]{64}$/.test(selected.contentHash))
        if (!['required', 'scanning', 'candidates', 'selected', 'no-match', 'blocked'].includes(discovery.status)
          || !['image', 'video', 'audio'].includes(discovery.mediaKind)
          || typeof discovery.connectionId !== 'string' || discovery.connectionId.length === 0 || discovery.connectionId.length > 128
          || !Number.isSafeInteger(discovery.candidateCount) || discovery.candidateCount < 0
          || !Number.isSafeInteger(discovery.blockedCount) || discovery.blockedCount < 0
          || (discovery.nextOffset !== null && (!Number.isSafeInteger(discovery.nextOffset) || discovery.nextOffset < 0))
          || (discovery.snapshotId !== undefined && (typeof discovery.snapshotId !== 'string' || discovery.snapshotId.length === 0 || discovery.snapshotId.length > 256))
          || (discovery.checkedAt !== undefined && (typeof discovery.checkedAt !== 'number' || !Number.isFinite(discovery.checkedAt) || discovery.checkedAt < 0))
          || (discovery.message !== undefined && (typeof discovery.message !== 'string' || discovery.message.length > 2000))
          || !selectedValid || (discovery.status === 'selected' && !selected)) throw new Error('工作流发现索引损坏')
      }
      if (job.shotId) assertVisualProductionId(job.shotId)
      if (job.mediaConfiguration) job.mediaConfiguration = parseVisualProductionMediaConfiguration(job.mediaConfiguration)
      if (job.mediaExecutions !== undefined) {
        if (!Array.isArray(job.mediaExecutions) || job.mediaExecutions.length > 32) throw new Error('制作记录超过预算')
        job.mediaExecutions = job.mediaExecutions.map(parseVisualProductionMediaExecution)
        if (new Set(job.mediaExecutions.map(receipt => `${receipt.engine}:${receipt.runId}`)).size !== job.mediaExecutions.length) throw new Error('制作记录身份重复')
      }
    }
    for (const candidate of snapshot.candidates) {
      parseVisualProductionDraft(candidate.draft)
      this.references(snapshot, candidate.draft)
      if (!['ready', 'stale', 'adopted', 'discarded'].includes(candidate.status) || !Number.isSafeInteger(candidate.baseRevision) || candidate.baseRevision < 1 || candidate.baseRevision > snapshot.document.revision || typeof candidate.summary !== 'string' || !snapshot.jobs.some(job => job.id === candidate.jobId)) throw new Error('候选索引损坏')
      if (candidate.status === 'ready' && candidate.baseRevision !== snapshot.document.revision) throw new Error('候选版本索引损坏')
      if (candidate.sourceRevision !== undefined && (!Number.isSafeInteger(candidate.sourceRevision) || candidate.sourceRevision < 1 || candidate.sourceRevision > candidate.baseRevision)) throw new Error('候选原始版本损坏')
      if (candidate.reviewRequired !== undefined && typeof candidate.reviewRequired !== 'boolean') throw new Error('候选审核门禁损坏')
      if (candidate.reviewAudioRequired !== undefined && (typeof candidate.reviewAudioRequired !== 'boolean' || (candidate.reviewAudioRequired && !candidate.reviewRequired))) throw new Error('候选声音审核门禁损坏')
      if (candidate.review !== undefined) parseVisualCandidateReview(candidate.review, true)
    }
    for (const asset of snapshot.document.assets) if (!Number.isSafeInteger(snapshot.assetVersions[asset.id]) || snapshot.assetVersions[asset.id]! < 1) throw new Error('资产版本索引损坏')
    for (const shot of snapshot.document.shots) {
      const state = snapshot.shotStates[shot.id]
      if (!state || !Number.isSafeInteger(state.revision) || state.revision < 1 || !Number.isSafeInteger(state.outputVersion) || state.outputVersion < 0 || typeof state.needsUpdate !== 'boolean') throw new Error('镜头版本索引损坏')
    }
    this.references(snapshot, snapshot.document)
    return { snapshot, state }
  }
  /** 领域引用必须指向同一作品已有副本。 */
  private references(snapshot: VisualProductionSnapshot, draft: VisualProductionDraft): void {
    const mediaById = new Map(snapshot.media.map(media => [media.id, media]))
    for (const item of [...draft.assets, ...draft.shots]) if (item.mediaId && !mediaById.has(item.mediaId)) throw new Error('媒体引用不属于当前影像作品')
    for (const shot of draft.shots) {
      const outputs = resolveVisualShotOutputs(shot, mediaById)
      for (const kind of ['image', 'video', 'audio'] as const) {
        const mediaId = outputs[kind]
        if (!mediaId) continue
        if (!mediaById.has(mediaId)) throw new Error('媒体引用不属于当前影像作品')
        if (mediaById.get(mediaId)!.kind !== kind || (draft.kind === 'image' && kind !== 'image')) throw new Error('镜头媒体类型与作品不匹配')
      }
      if (shot.outputs && shot.mediaId !== (outputs.video ?? outputs.image ?? null)) throw new Error('镜头视觉主输出与独立输出不一致')
      if (!shot.outputs && shot.mediaId && mediaById.get(shot.mediaId)?.kind === 'audio') throw new Error('镜头媒体类型与作品不匹配')
    }
    for (const asset of draft.assets) {
      const media = asset.mediaId ? mediaById.get(asset.mediaId) : undefined
      if (media && ((asset.type === '声音' && media.kind !== 'audio') || (asset.type !== '声音' && media.kind === 'audio'))) throw new Error('资产媒体类型与资产用途不匹配')
    }
  }
  /** 持久化前复核会话与预算，文件身份 CAS 防跨实例丢失更新。 */
  private persist(snapshot: VisualProductionSnapshot, state?: AtomicFileState): void {
    this.dependencies.assertCurrent?.()
    if (Buffer.byteLength(JSON.stringify(snapshot)) > VISUAL_PRODUCTION_LIMITS.metadataBytes) throw new Error('影像作品快照超过预算')
    writeJsonFileAtomicSecure(join(this.directory(snapshot.document.id, true), 'snapshot.json'), snapshot, { expectedDestination: state ? { kind: 'state', state } : { kind: 'missing' } })
  }
  /** 精确解析历史工作流；宿主不能以最新版本替换请求身份。 */
  private async resolveWorkflow(source: Extract<VisualProductionMediaOption['source'], { type: 'workflow' }>, kind: VisualProductionMediaOption['kind']): Promise<VisualProductionMediaOption> {
    if (!this.dependencies.resolveMediaWorkflow) throw new Error('工作流解析服务未就绪')
    const option = await this.dependencies.resolveMediaWorkflow(source, kind)
    if (option.kind !== kind || !sameSource(option.source, source)) throw new Error('工作流解析身份不匹配')
    return option
  }
  /** 只保留模型、服务及作品已保存的旧工作流，不枚举其他工作流。 */
  private async mediaCatalog(snapshot: VisualProductionSnapshot): Promise<VisualProductionMediaOption[]> {
    const options = (this.dependencies.listMediaOptions ? await this.dependencies.listMediaOptions() : []).filter(option => option.source.type !== 'workflow')
    for (const entry of snapshot.mediaConfiguration?.entries ?? []) {
      if (entry.source.type !== 'workflow') continue
      try {
        const option = await this.resolveWorkflow(entry.source, entry.kind)
        options.push({ ...option, id: entry.id })
      } catch {
        options.push({ ...entry, available: false, unavailableReason: '历史工作流或服务不可用，请重新选择', constraints: {} })
      }
    }
    return options
  }
  /** 正式保存统一维护资产与镜头依赖；保留已采用媒体直到显式替换。 */
  private commit(snapshot: VisualProductionSnapshot, draft: VisualProductionDraft, preserveOutputs = false): void {
    this.references(snapshot, draft)
    const previous = snapshot.document
    const media = new Map(snapshot.media.map(item => [item.id, item]))
    /** 只有宿主确认纯画面变更后才允许合并其他候选，正式编辑仍使旧输入失效。 */
    const outputOnly = preserveOutputs && shotOutputChanges(previous, draft, media) !== null
    /** 在更新正式版本前冻结每份候选自身的媒体差异，禁止用旧完整草稿覆盖新作品。 */
    const pendingOutputs = new Map(snapshot.candidates.filter(candidate => candidate.status === 'ready').map(candidate => [candidate.id, outputOnly ? shotOutputChanges(previous, candidate.draft, media) : null]))
    const changedAssets = new Set<string>()
    /** 删除资产的计数不无限累积，正式引用只保留当前集合。 */
    const nextAssetVersions: Record<string, number> = {}
    for (const asset of draft.assets) {
      const old = previous.assets.find(item => item.id === asset.id)
      const changed = !old || !same({ ...old, locked: false }, { ...asset, locked: false })
      nextAssetVersions[asset.id] = (snapshot.assetVersions[asset.id] ?? 0) + (changed ? 1 : 0)
      if (changed) changedAssets.add(asset.id)
    }
    snapshot.assetVersions = nextAssetVersions
    const settingsChanged = ['kind', 'brief', 'ratio', 'fps', 'voice', 'music'].some(key => !same(previous[key as keyof VisualProductionDraft], draft[key as keyof VisualProductionDraft]))
    const nextStates: VisualProductionSnapshot['shotStates'] = {}
    for (const shot of draft.shots) {
      const old = previous.shots.find(item => item.id === shot.id)
      const prior = snapshot.shotStates[shot.id]
      const before = old ? resolveVisualShotOutputs(old, media) : { image: null, video: null, audio: null }
      const after = resolveVisualShotOutputs(shot, media)
      const replaced = !same(before, after)
      const visualReplaced = Boolean((after.video ?? after.image) && (after.video ?? after.image) !== (before.video ?? before.image))
      const changed = !same(old, shot)
      const settings = !old || !same({ ...old, mediaId: null, outputs: undefined }, { ...shot, mediaId: null, outputs: undefined })
      nextStates[shot.id] = { revision: (prior?.revision ?? 0) + (changed ? 1 : 0), outputVersion: (prior?.outputVersion ?? 0) + (replaced ? 1 : 0), needsUpdate: visualReplaced ? false : !(after.image || after.video) || Boolean(prior?.needsUpdate) || settings || settingsChanged || shot.assetIds.some(id => changedAssets.has(id)) }
    }
    snapshot.shotStates = nextStates
    snapshot.document = { ...draft, schemaVersion: 1, id: previous.id, revision: previous.revision + 1, createdAt: previous.createdAt, updatedAt: Date.now() }
    for (const candidate of snapshot.candidates) {
      if (candidate.status !== 'ready') continue
      /** 纯画面候选基于最新正式内容重建，保留原始生成基线用于追溯。 */
      const outputs = pendingOutputs.get(candidate.id)
      if (!outputs) { candidate.status = 'stale'; continue }
      candidate.sourceRevision ??= candidate.baseRevision
      candidate.baseRevision = snapshot.document.revision
      candidate.draft = withShotOutputs(snapshot.document, outputs, media)
      if (!shotOutputChanges(snapshot.document, candidate.draft, media)) { candidate.status = 'adopted'; candidate.adoptedRevision = snapshot.document.revision }
    }
    for (const job of snapshot.jobs) {
      if (job.status !== 'running') continue
      /** 画面替换没有改变镜头设定或绑定资产，单镜头任务可继续；完整作品任务保持严格基线。 */
      if (outputOnly && job.shotId && (job.compatibleRevision ?? job.baseRevision) === previous.revision) job.compatibleRevision = snapshot.document.revision
      else { job.status = 'interrupted'; job.message = '正式版本已改变，请基于新版本重新发起。' }
    }
  }

  /**
   * 从待采用结果中选择空镜头唯一图片，一次提交全部满足条件的镜头。
   * @returns 是否推进正式版本；无可采用结果时不写盘。
   */
  private autoAdoptShots(snapshot: VisualProductionSnapshot): boolean {
    /** 候选、任务、媒体与镜头索引限定在当前作品，避免逐镜头重复查找。 */
    const ready = snapshot.candidates.filter(candidate => candidate.status === 'ready')
    const jobs = new Map(snapshot.jobs.map(job => [job.id, job]))
    const media = new Map(snapshot.media.map(item => [item.id, item]))
    const shots = new Map(snapshot.document.shots.map(shot => [shot.id, shot]))
    const choices = new Map<string, Set<string>>()
    for (const candidate of ready) {
      for (const shot of candidate.draft.shots) {
        const current = shots.get(shot.id)
        const imageId = resolveVisualShotOutputs(shot, media).image
        if (!current || !imageId || imageId === resolveVisualShotOutputs(current, media).image) continue
        const alternatives = choices.get(shot.id) ?? new Set<string>()
        alternatives.add(imageId); choices.set(shot.id, alternatives)
      }
    }
    /** 只合并纯画面候选；混有剧本或资产变更的草稿继续等待人工采用。 */
    const selected: VisualCandidate[] = []
    const outputs = new Map<string, Partial<VisualShotOutputs>>()
    for (const candidate of ready) {
      if (candidate.reviewRequired || candidate.review?.audio === 'failed' || candidate.review?.issues.some(issue => issue.severity === 'error')) continue
      const changes = shotOutputChanges(snapshot.document, candidate.draft, media)
      /** 同镜头连续运行各一张也属于多图；整作品输出数超过改图镜头数时也无法证明每镜唯一。 */
      const job = jobs.get(candidate.jobId)
      const imageRuns = job?.mediaExecutions?.filter(receipt => receipt.kind === 'image') ?? []
      const multipleOutputs = imageRuns.some(receipt => (receipt.outputCount ?? 0) > 1)
        || imageRuns.reduce((count, receipt) => count + (receipt.outputCount ?? 0), 0) > (job?.shotId ? 1 : new Set([...(changes?.values() ?? [])].map(delta => delta.image).filter(Boolean)).size)
      if (!changes || multipleOutputs) continue
      if ([...changes].some(([shotId, delta]) => resolveVisualShotOutputs(shots.get(shotId)!, media).image !== null || Object.keys(delta).some(kind => kind !== 'image') || !delta.image || media.get(delta.image)?.kind !== 'image' || choices.get(shotId)?.size !== 1)) continue
      selected.push(candidate)
      for (const [shotId, delta] of changes) outputs.set(shotId, delta)
    }
    if (!selected.length) return false
    /** 提交前串行核验实际字节，损坏或缺失素材不能成为正式画面。 */
    for (const mediaId of new Set([...outputs.values()].flatMap(delta => Object.values(delta)))) if (mediaId) this.mediaContent(snapshot, mediaId)
    for (const candidate of selected) candidate.status = 'adopted'
    this.commit(snapshot, withShotOutputs(snapshot.document, outputs, media), true)
    for (const candidate of selected) candidate.adoptedRevision = snapshot.document.revision
    return true
  }

  /** 校验并登记同一任务的全部候选，自动采用判断必须在所有替选入列之后进行。 */
  private proposeCandidates(snapshot: VisualProductionSnapshot, job: VisualJob, drafts: VisualProductionDraft[], summary: string): VisualCandidate {
    for (const draft of drafts) {
      this.references(snapshot, draft)
      if (job.shotId) {
        const original = editable(snapshot.document)
        if (original.shots.find(shot => shot.id === job.shotId)?.episodeId !== draft.shots.find(shot => shot.id === job.shotId)?.episodeId || !same(original.shots.map(shot => shot.id), draft.shots.map(shot => shot.id)) || !draft.shots.some(shot => shot.id === job.shotId) || !same({ ...original, shots: original.shots.filter(shot => shot.id !== job.shotId) }, { ...draft, shots: draft.shots.filter(shot => shot.id !== job.shotId) })) throw new Error('单镜头任务不能修改其他内容')
      }
    }
    /** 为整批候选一次预留容量，失败不能保存半批结果。 */
    while (snapshot.candidates.length + drafts.length > VISUAL_PRODUCTION_LIMITS.candidates) {
      const removable = snapshot.candidates.findIndex(candidate => candidate.status !== 'ready')
      if (removable < 0) throw new Error('待采纳候选数量超过预算，请先采纳或丢弃')
      snapshot.candidates.splice(removable, 1)
    }
    /** 新影片与独立声音输出分别触发审核，静帧和旧候选保持原流程。 */
    const media = new Map(snapshot.media.map(item => [item.id, item]))
    /** 复用正式输出索引，整批候选避免重复扫描正式镜头。 */
    const previousOutputs = new Map(snapshot.document.shots.map(shot => [shot.id, resolveVisualShotOutputs(shot, media)]))
    const candidates: VisualCandidate[] = drafts.map(draft => {
      /** 仅有实际新声音输出时强制听验，纯设定和空槽不触发。 */
      const reviewAudioRequired = draft.shots.some(shot => {
        const audio = resolveVisualShotOutputs(shot, media).audio
        return audio !== null && audio !== previousOutputs.get(shot.id)?.audio
      })
      const reviewRequired = reviewAudioRequired || draft.shots.some(shot => (previousOutputs.get(shot.id)?.video ?? null) !== resolveVisualShotOutputs(shot, media).video)
      return { id: randomUUID(), baseRevision: snapshot.document.revision, ...(job.baseRevision === snapshot.document.revision ? {} : { sourceRevision: job.baseRevision }), draft, summary, status: 'ready', jobId: job.id, ...(reviewRequired ? { reviewRequired: true } : {}), ...(reviewAudioRequired ? { reviewAudioRequired: true } : {}), createdAt: Date.now() }
    })
    snapshot.candidates.push(...candidates)
    job.status = 'candidate'
    /** 影片候选进入同一 Agent 任务的审片步骤，不是额外后台任务。 */
    if (candidates.some(candidate => candidate.reviewRequired)) job.stage = 'reviewing'
    this.autoAdoptShots(snapshot)
    return candidates[0]!
  }
  /**
   * 计算正式文档中锁定资产相对候选草稿的差异。
   * 候选阶段允许保存差异；只有正式采用时才要求用户一次性授权。
   * @param current 当前正式可编辑文档。
   * @param draft 拟采用的候选草稿。
   * @returns 仅包含锁定资产字段变化的有界列表。
   */
  private collectLockedAssetChanges(current: VisualProductionDraft, draft: VisualProductionDraft): VisualLockedAssetChange[] {
    const changes: VisualLockedAssetChange[] = []
    for (const asset of current.assets.filter(item => item.locked)) {
      const next = draft.assets.find(item => item.id === asset.id)
      if (!next) {
        changes.push({ assetId: asset.id, name: asset.name, fields: [{ field: '资产', before: '存在', after: '删除' }] })
        continue
      }
      const fields: VisualLockedAssetFieldChange[] = []
      if (asset.name !== next.name) fields.push({ field: '名称', before: asset.name, after: next.name })
      if (asset.type !== next.type) fields.push({ field: '类型', before: asset.type, after: next.type })
      if (asset.description !== next.description) fields.push({ field: '描述', before: asset.description, after: next.description })
      if (asset.locked !== next.locked) fields.push({ field: '锁定状态', before: asset.locked, after: next.locked })
      if (asset.mediaId !== next.mediaId) fields.push({ field: '媒体', before: asset.mediaId, after: next.mediaId })
      if (fields.length > 0) changes.push({ assetId: asset.id, name: next.name, fields })
    }
    return changes
  }
  /** 执行经过严格解析的单命令；异步来源读取完成后重新读取当前快照。 */
  async invoke<M extends VisualProductionMethod>(method: M, input: VisualProductionInputs[M], signal?: AbortSignal): Promise<VisualProductionResults[M]> {
    this.dependencies.assertCurrent?.()
    const command = parseVisualProductionCommand({ method, input })
    /** 跨进程锁覆盖读、校验、异步准备和提交，原子文件 CAS 再次确认目标身份。 */
    const release = VISUAL_PRODUCTION_READ_METHODS.includes(method) ? undefined : acquireMediaFileLock(join(interactionDirectory(this.dependencies.projectRoot, [...VISUAL_PRODUCTION_STORAGE_SEGMENTS], true), 'write.lock'))
    try { return await this.execute(command, signal) as VisualProductionResults[M] } finally { release?.() }
  }
  /** 联合命令分派保留每个方法的输入收窄。 */
  private async execute(command: ReturnType<typeof parseVisualProductionCommand>, signal?: AbortSignal): Promise<unknown> {
    if (command.method === 'list') {
      /** 列表累计读取上限，避免多个大型候选快照造成主进程长时间阻塞。 */
      let remainingBytes = VISUAL_PRODUCTION_LIMITS.metadataBytes * 4
      return this.ids().map(id => {
      const state = readAtomicFileState(join(this.directory(id), 'snapshot.json'))
      remainingBytes -= state?.size ?? 0
      if (remainingBytes < 0) throw new Error('作品列表读取超过预算')
      const document = this.load(id).snapshot.document
      return { id, title: document.title, kind: document.kind, revision: document.revision, episodeCount: document.episodes.length, assetCount: document.assets.length, shotCount: document.shots.length, updatedAt: document.updatedAt }
    }).sort((a, b) => b.updatedAt - a.updatedAt)
    }
    if (command.method === 'create') {
      if (this.ids().length >= VISUAL_PRODUCTION_LIMITS.projects) throw new Error('作品数量超过预算')
      const now = Date.now()
      const snapshot: VisualProductionSnapshot = { document: { schemaVersion: 1, id: randomUUID(), revision: 1, createdAt: now, updatedAt: now, title: command.input.title, kind: command.input.kind, brief: '', ratio: '16:9', fps: 24, voice: '', music: '', episodes: [{ id: randomUUID(), title: '第 1 集' }], assets: [], shots: [] }, media: [], assetVersions: {}, shotStates: {}, candidates: [], jobs: [] }
      this.persist(snapshot)
      return snapshot
    }
    if (command.method === 'importFile' || command.method === 'importMedia') {
      const input = command.input
      const bytes = command.method === 'importFile' ? await this.readSource(command.input.relativePath) : Buffer.from(await this.readMedia(command.input.reference))
      this.dependencies.assertCurrent?.()
      if (!bytes.length || bytes.length > VISUAL_PRODUCTION_LIMITS.mediaBytes) throw new Error('媒体超过读取预算')
      const digest = hash(bytes)
      if (command.method === 'importMedia' && digest !== command.input.reference.hash) throw new Error('媒体 hash 不匹配')
      const format = mediaFormat(bytes)
      if (command.method === 'importMedia' && format.kind !== command.input.reference.mediaKind) throw new Error('媒体类型不匹配')
      const { snapshot, state } = this.load(input.productionId)
      const existing = snapshot.media.find(item => item.hash === digest)
      if (existing) { this.mediaContent(snapshot, existing.id); return existing }
      if (snapshot.media.length >= VISUAL_PRODUCTION_LIMITS.media) throw new Error('媒体数量超过预算')
      const media: VisualMedia = { id: digest, hash: digest, ...format, name: command.method === 'importFile' ? basename(command.input.relativePath).slice(0, 200) : command.input.reference.assetId, byteSize: bytes.length, createdAt: Date.now() }
      /** 二进制采用原子 JSON 字节封装；独立副本不依赖画布生命周期。 */
      const directory = interactionDirectory(this.dependencies.projectRoot, [...VISUAL_PRODUCTION_STORAGE_SEGMENTS, 'projects', input.productionId, 'media'], true)
      const path = join(directory, `${digest}.json`)
      if (!existsSync(path)) writeJsonFileAtomicSecure(path, { hash: digest, data: bytes.toString('base64') }, { expectedDestination: { kind: 'missing' } })
      snapshot.media.push(media)
      this.mediaContent(snapshot, digest)
      this.persist(snapshot, state)
      return media
    }
    const { snapshot, state } = this.load(command.input.productionId)
    const input = command.input
    if ('baseRevision' in input && input.baseRevision !== snapshot.document.revision) {
      /** 仅类型化单镜头操作可沿宿主证明兼容的旧基线继续，完整草稿与手工保存仍要求最新版本。 */
      if (['recordWorkflowDiscovery', 'proposeShot', 'referenceMedia', 'updateJob', 'recordMediaExecution'].includes(command.method) && 'jobId' in input) this.currentJob(snapshot, { sessionId: input.sessionId, baseRevision: input.baseRevision, jobId: input.jobId })
      else throw new Error('VISUAL_PRODUCTION_CONFLICT: 正式版本已变化')
    }
    switch (command.method) {
      case 'load': return snapshot
      case 'autoAdoptShots': {
        if (this.autoAdoptShots(snapshot)) this.persist(snapshot, state)
        return snapshot
      }
      case 'loadTimeline': return this.editing.load(snapshot, command.input.episodeId)
      case 'createRoughCut': {
        if (command.input.baseProductionRevision !== snapshot.document.revision) throw new Error('VISUAL_PRODUCTION_CONFLICT: 作品版本已变化')
        return this.editing.createRoughCut(snapshot, command.input.episodeId)
      }
      case 'saveTimeline': return this.editing.save(snapshot, command.input.episodeId, command.input.expectedRevision, command.input.timeline)
      case 'proposeTimelineEdit': return this.editing.propose(snapshot, command.input.episodeId, command.input.expectedRevision, command.input.operations, command.input.summary, input.sessionId)
      case 'adoptTimelineEdit': return this.editing.adopt(snapshot, command.input.episodeId, command.input.candidateId, command.input.expectedRevision)
      case 'discardTimelineEdit': return this.editing.discard(snapshot, command.input.episodeId, command.input.candidateId)
      case 'requestExport': return this.editing.requestExport(snapshot, command.input.episodeId, command.input.expectedTimelineRevision, command.input.settings)
      case 'requestPreview': return this.editing.requestPreview(snapshot, command.input)
      case 'listExportJobs': return this.editing.listExportJobs(snapshot, command.input.episodeId)
      case 'cancelExport': return this.editing.cancelExport(snapshot, command.input.episodeId, command.input.exportJobId)
      case 'mediaCatalog': return this.mediaCatalog(snapshot)
      case 'resolveMediaWorkflow': return this.resolveWorkflow(command.input.source, command.input.kind)
      case 'saveMediaConfiguration': {
        if ((snapshot.mediaConfiguration?.revision ?? 0) !== command.input.expectedRevision) throw new Error('VISUAL_PRODUCTION_CONFLICT: 制作配置已变化')
        const options = this.dependencies.listMediaOptions ? await this.dependencies.listMediaOptions() : []
        for (const entry of command.input.entries) {
          const previous = snapshot.mediaConfiguration?.entries.find(item => item.id === entry.id)
          let option = options.find(item => item.kind === entry.kind && sameSource(item.source, entry.source))
          if (entry.source.type === 'workflow' && this.dependencies.resolveMediaWorkflow) {
            try { option = await this.resolveWorkflow(entry.source, entry.kind) } catch { option = undefined }
          }
          if (!option?.available) {
            if (previous && same(previous, entry) && (command.input.defaults[entry.kind] !== entry.id || snapshot.mediaConfiguration?.defaults[entry.kind] === entry.id)) continue
            throw new Error('制作来源不可用，不能加入或修改此方案')
          }
          for (const [key, value] of Object.entries(entry.parameters)) {
            const parameter = option.constraints.parameters?.find(item => item.key === key)
            if (!parameter || typeof value !== parameter.type || (parameter.options && !parameter.options.includes(value)) || (typeof value === 'number' && ((parameter.min !== undefined && value < parameter.min) || (parameter.max !== undefined && value > parameter.max)))) throw new Error('制作参数不受当前适配器支持')
          }
        }
        snapshot.mediaConfiguration = parseVisualProductionMediaConfiguration({ revision: command.input.expectedRevision + 1, entries: command.input.entries, defaults: command.input.defaults })
        break
      }
      case 'recordMediaExecution': {
        const job = this.currentJob(snapshot, command.input)
        if (!this.dependencies.readMediaExecution) throw new Error('制作记录服务未就绪')
        const receipt = parseVisualProductionMediaExecution(await this.dependencies.readMediaExecution(input.sessionId, command.input.runId, command.input.engine))
        if (receipt.runId !== command.input.runId || receipt.engine !== command.input.engine) throw new Error('制作记录身份不匹配')
        if (job.mediaConfiguration) {
          /** 精确旧工作流优先，服务授权作为后备，保留已有参数方案身份。 */
          const entry = job.mediaConfiguration.entries.find(item => item.kind === receipt.kind && sameSource(item.source, receipt.source))
            ?? job.mediaConfiguration.entries.find(item => item.kind === receipt.kind && visualProductionMediaSourceAllows(item.source, receipt.source))
          if (!entry) throw new Error('制作来源不在任务冻结范围')
          receipt.entryId = entry.id
        }
        const executions = job.mediaExecutions ?? []
        const existing = executions.findIndex(item => item.engine === receipt.engine && item.runId === receipt.runId)
        if (existing < 0 && executions.length >= 32) throw new Error('制作记录超过预算')
        if (existing < 0) executions.push(receipt)
        else executions[existing] = receipt
        job.mediaExecutions = executions
        this.persist(snapshot, state)
        return job
      }
      case 'mediaContent': return this.mediaContent(snapshot, command.input.mediaId)
      case 'exportManifest': return { fileName: `${snapshot.document.id}-manifest.json`, json: JSON.stringify({ schemaVersion: 1, document: snapshot.document, media: snapshot.media, shotStates: snapshot.shotStates, assetVersions: snapshot.assetVersions, mediaConfiguration: snapshot.mediaConfiguration, jobs: snapshot.jobs }, null, 2) }
      case 'save': this.commit(snapshot, parseVisualProductionDraft(command.input.draft)); break
      case 'updateShotPlan': {
        const draft = editable(snapshot.document)
        const targetShot = draft.shots.find(shot => shot.id === command.input.shotId)
        if (!targetShot) throw new Error('镜头不存在')
        const previousShot = structuredClone(targetShot)
        /** 只把已导入媒体登记成非锁定资产；既有资产保持原样，避免计划工具成为资产编辑器。 */
        for (const reference of command.input.references ?? []) {
          const media = snapshot.media.find(item => item.id === reference.mediaId)
          if (!media || media.kind === 'audio' && reference.type !== '声音' || media.kind !== 'audio' && reference.type === '声音') {
            throw new Error('计划引用媒体不属于当前作品或与资产类型不匹配')
          }
          const existing = draft.assets.find(asset => asset.id === reference.assetId)
          if (existing) {
            if (existing.mediaId !== reference.mediaId) throw new Error('计划引用资产身份已被其他媒体占用')
            continue
          }
          draft.assets.push({
            id: reference.assetId,
            name: reference.name,
            type: reference.type,
            description: reference.description,
            locked: false,
            mediaId: reference.mediaId,
          })
        }
        /** 首尾帧和动作锚点必须成为目标镜头引用，其他镜头保持不变。 */
        const referencedAssetIds = new Set([
          ...(command.input.references ?? []).map(reference => reference.assetId),
          ...(command.input.videoPlan.firstFrameAssetId ? [command.input.videoPlan.firstFrameAssetId] : []),
          ...(command.input.videoPlan.lastFrameAssetId ? [command.input.videoPlan.lastFrameAssetId] : []),
          ...command.input.continuityPlan.anchors.flatMap(anchor => anchor.assetId ? [anchor.assetId] : []),
        ])
        targetShot.assetIds = [...new Set([...targetShot.assetIds, ...referencedAssetIds])]
        targetShot.videoPlan = structuredClone(command.input.videoPlan)
        targetShot.continuityPlan = structuredClone(command.input.continuityPlan)
        const normalized = parseVisualProductionDraft(draft)
        const normalizedShot = normalized.shots.find(shot => shot.id === command.input.shotId)!
        /** 重复提交完全相同计划保持幂等，不制造无意义的版本和候选失效。 */
        if (same(previousShot, normalizedShot) && !(command.input.references ?? []).some(reference => !snapshot.document.assets.some(asset => asset.id === reference.assetId))) {
          return snapshot
        }
        this.commit(snapshot, normalized)
        break
      }
      case 'beginJob': {
        /** 仅裁剪未被待采纳候选引用的最老终态任务，关联终态候选一同裁剪。 */
        const referencedJobs = new Set(snapshot.candidates.filter(candidate => candidate.status === 'ready').map(candidate => candidate.jobId))
        while (snapshot.jobs.length >= VISUAL_PRODUCTION_LIMITS.jobs) {
          const removable = snapshot.jobs.findIndex(job => job.status !== 'running' && !referencedJobs.has(job.id))
          if (removable < 0) throw new Error('活动任务数量超过预算，请先取消不再需要的任务')
          const removed = snapshot.jobs.splice(removable, 1)[0]!
          snapshot.candidates = snapshot.candidates.filter(candidate => candidate.jobId !== removed.id)
        }
        if (command.input.shotId && !snapshot.document.shots.some(shot => shot.id === command.input.shotId)) throw new Error('镜头不存在：shotId 必须来自当前作品的正式镜头；整作品或整集任务请省略 shotId，Agent 工具也可传 null')
        const targetShot = command.input.shotId ? snapshot.document.shots.find(shot => shot.id === command.input.shotId) : undefined
        const requestedKinds = command.input.mediaKind === 'mixed' ? ['image', 'video', 'audio'] as const
          : command.input.mediaKind ? [command.input.mediaKind] as const
            : targetShot?.videoPlan ? ['video'] as const : []
        const connectionKind = requestedKinds.find(kind => {
          const entryId = snapshot.mediaConfiguration?.defaults[kind]
          return entryId ? snapshot.mediaConfiguration?.entries.find(entry => entry.id === entryId)?.source.type === 'connection' : false
        })
        const connectionEntry = connectionKind ? snapshot.mediaConfiguration?.entries.find(entry => entry.id === snapshot.mediaConfiguration?.defaults[connectionKind]) : undefined
        const workflowDiscovery = connectionKind && connectionEntry?.source.type === 'connection' ? {
          status: 'required' as const, connectionId: connectionEntry.source.connectionId, mediaKind: connectionKind,
          candidateCount: 0, blockedCount: 0, nextOffset: null,
        } : undefined
        const job: VisualJob = { ...(snapshot.mediaConfiguration ? { mediaConfiguration: structuredClone(snapshot.mediaConfiguration) } : {}), id: randomUUID(), sessionId: input.sessionId, baseRevision: snapshot.document.revision, instruction: command.input.instruction, ...(command.input.shotId ? { shotId: command.input.shotId } : {}), ...(command.input.mediaKind ? { mediaKind: command.input.mediaKind } : {}), ...(workflowDiscovery ? { workflowDiscovery } : {}), status: 'running' as const, stage: 'preparing' as const, createdAt: Date.now() }
        snapshot.jobs.push(job); this.persist(snapshot, state); return job
      }
      case 'recordWorkflowDiscovery': {
        const job = this.currentJob(snapshot, command.input)
        if (job.workflowDiscovery && job.workflowDiscovery.connectionId !== command.input.discovery.connectionId) throw new Error('工作流发现服务与任务不一致')
        /** 单个任务的冻结媒体类别必须与扫描结果一致，避免同一任务混写多类工作流证据。 */
        if ((job.mediaKind !== undefined && job.mediaKind !== 'mixed' && job.mediaKind !== command.input.discovery.mediaKind)
          || (job.workflowDiscovery && job.workflowDiscovery.mediaKind !== command.input.discovery.mediaKind)) throw new Error('工作流发现媒体类别与任务不一致')
        /** 无匹配必须来自完整目录快照；阻断和无匹配也必须保留可解释原因。 */
        if (command.input.discovery.status === 'no-match'
          && (command.input.discovery.nextOffset !== null || !command.input.discovery.snapshotId)) throw new Error('工作流发现尚未完成完整目录检查')
        if ((command.input.discovery.status === 'no-match' || command.input.discovery.status === 'blocked')
          && !command.input.discovery.message?.trim()) throw new Error('工作流发现终态缺少原因')
        job.workflowDiscovery = structuredClone(command.input.discovery)
        this.persist(snapshot, state)
        return job
      }
      case 'updateJob': {
        /** 只推进当前会话仍存活的任务；终态不能被阶段更新复活。 */
        const job = this.currentJob(snapshot, command.input)
        /** 阶段序列只允许向前或幂等更新。 */
        const stages = ['preparing', 'generating', 'reviewing']
        if (stages.indexOf(command.input.stage) < stages.indexOf(job.stage ?? 'preparing')) throw new Error('任务阶段不能倒退')
        job.stage = command.input.stage
        this.persist(snapshot, state)
        return job
      }
      case 'referenceMedia': {
        /** 单镜头只能使用其正式输出和关联正式资产，不能使用未绑定导入素材。 */
        const job = this.currentJob(snapshot, command.input)
        /** 当前任务可访问的正式镜头集合。 */
        const shots = job.shotId ? snapshot.document.shots.filter(shot => shot.id === job.shotId) : snapshot.document.shots
        /** 单镜头显式引用的资产身份集合。 */
        const assetIds = new Set(shots.flatMap(shot => shot.assetIds))
        /** 整作品任务可使用全部正式资产。 */
        const assets = job.shotId ? snapshot.document.assets.filter(asset => assetIds.has(asset.id)) : snapshot.document.assets
        /** 一次建立索引，正式参考校验保持线性。 */
        const mediaById = new Map(snapshot.media.map(item => [item.id, item]))
        if (!assets.some(item => item.mediaId === command.input.mediaId) && !shots.some(shot => Object.values(resolveVisualShotOutputs(shot, mediaById)).includes(command.input.mediaId))) throw new Error('媒体不属于任务正式参考范围')
        /** 内容寻址媒体与受管副本保持一致。 */
        const media = snapshot.media.find(item => item.id === command.input.mediaId)
        if (!media || !this.dependencies.registerReference) throw new Error('参考媒体服务未就绪')
        /** 先验证副本 hash、格式和长度再交给宿主。 */
        const content = this.mediaContent(snapshot, media.id)
        this.dependencies.assertCurrent?.()
        /** 宿主返回同项目媒体库中的不可变身份。 */
        const reference = await this.dependencies.registerReference({ sessionId: input.sessionId, productionId: input.productionId, media, bytes: content.bytes })
        this.dependencies.assertCurrent?.()
        /** 外部登记可能迟到；返回能力前重新检查任务与正式版本。 */
        this.currentJob(this.load(input.productionId).snapshot, command.input)
        if (reference.hash !== media.hash || reference.mediaKind !== media.kind) throw new Error('参考媒体身份不匹配')
        parseVisualProductionCommand({ method: 'importMedia', input: { sessionId: input.sessionId, productionId: input.productionId, reference } })
        return reference
      }
      case 'proposeShot': {
        /** 只允许当前任务的目标镜头；各替选共享同一轮真实生成身份。 */
        const job = this.currentJob(snapshot, command.input)
        if (!job.shotId || job.shotId !== command.input.shotId) throw new Error('单镜头任务目标不匹配')
        const shot = snapshot.document.shots.find(item => item.id === job.shotId)
        const mediaIds = [command.input.mediaId, ...(command.input.alternativeMediaIds ?? [])]
        const media = new Map(snapshot.media.map(item => [item.id, item]))
        if (!shot || mediaIds.some(mediaId => Object.values(resolveVisualShotOutputs(shot, media)).includes(mediaId))) throw new Error('镜头输出没有变化')
        /** 使用最新正式内容构造候选，旧基线兼容不能带回其他镜头的旧画面。 */
        const drafts = mediaIds.map(mediaId => {
          const kind = media.get(mediaId)?.kind
          if (!kind) throw new Error('媒体引用不属于当前影像作品')
          return withShotOutputs(snapshot.document, new Map([[shot.id, { [kind]: mediaId }]]), media)
        })
        const candidate = this.proposeCandidates(snapshot, job, drafts, command.input.summary)
        this.persist(snapshot, state)
        return candidate
      }
      case 'proposeScript': {
        /** 剧本属于整集结构，单镜头任务不能越过制作边界重写整集叙事。 */
        const job = this.currentJob(snapshot, command.input)
        if (job.shotId) throw new Error('单镜头任务不能提交整集剧本')
        if (!snapshot.document.episodes.some(episode => episode.id === command.input.episodeId)) throw new Error('剧本所属集数不存在')
        const draft = editable(snapshot.document)
        const episode = draft.episodes.find(item => item.id === command.input.episodeId)!
        episode.script = structuredClone(command.input.script)
        const normalized = parseVisualProductionDraft(draft)
        const candidate = this.proposeCandidates(snapshot, job, [normalized], command.input.summary)
        this.persist(snapshot, state)
        return candidate
      }
      case 'reviewCandidate': {
        /** 审核只更新当前仍可采用的候选，不修改正式输出或媒体副本。 */
        const candidate = snapshot.candidates.find(item => item.id === command.input.candidateId)
        if (!candidate || candidate.status !== 'ready' || candidate.baseRevision !== snapshot.document.revision) throw new Error('候选已过期或不可审核')
        candidate.review = { ...command.input.review, sessionId: input.sessionId, reviewedAt: Date.now() }
        this.persist(snapshot, state)
        return candidate
      }
      case 'propose': {
        const job = this.currentJob(snapshot, command.input)
        const draft = parseVisualProductionDraft(command.input.draft)
        const candidate = this.proposeCandidates(snapshot, job, [draft], command.input.summary)
        this.persist(snapshot, state)
        return candidate
      }
      case 'adopt': {
        const media = new Map(snapshot.media.map(item => [item.id, item]))
        const candidate = snapshot.candidates.find(item => item.id === command.input.candidateId)
        if (!candidate || candidate.status !== 'ready' || candidate.baseRevision !== snapshot.document.revision) throw new Error('候选已过期或不可采纳')
        if (candidate.review?.audio === 'failed' || candidate.review?.issues.some(issue => issue.severity === 'error')) throw new Error('视频审核存在失败项，不能采用（含声音审核）')
        if (candidate.reviewRequired) {
          if (!candidate.review) throw new Error(candidate.reviewAudioRequired ? '候选需先完成声音审核' : '候选需先完成视频审核')
          if ([candidate.review.technical, candidate.review.motion, candidate.review.continuity].includes('failed') || candidate.review.issues.some(issue => issue.severity === 'error')) throw new Error('视频审核存在失败项，不能采用')
          if ([candidate.review.technical, candidate.review.motion, candidate.review.continuity].includes('pending')) throw new Error('候选视频审核尚未完成')
          if (candidate.review.audio === 'pending' || (candidate.reviewAudioRequired && !candidate.review.audio)) throw new Error('候选声音审核尚未完成')
        }
        const lockedAssetChanges = this.collectLockedAssetChanges(snapshot.document, candidate.draft)
        if (lockedAssetChanges.length > 0) {
          if (!this.dependencies.authorizeLockedAssetChanges) throw new Error('锁定角色或资产需要用户授权后才能采用')
          const approved = await this.dependencies.authorizeLockedAssetChanges({
            sessionId: command.input.sessionId,
            productionId: command.input.productionId,
            candidateId: candidate.id,
            revision: snapshot.document.revision,
            action: 'adopt',
            changes: lockedAssetChanges,
          }, signal)
          if (!approved) throw new Error('VISUAL_PRODUCTION_LOCKED_ASSET_DENIED: 用户未授权修改锁定角色或资产')
          /** 审批返回后可能已收到取消；正式写入前必须再检查一次运行信号。 */
          signal?.throwIfAborted()
          this.dependencies.assertCurrent?.()
        }
        /** 手工选择也仅合并本次输出；完整创作候选仍沿用严格的整作品提交。 */
        /** 兼容旧完整候选时也补齐未声明槽，设定变更不能悄悄删除画面或音频。 */
        const currentShots = new Map(snapshot.document.shots.map(shot => [shot.id, shot]))
        const draft = { ...candidate.draft, shots: candidate.draft.shots.map(shot => mergeLegacyVisualShotOutputs(shot, currentShots.get(shot.id), media)) }
        const outputs = shotOutputChanges(snapshot.document, draft, media)
        if (outputs) for (const mediaId of new Set([...outputs.values()].flatMap(delta => Object.values(delta)))) if (mediaId) this.mediaContent(snapshot, mediaId)
        candidate.status = 'adopted'
        this.commit(snapshot, outputs ? withShotOutputs(snapshot.document, outputs, media) : draft, outputs !== null)
        candidate.adoptedRevision = snapshot.document.revision
        break
      }
      case 'discardCandidate': {
        const candidate = snapshot.candidates.find(item => item.id === command.input.candidateId)
        if (!candidate || candidate.status === 'adopted') throw new Error('候选不可丢弃')
        candidate.status = 'discarded'; break
      }
      case 'cancelJob': case 'failJob': {
        const job = snapshot.jobs.find(item => item.id === command.input.jobId && item.sessionId === input.sessionId)
        if (!job) throw new Error('任务不属于当前会话')
        if (job.status === 'running') { job.status = command.method === 'cancelJob' ? 'cancelled' : 'failed'; if (command.method === 'failJob') job.message = command.input.message }
        break
      }
    }
    this.persist(snapshot, state)
    return snapshot
  }
  /** 核验任务归属、存活与固定正式基线，返回当前任务。 */
  private currentJob(snapshot: VisualProductionSnapshot, input: { sessionId: string; baseRevision: number; jobId: string }): VisualJob {
    /** 身份匹配同时绑定发起会话。 */
    const job = snapshot.jobs.find(item => item.id === input.jobId && item.sessionId === input.sessionId)
    if (!job || job.status !== 'running' || (job.compatibleRevision ?? job.baseRevision) !== snapshot.document.revision || ![job.baseRevision, snapshot.document.revision].includes(input.baseRevision)) throw new Error('任务已取消、过期或不属于当前会话')
    return job
  }
  /** 优先使用生产稳定目录读取；测试回退仍禁止路径越界与链接。 */
  private async readSource(relativePath: string): Promise<Buffer> {
    if (this.dependencies.readSourceFile) return this.dependencies.readSourceFile(relativePath, VISUAL_PRODUCTION_LIMITS.mediaBytes)
    return readInteractionFile(interactionSourcePath(this.dependencies.projectRoot, relativePath), VISUAL_PRODUCTION_LIMITS.mediaBytes)
  }
  /** 宿主校验媒体项目、版本、hash 后才提供字节。 */
  private async readMedia(reference: MediaAssetRef): Promise<Uint8Array> {
    if (!this.dependencies.readMediaAsset) throw new Error('媒体服务未就绪')
    return this.dependencies.readMediaAsset(reference)
  }
  /** 有界读取作品自己的不可变副本，并重新验证 hash 与格式。 */
  private mediaContent(snapshot: VisualProductionSnapshot, id: string): { mediaId: string; bytes: Uint8Array; mime: string } {
    const media = snapshot.media.find(item => item.id === id)
    if (!media) throw new Error('媒体不属于当前作品')
    const directory = interactionDirectory(this.dependencies.projectRoot, [...VISUAL_PRODUCTION_STORAGE_SEGMENTS, 'projects', snapshot.document.id, 'media'])
    const stored = JSON.parse(readInteractionFile(join(directory, `${media.hash}.json`), VISUAL_PRODUCTION_LIMITS.mediaBytes * 1.4 + 1024).toString()) as { hash: string; data: string }
    const bytes = Buffer.from(stored.data, 'base64')
    if (bytes.length !== media.byteSize || hash(bytes) !== media.hash || stored.hash !== media.hash || mediaFormat(bytes).mime !== media.mime) throw new Error('媒体副本损坏')
    return { mediaId: id, bytes, mime: media.mime }
  }

  /** 将真实成片字节登记到作品媒体库，并更新可下载的媒体索引。 */
  private saveExportArtifact(snapshot: VisualProductionSnapshot, media: VisualMedia, bytes: Uint8Array): void {
    if (bytes.length !== media.byteSize || hash(bytes) !== media.hash) throw new Error('成片媒体 hash 不匹配')
    const existing = snapshot.media.find(item => item.id === media.id)
    if (existing && (existing.hash !== media.hash || existing.byteSize !== media.byteSize)) throw new Error('成片媒体身份冲突')
    const directory = interactionDirectory(this.dependencies.projectRoot, [...VISUAL_PRODUCTION_STORAGE_SEGMENTS, 'projects', snapshot.document.id, 'media'], true)
    const path = join(directory, `${media.hash}.json`)
    if (!existsSync(path)) writeJsonFileAtomicSecure(path, { hash: media.hash, data: Buffer.from(bytes).toString('base64') }, { expectedDestination: { kind: 'missing' } })
    if (!existing) {
      snapshot.media.push(media)
      const state = readAtomicFileState(join(this.directory(snapshot.document.id), 'snapshot.json'))
      if (!state) throw new Error('影像作品快照不存在')
      this.persist(snapshot, state)
    }
  }
}
