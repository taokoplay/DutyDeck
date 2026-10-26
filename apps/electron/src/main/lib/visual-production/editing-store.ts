import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { resolveVisualShotOutputs, applyVisualEditingOperations, parseVisualEditingDocument, parseVisualEditingExportSettings, parseVisualEditingOperations, VISUAL_PRODUCTION_STORAGE_SEGMENTS } from '@dutydeck/shared'
import type { VisualEditingClip, VisualEditingDocument, VisualEditingExportJob, VisualEditingExportSettings, VisualEditingOperation, VisualEditingTimelineCandidate, VisualEditingTimelineSnapshot, VisualProductionSnapshot, VisualMedia } from '@dutydeck/shared'
import { readAtomicFileState, writeJsonFileAtomicSecure } from '../safe-file'
import type { AtomicFileState } from '../safe-file'
import { interactionDirectory, readInteractionFile } from '../interaction-design/paths'
import { resolveProjectStorageDirectory } from '../project-storage/project-storage-paths'

/** 每集剪辑文件的持久化外壳，为后续候选和导出任务预留稳定边界。 */
interface VisualEditingFile {
  schemaVersion: 1
  timeline: VisualEditingDocument
  candidates: VisualEditingTimelineSnapshot['candidates']
  exportJobs: VisualEditingTimelineSnapshot['exportJobs']
}

/** 剪辑时间线存储依赖的作品快照读取能力。 */
export interface VisualEditingStoreDependencies {
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
  propose(snapshot: VisualProductionSnapshot, episodeId: string, expectedRevision: number, operations: VisualEditingOperation[], summary: string, sessionId: string): VisualEditingTimelineCandidate {
    this.dependencies.assertCurrent?.()
    this.episode(snapshot, episodeId)
    const stored = this.read(snapshot.document.id, episodeId)
    if (!stored || stored.file.timeline.revision !== expectedRevision) throw new Error('VISUAL_EDITING_CONFLICT: 时间线已变化或尚未建立')
    const candidateTimeline = applyVisualEditingOperations(stored.file.timeline, operations)
    this.references(snapshot, candidateTimeline)
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
  adopt(snapshot: VisualProductionSnapshot, episodeId: string, candidateId: string, expectedRevision: number): VisualEditingTimelineSnapshot {
    this.dependencies.assertCurrent?.()
    const stored = this.read(snapshot.document.id, episodeId)
    const candidate = stored?.file.candidates.find(item => item.id === candidateId)
    if (!stored || stored.file.timeline.revision !== expectedRevision || !candidate || candidate.status !== 'ready' || candidate.baseRevision !== expectedRevision) throw new Error('候选已过期或不可采纳')
    const timeline = { ...candidate.timeline, revision: expectedRevision + 1, updatedAt: Date.now() }
    this.references(snapshot, timeline)
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
    const directory = interactionDirectory(this.dependencies.projectRoot, [...VISUAL_PRODUCTION_STORAGE_SEGMENTS, 'projects', snapshot.document.id, 'media'])
    const stored = JSON.parse(readInteractionFile(join(directory, `${media.hash}.json`), 32 * 1024 * 1024).toString()) as { hash: string; data: string }
    const bytes = Buffer.from(stored.data, 'base64')
    if (stored.hash !== media.hash || bytes.length !== media.byteSize) throw new Error('媒体副本损坏')
    return { mediaId: id, bytes, mime: media.mime }
  }
}
