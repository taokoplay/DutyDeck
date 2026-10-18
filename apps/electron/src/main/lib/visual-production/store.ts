import { createHash, randomUUID } from 'node:crypto'
import { existsSync, opendirSync } from 'node:fs'
import { basename, join } from 'node:path'
import { visualProductionMediaSourceAllows, parseVisualProductionMediaConfiguration, parseVisualProductionMediaExecution, parseVisualProductionCommand, parseVisualProductionDraft, VISUAL_PRODUCTION_LIMITS, VISUAL_PRODUCTION_READ_METHODS, assertVisualProductionId } from '@dutydeck/shared'
import type { MediaAssetRef, VisualCandidate, VisualProductionInputs, VisualProductionMethod, VisualProductionResults, VisualProductionSnapshot, VisualProductionDraft, VisualMedia, VisualJob, VisualProductionMediaOption, VisualProductionMediaExecution } from '@dutydeck/shared'
import { acquireMediaFileLock } from '../media/media-file-lock'
import { readAtomicFileState, writeJsonFileAtomicSecure } from '../safe-file'
import type { AtomicFileState } from '../safe-file'
import { interactionDirectory, interactionSourcePath, readInteractionFile } from '../interaction-design/paths'
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
}
/** 内容摘要用于不可变媒体与版本比较。 */
function hash(bytes: Uint8Array): string { return createHash('sha256').update(bytes).digest('hex') }
/** 只投影可编辑字段，系统身份不得作为不可信草稿输入。 */
function editable(document: VisualProductionDraft): VisualProductionDraft {
  const { title, kind, brief, ratio, fps, voice, music, episodes, assets, shots } = document
  return { title, kind, brief, ratio, fps, voice, music, episodes, assets, shots }
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
    this.editing = new VisualEditingStore({ projectRoot: dependencies.projectRoot, assertCurrent: dependencies.assertCurrent })
  }
  /** 固定受管目录；所有层级禁止软链接。 */
  private directory(id?: string, create = false): string {
    return interactionDirectory(this.dependencies.projectRoot, ['.proma', 'visual-production', 'projects', ...(id ? [id] : [])], create)
  }
  /** 有界枚举作品目录，损坏对象不能静默忽略。 */
  private ids(): string[] {
    if (!existsSync(join(this.dependencies.projectRoot, '.proma', 'visual-production', 'projects'))) return []
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
      const media = shot.mediaId ? mediaById.get(shot.mediaId) : undefined
      if (media && (media.kind === 'audio' || (draft.kind === 'image' && media.kind !== 'image'))) throw new Error('镜头媒体类型与作品不匹配')
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
    /** 只有宿主确认纯画面变更后才允许合并其他候选，正式编辑仍使旧输入失效。 */
    const outputOnly = preserveOutputs && shotOutputChanges(previous, draft) !== null
    /** 在更新正式版本前冻结每份候选自身的媒体差异，禁止用旧完整草稿覆盖新作品。 */
    const pendingOutputs = new Map(snapshot.candidates.filter(candidate => candidate.status === 'ready').map(candidate => [candidate.id, outputOnly ? shotOutputChanges(previous, candidate.draft) : null]))
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
      const replaced = Boolean(shot.mediaId && shot.mediaId !== old?.mediaId)
      const changed = !same(old, shot)
      nextStates[shot.id] = { revision: (prior?.revision ?? 0) + (changed ? 1 : 0), outputVersion: (prior?.outputVersion ?? 0) + (replaced ? 1 : 0), needsUpdate: replaced ? false : !shot.mediaId || Boolean(prior?.needsUpdate) || changed || settingsChanged || shot.assetIds.some(id => changedAssets.has(id)) }
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
      candidate.draft = withShotOutputs(snapshot.document, outputs)
      if (!shotOutputChanges(snapshot.document, candidate.draft)) { candidate.status = 'adopted'; candidate.adoptedRevision = snapshot.document.revision }
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
        if (!shots.has(shot.id) || !shot.mediaId || shot.mediaId === shots.get(shot.id)!.mediaId) continue
        const alternatives = choices.get(shot.id) ?? new Set<string>()
        alternatives.add(shot.mediaId); choices.set(shot.id, alternatives)
      }
    }
    /** 只合并纯画面候选；混有剧本或资产变更的草稿继续等待人工采用。 */
    const selected: VisualCandidate[] = []
    const outputs = new Map<string, string>()
    for (const candidate of ready) {
      const changes = shotOutputChanges(snapshot.document, candidate.draft)
      /** 同镜头连续运行各一张也属于多图；整作品输出数超过改图镜头数时也无法证明每镜唯一。 */
      const job = jobs.get(candidate.jobId)
      const imageRuns = job?.mediaExecutions?.filter(receipt => receipt.kind === 'image') ?? []
      const multipleOutputs = imageRuns.some(receipt => (receipt.outputCount ?? 0) > 1)
        || imageRuns.reduce((count, receipt) => count + (receipt.outputCount ?? 0), 0) > (job?.shotId ? 1 : new Set(changes?.values()).size)
      if (!changes || multipleOutputs) continue
      if ([...changes].some(([shotId, mediaId]) => shots.get(shotId)?.mediaId !== null || media.get(mediaId)?.kind !== 'image' || choices.get(shotId)?.size !== 1)) continue
      selected.push(candidate)
      for (const [shotId, mediaId] of changes) outputs.set(shotId, mediaId)
    }
    if (!selected.length) return false
    /** 提交前串行核验实际字节，损坏或缺失素材不能成为正式画面。 */
    for (const mediaId of new Set(outputs.values())) this.mediaContent(snapshot, mediaId)
    for (const candidate of selected) candidate.status = 'adopted'
    this.commit(snapshot, withShotOutputs(snapshot.document, outputs), true)
    for (const candidate of selected) candidate.adoptedRevision = snapshot.document.revision
    return true
  }

  /** 校验并登记同一任务的全部候选，自动采用判断必须在所有替选入列之后进行。 */
  private proposeCandidates(snapshot: VisualProductionSnapshot, job: VisualJob, drafts: VisualProductionDraft[], summary: string): VisualCandidate {
    for (const draft of drafts) {
      this.references(snapshot, draft)
      for (const asset of snapshot.document.assets) if (asset.locked && !same(asset, draft.assets.find(item => item.id === asset.id))) throw new Error('候选不能修改锁定资产')
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
    const candidates: VisualCandidate[] = drafts.map(draft => ({ id: randomUUID(), baseRevision: snapshot.document.revision, ...(job.baseRevision === snapshot.document.revision ? {} : { sourceRevision: job.baseRevision }), draft, summary, status: 'ready', jobId: job.id, createdAt: Date.now() }))
    snapshot.candidates.push(...candidates)
    job.status = 'candidate'
    this.autoAdoptShots(snapshot)
    return candidates[0]!
  }
  /** 执行经过严格解析的单命令；异步来源读取完成后重新读取当前快照。 */
  async invoke<M extends VisualProductionMethod>(method: M, input: VisualProductionInputs[M]): Promise<VisualProductionResults[M]> {
    this.dependencies.assertCurrent?.()
    const command = parseVisualProductionCommand({ method, input })
    /** 跨进程锁覆盖读、校验、异步准备和提交，原子文件 CAS 再次确认目标身份。 */
    const release = VISUAL_PRODUCTION_READ_METHODS.includes(method) ? undefined : acquireMediaFileLock(join(interactionDirectory(this.dependencies.projectRoot, ['.proma', 'visual-production'], true), 'write.lock'))
    try { return await this.execute(command) as VisualProductionResults[M] } finally { release?.() }
  }
  /** 联合命令分派保留每个方法的输入收窄。 */
  private async execute(command: ReturnType<typeof parseVisualProductionCommand>): Promise<unknown> {
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
      const directory = interactionDirectory(this.dependencies.projectRoot, ['.proma', 'visual-production', 'projects', input.productionId, 'media'], true)
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
      if (['proposeShot', 'referenceMedia', 'updateJob', 'recordMediaExecution'].includes(command.method) && 'jobId' in input) this.currentJob(snapshot, { sessionId: input.sessionId, baseRevision: input.baseRevision, jobId: input.jobId })
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
      case 'proposeTimelineEdit': case 'adoptTimelineEdit': case 'discardTimelineEdit': case 'requestExport': case 'listExportJobs': case 'cancelExport': throw new Error('VISUAL_EDITING_UNAVAILABLE: 时间线候选与成片导出尚未接入')
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
      case 'beginJob': {
        /** 仅裁剪未被待采纳候选引用的最老终态任务，关联终态候选一同裁剪。 */
        const referencedJobs = new Set(snapshot.candidates.filter(candidate => candidate.status === 'ready').map(candidate => candidate.jobId))
        while (snapshot.jobs.length >= VISUAL_PRODUCTION_LIMITS.jobs) {
          const removable = snapshot.jobs.findIndex(job => job.status !== 'running' && !referencedJobs.has(job.id))
          if (removable < 0) throw new Error('活动任务数量超过预算，请先取消不再需要的任务')
          const removed = snapshot.jobs.splice(removable, 1)[0]!
          snapshot.candidates = snapshot.candidates.filter(candidate => candidate.jobId !== removed.id)
        }
        if (command.input.shotId && !snapshot.document.shots.some(shot => shot.id === command.input.shotId)) throw new Error('镜头不存在')
        const job = { ...(snapshot.mediaConfiguration ? { mediaConfiguration: structuredClone(snapshot.mediaConfiguration) } : {}), id: randomUUID(), sessionId: input.sessionId, baseRevision: snapshot.document.revision, instruction: command.input.instruction, ...(command.input.shotId ? { shotId: command.input.shotId } : {}), status: 'running' as const, stage: 'preparing' as const, createdAt: Date.now() }
        snapshot.jobs.push(job); this.persist(snapshot, state); return job
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
        if (![...shots, ...assets].some(item => item.mediaId === command.input.mediaId)) throw new Error('媒体不属于任务正式参考范围')
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
        if (!shot || mediaIds.some(mediaId => mediaId === shot.mediaId)) throw new Error('镜头输出没有变化')
        /** 使用最新正式内容构造候选，旧基线兼容不能带回其他镜头的旧画面。 */
        const drafts = mediaIds.map(mediaId => withShotOutputs(snapshot.document, new Map([[shot.id, mediaId]])))
        const candidate = this.proposeCandidates(snapshot, job, drafts, command.input.summary)
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
        const candidate = snapshot.candidates.find(item => item.id === command.input.candidateId)
        if (!candidate || candidate.status !== 'ready' || candidate.baseRevision !== snapshot.document.revision) throw new Error('候选已过期或不可采纳')
        for (const asset of snapshot.document.assets) if (asset.locked && !same(asset, candidate.draft.assets.find(item => item.id === asset.id))) throw new Error('候选不能修改锁定资产')
        /** 手工选择也仅合并本次输出；完整创作候选仍沿用严格的整作品提交。 */
        const outputs = shotOutputChanges(snapshot.document, candidate.draft)
        if (outputs) for (const mediaId of new Set(outputs.values())) this.mediaContent(snapshot, mediaId)
        candidate.status = 'adopted'
        this.commit(snapshot, candidate.draft, outputs !== null)
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
    const directory = interactionDirectory(this.dependencies.projectRoot, ['.proma', 'visual-production', 'projects', snapshot.document.id, 'media'])
    const stored = JSON.parse(readInteractionFile(join(directory, `${media.hash}.json`), VISUAL_PRODUCTION_LIMITS.mediaBytes * 1.4 + 1024).toString()) as { hash: string; data: string }
    const bytes = Buffer.from(stored.data, 'base64')
    if (bytes.length !== media.byteSize || hash(bytes) !== media.hash || stored.hash !== media.hash || mediaFormat(bytes).mime !== media.mime) throw new Error('媒体副本损坏')
    return { mediaId: id, bytes, mime: media.mime }
  }
}
