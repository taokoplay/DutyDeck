import { createHash, randomUUID } from 'node:crypto'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { resolveVisualShotOutputs, applyVisualEditingOperations, parseVisualEditingDocument, parseVisualEditingExportSettings, parseVisualEditingOperations, VISUAL_PRODUCTION_STORAGE_SEGMENTS, VISUAL_PRODUCTION_LIMITS } from '@dutydeck/shared'
import type { VisualEditingClip, VisualEditingDocument, VisualEditingExportJob, VisualEditingExportSettings, VisualEditingOperation, VisualEditingTimelineCandidate, VisualEditingTimelineSnapshot, VisualProductionInputs, VisualProductionSnapshot, VisualMedia } from '@dutydeck/shared'
import { readAtomicFileState, writeJsonFileAtomicSecure } from '../safe-file'
import type { AtomicFileState } from '../safe-file'
import { interactionDirectory, readInteractionFile } from '../interaction-design/paths'
import { resolveProjectStorageDirectory } from '../project-storage/project-storage-paths'
import { probeMediaFile } from '../media/media-file-probe'
import { buildVisualEditingPreview, selectVisualPreviewOutputs } from './editing-preview'

/** 每集剪辑文件的持久化外壳，为后续候选和导出任务预留稳定边界。 */
interface VisualEditingFile {
  schemaVersion: 1
  timeline: VisualEditingDocument
  candidates: VisualEditingTimelineSnapshot['candidates']
  exportJobs: VisualEditingTimelineSnapshot['exportJobs']
}

/** 剪辑时间线存储依赖的作品快照读取能力。 */
export interface VisualEditingStoreDependencies {
  /** 异步探测结束后重读正式作品，拒绝已更换的来源。 */
  getCurrentSnapshot?: (productionId: string) => VisualProductionSnapshot
  /** 技术探测注入点；返回真实媒体可用时长，单位秒。 */
  probeDuration?: (snapshot: VisualProductionSnapshot, media: VisualMedia) => Promise<number>
  /** 当前调用者是否仍属于原项目。 */
  assertCurrent?: () => void
  /** 影像作品的完整快照，仅用于校验片段来源。 */
  workspaceId?: string
  projectRoot: string
  /** 执行真实成片编码；未提供时必须返回明确失败任务，不得伪造媒体。 */
  renderExport?: (input: { productionId: string; episodeId: string; timeline: VisualEditingDocument; settings: VisualEditingExportSettings; sourceMedia: VisualMedia[]; readMedia: (mediaId: string) => { bytes: Uint8Array; mime: string } }) => Promise<{ encoderId: string; artifactMedia: VisualMedia; artifactBytes: Uint8Array }>
  /** 将编码完成的媒体原子登记回影像作品媒体库。 */
  saveExportArtifact?: (snapshot: VisualProductionSnapshot, media: VisualMedia, bytes: Uint8Array) => void
}

/** 每集一条独立时间线，原子保存且不把媒体字节写入剪辑文件。 */
export class VisualEditingStore {
  constructor(private readonly dependencies: VisualEditingStoreDependencies) {}

  /** 返回作品剪辑目录；路径段来自已解析的影像身份。 */
  private directory(productionId: string, create = false): string {
    return interactionDirectory(this.dependencies.projectRoot, [...VISUAL_PRODUCTION_STORAGE_SEGMENTS, 'projects', productionId, 'editing'], create)
  }

  /** 返回指定集的 JSON 文件路径。 */
  private path(productionId: string, episodeId: string, create = false): string {
    return join(this.directory(productionId, create), `${episodeId}.json`)
  }

  /** 读取文件并验证持久化外壳，损坏内容不能静默当成空剪辑。 */
  private read(productionId: string, episodeId: string): { file: VisualEditingFile; state: AtomicFileState } | null {
    /** 缺失剪辑返回空；目录选择与作品读写保持一致，兼容尚未迁移的旧作品。 */
    const directory = join(resolveProjectStorageDirectory(this.dependencies.projectRoot, 'visual-production', false), 'projects', productionId, 'editing')
    if (!existsSync(directory)) return null
    const path = this.path(productionId, episodeId)
    const state = readAtomicFileState(path)
    if (!state) return null
    const file = JSON.parse(readInteractionFile(path, 8 * 1024 * 1024).toString()) as VisualEditingFile
    if (!file || file.schemaVersion !== 1 || !file.timeline || file.timeline.productionId !== productionId || file.timeline.episodeId !== episodeId || !Array.isArray(file.candidates) || !Array.isArray(file.exportJobs)) throw new Error('影像剪辑文件损坏')
    const candidates = file.candidates.map(candidate => ({ ...candidate, timeline: parseVisualEditingDocument(candidate.timeline), operations: parseVisualEditingOperations(candidate.operations) }))
    return { file: { schemaVersion: 1, timeline: parseVisualEditingDocument(file.timeline), candidates, exportJobs: file.exportJobs }, state }
  }

  /** 核验集数存在并返回其镜头集合。 */
  private episode(snapshot: VisualProductionSnapshot, episodeId: string): void {
    if (!snapshot.document.episodes.some(item => item.id === episodeId)) throw new Error('集数不存在')
  }

  /** 校验时间线来源仍属于作品，并保留旧版本媒体用于回看。 */
  private references(snapshot: VisualProductionSnapshot, timeline: VisualEditingDocument): void {
    if (timeline.productionId !== snapshot.document.id) throw new Error('时间线不属于当前作品')
    if (!snapshot.document.episodes.some(item => item.id === timeline.episodeId)) throw new Error('时间线集数不存在')
    const media = new Map(snapshot.media.map(item => [item.id, item]))
    const shots = new Map(snapshot.document.shots.map(item => [item.id, item]))
    for (const track of timeline.tracks) {
      if (track.kind === 'caption') continue
      for (const clip of track.clips) {
        const source = clip.source
        if (!source) throw new Error('媒体片段缺少来源')
        const currentMedia = media.get(source.mediaId)
        const shot = shots.get(source.shotId)
        if (!currentMedia || currentMedia.hash !== source.mediaHash) throw new Error('时间线来源媒体不存在或 hash 不匹配')
        if (!shot || shot.episodeId !== timeline.episodeId) throw new Error('时间线来源镜头不存在或集数不匹配')
      }
    }
  }

  /** 标记源镜头已经产生新输出的片段，不修改正式文件。 */
  private replacementIds(snapshot: VisualProductionSnapshot, timeline: VisualEditingDocument): string[] {
    const media = new Map(snapshot.media.map(item => [item.id, item]))
    const result: string[] = []
    for (const track of timeline.tracks) {
      for (const clip of track.clips) {
        const source = clip.source
        if (!source) continue
        const shot = snapshot.document.shots.find(item => item.id === source.shotId)
        const currentMedia = media.get(source.mediaId)
        /** 按原媒体类型比较独立槽，音频更新不使画面片段失效。 */
        const outputId = shot && currentMedia ? resolveVisualShotOutputs(shot, media)[currentMedia.kind] : null
        if (!shot || !currentMedia || outputId !== source.mediaId || currentMedia.hash !== source.mediaHash) result.push(clip.id)
      }
    }
    return result
  }

  /** 生成无时间线的空快照。 */
  private empty(): VisualEditingTimelineSnapshot {
    return { timeline: null, needsReplacementClipIds: [], candidates: [], exportJobs: [] }
  }

  /** 核验替换操作只绑定同轨道当前已采用输出，返回需探测的媒体集合。 */
  private replacementMedia(snapshot: VisualProductionSnapshot, timeline: VisualEditingDocument, operations: VisualEditingOperation[]): VisualMedia[] {
    /** 按媒体身份去重，避免多个片段重复读取同一文件。 */
    const media = new Map(snapshot.media.map(item => [item.id, item]))
    const replacements = new Map<string, VisualMedia>()
    for (const operation of operations) {
      if (operation.type !== 'replaceClipSource' && operation.type !== 'insertAudioClip') continue
      /** 来源身份必须精确匹配作品内同集镜头的正式输出。 */
      const source = operation.source
      const track = timeline.tracks.find(item => item.id === operation.trackId)
      const shot = snapshot.document.shots.find(item => item.id === source.shotId)
      const selected = media.get(source.mediaId)
      const outputs = shot ? resolveVisualShotOutputs(shot, media) : undefined
      const trackKind = operation.type === 'insertAudioClip' ? operation.kind : track?.kind
      const adoptedId = trackKind === 'video' ? outputs?.video ?? outputs?.image : trackKind === 'voice' || trackKind === 'music' ? outputs?.audio : undefined
      if (!shot || shot.episodeId !== timeline.episodeId || !selected || selected.hash !== source.mediaHash
        || adoptedId !== source.mediaId || source.shotOutputVersion !== (snapshot.shotStates[shot.id]?.outputVersion ?? 0)
        || !Number.isSafeInteger(source.shotOutputVersion)
        || (trackKind === 'video' ? !['video', 'image'].includes(selected.kind) : selected.kind !== 'audio')
        || (operation.type === 'replaceClipSource' && (!track || track.kind === 'caption'))
        || (operation.type === 'insertAudioClip' && track && track.kind !== operation.kind)) {
        throw new Error('音频或替换来源不是该镜头当前已采用输出或版本已过期')
      }
      replacements.set(selected.id, selected)
    }
    return [...replacements.values()]
  }

  /** 探测受管不可变副本，不信任调用方时长；临时文件始终清理。 */
  private async sourceDuration(snapshot: VisualProductionSnapshot, media: VisualMedia): Promise<number> {
    if (this.dependencies.probeDuration) return this.dependencies.probeDuration(snapshot, media)
    /** 读取副本后重新校验内容哈希，避免探测被篡改文件。 */
    const content = this.mediaContent(snapshot, media.id)
    if (createHash('sha256').update(content.bytes).digest('hex') !== media.hash) throw new Error('媒体副本 hash 不匹配')
    const directory = await mkdtemp(join(tmpdir(), 'dutydeck-editing-probe-'))
    try {
      /** 私有文件不接收任何调用方路径。 */
      const path = join(directory, 'source')
      await writeFile(path, content.bytes, { mode: 0o600 })
      const result = await probeMediaFile(path, content.bytes)
      if (result.mediaKind !== media.kind) throw new Error('替换来源媒体类别不匹配')
      const durationMs = result.mediaKind === 'video' ? result.visualDurationMs : result.metadata.durationMs
      if (!durationMs) throw new Error('无法确认替换来源的真实流时长')
      return durationMs / 1000
    } finally { await rm(directory, { recursive: true, force: true }) }
  }

  /** 在整个操作批次完成后检查新源剪点，允许同批显式裁短；异步后再核验正式来源。 */
  private async validateReplacements(snapshot: VisualProductionSnapshot, timeline: VisualEditingDocument, operations: VisualEditingOperation[]): Promise<void> {
    /** 同一批次同媒体只探测一次，静态图片没有视频时长约束。 */
    const replacements = this.replacementMedia(snapshot, timeline, operations)
    for (const media of replacements) {
      if (media.kind === 'image') continue
      const duration = await this.sourceDuration(snapshot, media)
      if (!Number.isFinite(duration) || duration <= 0) throw new Error('无法确认替换来源时长')
      for (const track of timeline.tracks) for (const clip of track.clips) {
        // 探测元数据以毫秒计，允许最多 1ms 数值误差，不扩展到整帧。
        if (clip.source?.mediaId === media.id && clip.sourceOut > duration + 0.001) throw new Error('替换或插入来源时长不足，请在同批操作中裁切到有效范围')
      }
    }
    this.dependencies.assertCurrent?.()
    this.replacementMedia(this.dependencies.getCurrentSnapshot?.(snapshot.document.id) ?? snapshot, timeline, operations)
  }

  /** 读取某集时间线，并计算当前源媒体失效提示。 */
  load(snapshot: VisualProductionSnapshot, episodeId: string): VisualEditingTimelineSnapshot {
    this.dependencies.assertCurrent?.()
    this.episode(snapshot, episodeId)
    const stored = this.read(snapshot.document.id, episodeId)
    if (!stored) return this.empty()
    this.references(snapshot, stored.file.timeline)
    const timeline = structuredClone(stored.file.timeline)
    const candidates = structuredClone(stored.file.candidates).map(candidate => candidate.status === 'ready' && candidate.baseRevision !== timeline.revision ? { ...candidate, status: 'stale' as const } : candidate)
    return { timeline, needsReplacementClipIds: this.replacementIds(snapshot, timeline), candidates, exportJobs: structuredClone(stored.file.exportJobs) }
  }

  /** 按当前集的分镜顺序创建初始视频轨，未采用镜头不伪造片段。 */
  createRoughCut(snapshot: VisualProductionSnapshot, episodeId: string): VisualEditingTimelineSnapshot {
    this.dependencies.assertCurrent?.()
    this.episode(snapshot, episodeId)
    if (this.read(snapshot.document.id, episodeId)) throw new Error('当前集已经存在剪辑时间线')
    const now = Date.now()
    let cursor = 0
    const clips: VisualEditingClip[] = []
    /** 独立声音按镜头起点对齐，已有时间线不自动重建。 */
    const voices: VisualEditingClip[] = []
    const mediaById = new Map(snapshot.media.map(item => [item.id, item]))
    for (const shot of snapshot.document.shots.filter(item => item.episodeId === episodeId)) {
      const outputs = resolveVisualShotOutputs(shot, mediaById)
      const media = mediaById.get(outputs.video ?? outputs.image ?? '')
      if (!media || (media.kind !== 'image' && media.kind !== 'video')) continue
      const duration = Math.max(shot.duration, 0.1)
      const outputVersion = snapshot.shotStates[shot.id]?.outputVersion ?? 0
      clips.push({ id: randomUUID(), source: { type: 'shot-media', shotId: shot.id, mediaId: media.id, mediaHash: media.hash, shotOutputVersion: outputVersion }, start: cursor, duration, sourceIn: 0, sourceOut: duration, label: shot.title })
      const audio = outputs.audio ? mediaById.get(outputs.audio) : undefined
      if (audio?.kind === 'audio') voices.push({ id: randomUUID(), source: { type: 'shot-media', shotId: shot.id, mediaId: audio.id, mediaHash: audio.hash, shotOutputVersion: outputVersion }, start: cursor, duration, sourceIn: 0, sourceOut: duration, label: `${shot.title} · 音频`, volume: 1 })
      cursor += duration
    }
    if (!clips.length) throw new Error('当前集没有可剪辑的已采用镜头')
    const timeline: VisualEditingDocument = { schemaVersion: 1, id: randomUUID(), productionId: snapshot.document.id, episodeId, revision: 1, baseProductionRevision: snapshot.document.revision, tracks: [{ id: 'video', kind: 'video', clips }, ...(voices.length ? [{ id: 'voice', kind: 'voice' as const, clips: voices }] : [])], duration: cursor, createdAt: now, updatedAt: now }
    parseVisualEditingDocument(timeline)
    const path = this.path(snapshot.document.id, episodeId, true)
    const file: VisualEditingFile = { schemaVersion: 1, timeline, candidates: [], exportJobs: [] }
    writeJsonFileAtomicSecure(path, file, { expectedDestination: { kind: 'missing' } })
    return this.load(snapshot, episodeId)
  }

  /** 保存一次正式时间线，CAS 失败时不覆盖其他会话的新版本。 */
  save(snapshot: VisualProductionSnapshot, episodeId: string, expectedRevision: number, timeline: VisualEditingDocument): VisualEditingTimelineSnapshot {
    this.dependencies.assertCurrent?.()
    this.episode(snapshot, episodeId)
    const parsed = parseVisualEditingDocument(timeline)
    if (parsed.productionId !== snapshot.document.id || parsed.episodeId !== episodeId) throw new Error('时间线身份不匹配')
    if (parsed.revision !== expectedRevision + 1) throw new Error('时间线版本必须递增一')
    this.references(snapshot, parsed)
    const path = this.path(snapshot.document.id, episodeId, true)
    const previous = readAtomicFileState(path)
    if (expectedRevision === 0 ? previous !== null : previous === null) throw new Error('VISUAL_EDITING_CONFLICT: 时间线已变化')
    if (previous) {
      const stored = this.read(snapshot.document.id, episodeId)
      if (!stored || stored.file.timeline.revision !== expectedRevision) throw new Error('VISUAL_EDITING_CONFLICT: 时间线已变化')
    }
    const file: VisualEditingFile = { schemaVersion: 1, timeline: { ...parsed, updatedAt: Date.now() }, candidates: previous ? this.read(snapshot.document.id, episodeId)!.file.candidates : [], exportJobs: previous ? this.read(snapshot.document.id, episodeId)!.file.exportJobs : [] }
    writeJsonFileAtomicSecure(path, file, { expectedDestination: previous ? { kind: 'state', state: previous } : { kind: 'missing' } })
    return this.load(snapshot, episodeId)
  }

  /** 为 Agent 生成候选时间线，正式版本保持不变。 */
  async propose(snapshot: VisualProductionSnapshot, episodeId: string, expectedRevision: number, operations: VisualEditingOperation[], summary: string, sessionId: string): Promise<VisualEditingTimelineCandidate> {
    this.dependencies.assertCurrent?.()
    this.episode(snapshot, episodeId)
    const stored = this.read(snapshot.document.id, episodeId)
    if (!stored || stored.file.timeline.revision !== expectedRevision) throw new Error('VISUAL_EDITING_CONFLICT: 时间线已变化或尚未建立')
    const candidateTimeline = applyVisualEditingOperations(stored.file.timeline, operations)
    this.references(snapshot, candidateTimeline)
    await this.validateReplacements(snapshot, candidateTimeline, operations)
    const candidate: VisualEditingTimelineCandidate = { id: randomUUID(), baseRevision: expectedRevision, timeline: candidateTimeline, operations: structuredClone(operations), summary, status: 'ready', sessionId, createdAt: Date.now() }
    const candidates = [...stored.file.candidates]
    while (candidates.length >= 32) {
      const removable = candidates.findIndex(item => item.status !== 'ready')
      if (removable < 0) throw new Error('待采用剪辑候选数量超过预算，请先采用或丢弃')
      candidates.splice(removable, 1)
    }
    candidates.push(candidate)
    const path = this.path(snapshot.document.id, episodeId, true)
    writeJsonFileAtomicSecure(path, { ...stored.file, candidates }, { expectedDestination: { kind: 'state', state: stored.state } })
    return candidate
  }

  /** 原子采用候选并只递增时间线版本，不修改影像作品正式版本。 */
  async adopt(snapshot: VisualProductionSnapshot, episodeId: string, candidateId: string, expectedRevision: number): Promise<VisualEditingTimelineSnapshot> {
    this.dependencies.assertCurrent?.()
    const stored = this.read(snapshot.document.id, episodeId)
    const candidate = stored?.file.candidates.find(item => item.id === candidateId)
    if (!stored || stored.file.timeline.revision !== expectedRevision || !candidate || candidate.status !== 'ready' || candidate.baseRevision !== expectedRevision) throw new Error('候选已过期或不可采纳')
    const timeline = { ...candidate.timeline, revision: expectedRevision + 1, updatedAt: Date.now() }
    this.references(snapshot, timeline)
    await this.validateReplacements(snapshot, timeline, candidate.operations)
    const candidates = stored.file.candidates.map(item => item.id === candidateId ? { ...item, status: 'adopted' as const } : item)
    writeJsonFileAtomicSecure(this.path(snapshot.document.id, episodeId, true), { ...stored.file, timeline, candidates }, { expectedDestination: { kind: 'state', state: stored.state } })
    return this.load(snapshot, episodeId)
  }

  /** 丢弃候选只改变剪辑历史，不回写正式时间线。 */
  discard(snapshot: VisualProductionSnapshot, episodeId: string, candidateId: string): VisualEditingTimelineSnapshot {
    this.dependencies.assertCurrent?.()
    const stored = this.read(snapshot.document.id, episodeId)
    const candidate = stored?.file.candidates.find(item => item.id === candidateId)
    if (!stored || !candidate || candidate.status === 'adopted') throw new Error('候选不可丢弃')
    const candidates = stored.file.candidates.map(item => item.id === candidateId ? { ...item, status: 'discarded' as const } : item)
    writeJsonFileAtomicSecure(this.path(snapshot.document.id, episodeId, true), { ...stored.file, candidates }, { expectedDestination: { kind: 'state', state: stored.state } })
    return this.load(snapshot, episodeId)
  }

  /** 原生组合未采用候选用于审片；冻结来源但不修改正式版本、时间线或审核结论。 */
  async requestPreview(snapshot: VisualProductionSnapshot, input: VisualProductionInputs['requestPreview']): Promise<VisualEditingExportJob> {
    this.dependencies.assertCurrent?.()
    this.episode(snapshot, input.episodeId)
    const stored = this.read(snapshot.document.id, input.episodeId)
    if (!stored) throw new Error('VISUAL_EDITING_CONFLICT: 预览前请先建立剪辑时间线')
    const settings = parseVisualEditingExportSettings(input.settings)
    const selections = selectVisualPreviewOutputs(snapshot, stored.file.timeline, input)
    /** 真实探测按媒体身份缓存，同次请求不重复运行探测器。 */
    const durations = new Map<string, number>()
    const durationOf = async (media: VisualMedia): Promise<number> => {
      const known = durations.get(media.id)
      if (known !== undefined) return known
      const duration = await this.sourceDuration(snapshot, media)
      if (!Number.isFinite(duration) || duration <= 0) throw new Error('无法确认预览来源真实时长')
      durations.set(media.id, duration)
      return duration
    }
    for (const output of selections) if (output.media.kind === 'audio') await durationOf(output.media)
    const timeline = buildVisualEditingPreview(stored.file.timeline, selections, durations, input.range)
    /** 未包含的声音轨不读取、不探测，也不计入冻结来源。 */
    timeline.tracks = timeline.tracks.filter(track => track.kind === 'video' || (track.kind === 'voice' && settings.includeVoice) || (track.kind === 'music' && settings.includeMusic) || (track.kind === 'caption' && settings.includeCaptions))
    this.references(snapshot, timeline)
    for (const track of timeline.tracks) for (const clip of track.clips) {
      if (track.kind === 'caption') continue
      const media = snapshot.media.find(item => item.id === clip.source?.mediaId)
      if (!media || (track.kind === 'video' ? !['image', 'video'].includes(media.kind) : media.kind !== 'audio')) throw new Error('预览轨道来源媒体类型不匹配')
    }
    const sourceIds = new Set(timeline.tracks.flatMap(track => track.clips.flatMap(clip => clip.source ? [clip.source.mediaId] : [])))
    const sourceMedia = snapshot.media.filter(media => sourceIds.has(media.id))
    for (const media of sourceMedia) {
      const content = this.mediaContent(snapshot, media.id)
      if (createHash('sha256').update(content.bytes).digest('hex') !== media.hash) throw new Error('预览来源媒体 hash 不匹配')
      if (media.kind === 'image') continue
      const duration = await durationOf(media)
      for (const track of timeline.tracks) for (const clip of track.clips) {
        if (clip.source?.mediaId === media.id && clip.sourceOut > duration + 0.001) throw new Error('预览来源真实时长不足，请先修正剪点')
      }
    }
    /** 异步探测后重新验证候选和正式时间线，不能用过期来源启动编码。 */
    this.dependencies.assertCurrent?.()
    const currentSnapshot = this.dependencies.getCurrentSnapshot?.(snapshot.document.id) ?? snapshot
    const current = this.read(snapshot.document.id, input.episodeId)
    if (!current || JSON.stringify(current.file.timeline) !== JSON.stringify(stored.file.timeline)) throw new Error('VISUAL_EDITING_CONFLICT: 预览时间线版本已变化')
    const currentSelections = selectVisualPreviewOutputs(currentSnapshot, current.file.timeline, input)
    if (JSON.stringify(currentSelections) !== JSON.stringify(selections)) throw new Error('VISUAL_EDITING_CONFLICT: 预览候选来源已变化')
    const now = Date.now()
    const job: VisualEditingExportJob = {
      id: randomUUID(), productionId: input.productionId, episodeId: input.episodeId, timelineRevision: input.expectedTimelineRevision,
      preview: { productionRevision: input.baseRevision, candidateIds: [...input.candidateIds], range: { ...input.range } },
      sourceHashes: [...new Set(sourceMedia.map(media => media.hash))].sort(), settings,
      status: 'rendering', createdAt: now, updatedAt: now,
    }
    const path = this.path(snapshot.document.id, input.episodeId, true)
    writeJsonFileAtomicSecure(path, { ...current.file, exportJobs: [...current.file.exportJobs, job] }, { expectedDestination: { kind: 'state', state: current.state } })
    /** 终态更新读取最新剪辑文件，保留期间其他会话的修改。 */
    const finish = (result: VisualEditingExportJob): VisualEditingExportJob => {
      const latest = this.read(snapshot.document.id, input.episodeId)
      if (!latest) throw new Error('影像剪辑文件不存在')
      writeJsonFileAtomicSecure(path, { ...latest.file, exportJobs: latest.file.exportJobs.map(item => item.id === job.id ? result : item) }, { expectedDestination: { kind: 'state', state: latest.state } })
      return result
    }
    try {
      if (!this.dependencies.renderExport || !this.dependencies.saveExportArtifact) throw new Error('原生审片编码器或媒体登记不可用')
      const rendered = await this.dependencies.renderExport({ productionId: input.productionId, episodeId: input.episodeId, timeline, settings, sourceMedia: structuredClone(sourceMedia), readMedia: mediaId => {
        if (!sourceIds.has(mediaId)) throw new Error('媒体不属于冻结预览范围')
        const content = this.mediaContent(snapshot, mediaId)
        if (createHash('sha256').update(content.bytes).digest('hex') !== sourceMedia.find(media => media.id === mediaId)?.hash) throw new Error('预览来源媒体 hash 不匹配')
        return content
      } })
      const artifact = rendered.artifactMedia
      if (artifact.kind !== 'video' || artifact.mime !== 'video/mp4' || artifact.id !== artifact.hash
        || rendered.artifactBytes.length !== artifact.byteSize || artifact.byteSize > VISUAL_PRODUCTION_LIMITS.mediaBytes
        || createHash('sha256').update(rendered.artifactBytes).digest('hex') !== artifact.hash) throw new Error('预览编码器返回的媒体身份或 hash 无效')
      this.dependencies.assertCurrent?.()
      /** 只向最新快照追加真实产物，不用编码前的旧快照覆盖期间的正式编辑。 */
      const latestSnapshot = this.dependencies.getCurrentSnapshot?.(snapshot.document.id) ?? snapshot
      this.dependencies.saveExportArtifact(latestSnapshot, { ...artifact, name: `待审预览-${job.id}.mp4` }, rendered.artifactBytes)
      return finish({ ...job, status: 'completed', encoderId: rendered.encoderId, artifactMediaId: artifact.id, artifactHash: artifact.hash, message: '待审声画预览已生成；可能包含静帧和待听验声音，不代表正式采用或审核通过。', updatedAt: Date.now() })
    } catch (cause) {
      return finish({ ...job, status: 'failed', message: `待审预览失败：${cause instanceof Error ? cause.message : '编码器返回未知错误'}`, updatedAt: Date.now() })
    }
  }

  /** 创建冻结当前时间线和媒体 hash 的成片任务；缺编码器时持久化失败状态。 */
  async requestExport(snapshot: VisualProductionSnapshot, episodeId: string, expectedTimelineRevision: number, settings: VisualEditingExportSettings): Promise<VisualEditingExportJob> {
    this.dependencies.assertCurrent?.()
    this.episode(snapshot, episodeId)
    const stored = this.read(snapshot.document.id, episodeId)
    if (!stored || stored.file.timeline.revision !== expectedTimelineRevision) throw new Error('VISUAL_EDITING_CONFLICT: 时间线已变化或尚未建立')
    const parsedSettings = parseVisualEditingExportSettings(settings)
    const sourceHashes = [...new Set(stored.file.timeline.tracks.flatMap(track => track.clips.flatMap(clip => clip.source ? [clip.source.mediaHash] : [])))].sort()
    const now = Date.now()
    const job: VisualEditingExportJob = { id: randomUUID(), productionId: snapshot.document.id, episodeId, timelineRevision: expectedTimelineRevision, sourceHashes, settings: parsedSettings, status: 'queued', createdAt: now, updatedAt: now }
    const path = this.path(snapshot.document.id, episodeId, true)
    writeJsonFileAtomicSecure(path, { ...stored.file, exportJobs: [...stored.file.exportJobs, job] }, { expectedDestination: { kind: 'state', state: stored.state } })
    if (!this.dependencies.renderExport) {
      const failed: VisualEditingExportJob = { ...job, status: 'failed', message: '成片编码器不可用，未生成视频文件。请先配置 FFmpeg。', updatedAt: Date.now() }
      const current = this.read(snapshot.document.id, episodeId)
      if (!current) throw new Error('影像剪辑文件不存在')
      writeJsonFileAtomicSecure(path, { ...current.file, exportJobs: current.file.exportJobs.map(item => item.id === job.id ? failed : item) }, { expectedDestination: { kind: 'state', state: current.state } })
      return failed
    }
    try {
      const rendered = await this.dependencies.renderExport({ productionId: snapshot.document.id, episodeId, timeline: structuredClone(stored.file.timeline), settings: parsedSettings, sourceMedia: structuredClone(snapshot.media), readMedia: (mediaId) => this.mediaContent(snapshot, mediaId) })
      if (rendered.artifactMedia.kind !== 'video' || rendered.artifactMedia.mime !== 'video/mp4' || rendered.artifactMedia.id !== rendered.artifactMedia.hash) throw new Error('编码器返回的媒体身份无效')
      this.dependencies.saveExportArtifact?.(snapshot, rendered.artifactMedia, rendered.artifactBytes)
      const completed: VisualEditingExportJob = { ...job, status: 'completed', encoderId: rendered.encoderId, artifactMediaId: rendered.artifactMedia.id, artifactHash: rendered.artifactMedia.hash, message: '成片已生成。', updatedAt: Date.now() }
      const current = this.read(snapshot.document.id, episodeId)
      if (!current) throw new Error('影像剪辑文件不存在')
      writeJsonFileAtomicSecure(path, { ...current.file, exportJobs: current.file.exportJobs.map(item => item.id === job.id ? completed : item) }, { expectedDestination: { kind: 'state', state: current.state } })
      return completed
    } catch (cause) {
      const failed: VisualEditingExportJob = { ...job, status: 'failed', message: `成片导出失败：${cause instanceof Error ? cause.message : '编码器返回未知错误'}`, updatedAt: Date.now() }
      const current = this.read(snapshot.document.id, episodeId)
      if (!current) throw new Error('影像剪辑文件不存在')
      writeJsonFileAtomicSecure(path, { ...current.file, exportJobs: current.file.exportJobs.map(item => item.id === job.id ? failed : item) }, { expectedDestination: { kind: 'state', state: current.state } })
      return failed
    }
  }

  /** 读取当前集的导出任务列表，正文不包含媒体字节。 */
  listExportJobs(snapshot: VisualProductionSnapshot, episodeId: string): VisualEditingExportJob[] {
    return this.load(snapshot, episodeId).exportJobs
  }

  /** 取消仍处于排队或准备阶段的导出任务。 */
  cancelExport(snapshot: VisualProductionSnapshot, episodeId: string, exportJobId: string): VisualEditingExportJob {
    this.dependencies.assertCurrent?.()
    this.episode(snapshot, episodeId)
    const stored = this.read(snapshot.document.id, episodeId)
    const job = stored?.file.exportJobs.find(item => item.id === exportJobId)
    if (!stored || !job) throw new Error('导出任务不存在')
    if (job.status !== 'queued' && job.status !== 'preparing') throw new Error('当前导出任务不能取消')
    const cancelled: VisualEditingExportJob = { ...job, status: 'cancelled', message: '已取消成片导出。', updatedAt: Date.now() }
    writeJsonFileAtomicSecure(this.path(snapshot.document.id, episodeId, true), { ...stored.file, exportJobs: stored.file.exportJobs.map(item => item.id === exportJobId ? cancelled : item) }, { expectedDestination: { kind: 'state', state: stored.state } })
    return cancelled
  }

  /** 从时间线媒体片段读取已校验的不可变副本。 */
  private mediaContent(snapshot: VisualProductionSnapshot, id: string): { mediaId: string; bytes: Uint8Array; mime: string } {
    const media = snapshot.media.find(item => item.id === id)
    if (!media) throw new Error('媒体不属于当前作品')
    if (!Number.isSafeInteger(media.byteSize) || media.byteSize <= 0 || media.byteSize > VISUAL_PRODUCTION_LIMITS.mediaBytes) throw new Error('媒体原字节超过读取预算')
    const directory = interactionDirectory(this.dependencies.projectRoot, [...VISUAL_PRODUCTION_STORAGE_SEGMENTS, 'projects', snapshot.document.id, 'media'])
    /** JSON 外壳按原媒体预算容纳 base64 膨胀，不把编码后的大小当原媒体大小。 */
    const encodedBudget = Math.ceil(VISUAL_PRODUCTION_LIMITS.mediaBytes / 3) * 4
    const stored = JSON.parse(readInteractionFile(join(directory, `${media.hash}.json`), encodedBudget + 1024).toString()) as { hash: string; data: string }
    if (typeof stored.data !== 'string' || stored.data.length > encodedBudget) throw new Error('媒体编码超过读取预算')
    const bytes = Buffer.from(stored.data, 'base64')
    if (stored.hash !== media.hash || bytes.length !== media.byteSize) throw new Error('媒体副本损坏')
    return { mediaId: id, bytes, mime: media.mime }
  }
}
