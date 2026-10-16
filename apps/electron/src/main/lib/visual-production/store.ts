import { createHash, randomUUID } from 'node:crypto'
import { existsSync, opendirSync } from 'node:fs'
import { basename, join } from 'node:path'
import { parseVisualProductionCommand, parseVisualProductionDraft, VISUAL_PRODUCTION_LIMITS, VISUAL_PRODUCTION_READ_METHODS, assertVisualProductionId } from '@proma/shared'
import type { MediaAssetRef, VisualProductionInputs, VisualProductionMethod, VisualProductionResults, VisualProductionSnapshot, VisualProductionDraft, VisualMedia } from '@proma/shared'
import { acquireMediaFileLock } from '../media/media-file-lock'
import { readAtomicFileState, writeJsonFileAtomicSecure } from '../safe-file'
import type { AtomicFileState } from '../safe-file'
import { interactionDirectory, interactionSourcePath, readInteractionFile } from '../interaction-design/paths'
import { interactionImageMime } from '../interaction-design/asset-service'

/** 宿主注入的可信项目边界；媒体与来源读取均需独立复核。 */
export interface VisualProductionServiceDependencies {
  workspaceId: string
  projectRoot: string
  assertCurrent?: () => void
  readSourceFile?: (relativePath: string, maxBytes: number) => Promise<Buffer>
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
  constructor(private readonly dependencies: VisualProductionServiceDependencies) {}
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
    if (!Array.isArray(snapshot.media) || snapshot.media.length > VISUAL_PRODUCTION_LIMITS.media || !Array.isArray(snapshot.candidates) || snapshot.candidates.length > VISUAL_PRODUCTION_LIMITS.candidates || !Array.isArray(snapshot.jobs) || snapshot.jobs.length > VISUAL_PRODUCTION_LIMITS.jobs || !snapshot.assetVersions || !snapshot.shotStates) throw new Error('影像作品索引损坏')
    for (const media of snapshot.media) {
      if (!media || !['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'video/mp4', 'audio/mpeg', 'audio/wav'].includes(media.mime) || media.mime.split('/')[0] !== media.kind || !/^[a-f0-9]{64}$/.test(media.hash) || media.id !== media.hash || !Number.isSafeInteger(media.byteSize) || media.byteSize < 1 || media.byteSize > VISUAL_PRODUCTION_LIMITS.mediaBytes) throw new Error('媒体索引损坏')
    }
    const unique = (ids: string[]): void => { ids.forEach(assertVisualProductionId); if (new Set(ids).size !== ids.length) throw new Error('持久化身份重复') }
    unique(snapshot.media.map(item => item.id)); unique(snapshot.jobs.map(item => item.id)); unique(snapshot.candidates.map(item => item.id))
    for (const job of snapshot.jobs) {
      assertVisualProductionId(job.sessionId)
      if (!['running', 'candidate', 'cancelled', 'failed', 'interrupted'].includes(job.status) || !Number.isSafeInteger(job.baseRevision) || job.baseRevision < 1 || job.baseRevision > snapshot.document.revision || typeof job.instruction !== 'string' || typeof job.createdAt !== 'number') throw new Error('任务索引损坏')
      if (job.shotId) assertVisualProductionId(job.shotId)
    }
    for (const candidate of snapshot.candidates) {
      parseVisualProductionDraft(candidate.draft)
      this.references(snapshot, candidate.draft)
      if (!['ready', 'stale', 'adopted', 'discarded'].includes(candidate.status) || !Number.isSafeInteger(candidate.baseRevision) || candidate.baseRevision < 1 || candidate.baseRevision > snapshot.document.revision || typeof candidate.summary !== 'string' || !snapshot.jobs.some(job => job.id === candidate.jobId)) throw new Error('候选索引损坏')
      if (candidate.status === 'ready' && candidate.baseRevision !== snapshot.document.revision) throw new Error('候选版本索引损坏')
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
  /** 正式保存统一维护资产与镜头依赖；保留已采用媒体直到显式替换。 */
  private commit(snapshot: VisualProductionSnapshot, draft: VisualProductionDraft): void {
    this.references(snapshot, draft)
    const previous = snapshot.document
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
    for (const candidate of snapshot.candidates) if (candidate.status === 'ready') candidate.status = 'stale'
    for (const job of snapshot.jobs) if (job.status === 'running') { job.status = 'interrupted'; job.message = '正式版本已改变，请基于新版本重新发起。' }
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
    if ('baseRevision' in input && input.baseRevision !== snapshot.document.revision) throw new Error('VISUAL_PRODUCTION_CONFLICT: 正式版本已变化')
    switch (command.method) {
      case 'load': return snapshot
      case 'mediaContent': return this.mediaContent(snapshot, command.input.mediaId)
      case 'exportManifest': return { fileName: `${snapshot.document.id}-manifest.json`, json: JSON.stringify({ schemaVersion: 1, document: snapshot.document, media: snapshot.media, shotStates: snapshot.shotStates, assetVersions: snapshot.assetVersions }, null, 2) }
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
        const job = { id: randomUUID(), sessionId: input.sessionId, baseRevision: snapshot.document.revision, instruction: command.input.instruction, ...(command.input.shotId ? { shotId: command.input.shotId } : {}), status: 'running' as const, createdAt: Date.now() }
        snapshot.jobs.push(job); this.persist(snapshot, state); return job
      }
      case 'propose': {
        const job = snapshot.jobs.find(item => item.id === command.input.jobId && item.sessionId === input.sessionId)
        if (!job || job.status !== 'running' || job.baseRevision !== snapshot.document.revision) throw new Error('任务已取消、过期或不属于当前会话')
        /** 最近终态历史有界保留，待采纳结果绝不自动丢弃。 */
        while (snapshot.candidates.length >= VISUAL_PRODUCTION_LIMITS.candidates) {
          const removable = snapshot.candidates.findIndex(candidate => candidate.status !== 'ready')
          if (removable < 0) throw new Error('待采纳候选数量超过预算，请先采纳或丢弃')
          snapshot.candidates.splice(removable, 1)
        }
        const draft = parseVisualProductionDraft(command.input.draft)
        this.references(snapshot, draft)
        for (const asset of snapshot.document.assets) if (asset.locked && !same(asset, draft.assets.find(item => item.id === asset.id))) throw new Error('候选不能修改锁定资产')
        if (job.shotId) {
          const original = parseVisualProductionDraft(editable(snapshot.document))
          if (original.shots.find(shot => shot.id === job.shotId)?.episodeId !== draft.shots.find(shot => shot.id === job.shotId)?.episodeId || !same(original.shots.map(shot => shot.id), draft.shots.map(shot => shot.id)) || !draft.shots.some(shot => shot.id === job.shotId) || !same({ ...original, shots: original.shots.filter(shot => shot.id !== job.shotId) }, { ...draft, shots: draft.shots.filter(shot => shot.id !== job.shotId) })) throw new Error('单镜头任务不能修改其他内容')
        }
        const candidate = { id: randomUUID(), baseRevision: job.baseRevision, draft, summary: command.input.summary, status: 'ready' as const, jobId: job.id, createdAt: Date.now() }
        snapshot.candidates.push(candidate); job.status = 'candidate'; this.persist(snapshot, state); return candidate
      }
      case 'adopt': {
        const candidate = snapshot.candidates.find(item => item.id === command.input.candidateId)
        if (!candidate || candidate.status !== 'ready' || candidate.baseRevision !== snapshot.document.revision) throw new Error('候选已过期或不可采纳')
        for (const asset of snapshot.document.assets) if (asset.locked && !same(asset, candidate.draft.assets.find(item => item.id === asset.id))) throw new Error('候选不能修改锁定资产')
        this.commit(snapshot, candidate.draft); candidate.status = 'adopted'; candidate.adoptedRevision = snapshot.document.revision; break
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
