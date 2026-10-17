import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { parseVisualEditingDocument } from '@dutydeck/shared'
import type { VisualEditingClip, VisualEditingDocument, VisualEditingTimelineSnapshot, VisualProductionSnapshot } from '@dutydeck/shared'
import { readAtomicFileState, writeJsonFileAtomicSecure } from '../safe-file'
import type { AtomicFileState } from '../safe-file'
import { interactionDirectory, readInteractionFile } from '../interaction-design/paths'

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
}

/** 每集一条独立时间线，原子保存且不把媒体字节写入剪辑文件。 */
export class VisualEditingStore {
  constructor(private readonly dependencies: VisualEditingStoreDependencies) {}

  /** 返回作品剪辑目录；路径段来自已解析的影像身份。 */
  private directory(productionId: string, create = false): string {
    return interactionDirectory(this.dependencies.projectRoot, ['.proma', 'visual-production', 'projects', productionId, 'editing'], create)
  }

  /** 返回指定集的 JSON 文件路径。 */
  private path(productionId: string, episodeId: string, create = false): string {
    return join(this.directory(productionId, create), `${episodeId}.json`)
  }

  /** 读取文件并验证持久化外壳，损坏内容不能静默当成空剪辑。 */
  private read(productionId: string, episodeId: string): { file: VisualEditingFile; state: AtomicFileState } | null {
    const directory = join(this.dependencies.projectRoot, '.proma', 'visual-production', 'projects', productionId, 'editing')
    if (!existsSync(directory)) return null
    const path = this.path(productionId, episodeId)
    const state = readAtomicFileState(path)
    if (!state) return null
    const file = JSON.parse(readInteractionFile(path, 8 * 1024 * 1024).toString()) as VisualEditingFile
    if (!file || file.schemaVersion !== 1 || !file.timeline || file.timeline.productionId !== productionId || file.timeline.episodeId !== episodeId || !Array.isArray(file.candidates) || !Array.isArray(file.exportJobs)) throw new Error('影像剪辑文件损坏')
    return { file: { schemaVersion: 1, timeline: parseVisualEditingDocument(file.timeline), candidates: file.candidates, exportJobs: file.exportJobs }, state }
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
        const currentShot = shot ? snapshot.shotStates[shot.id] : undefined
        if (!shot || !currentMedia || shot.mediaId !== source.mediaId || currentMedia.hash !== source.mediaHash || currentShot?.outputVersion !== source.shotOutputVersion) result.push(clip.id)
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
    return { timeline: structuredClone(stored.file.timeline), needsReplacementClipIds: this.replacementIds(snapshot, stored.file.timeline), candidates: structuredClone(stored.file.candidates), exportJobs: structuredClone(stored.file.exportJobs) }
  }

  /** 按当前集的分镜顺序创建初始视频轨，未采用镜头不伪造片段。 */
  createRoughCut(snapshot: VisualProductionSnapshot, episodeId: string): VisualEditingTimelineSnapshot {
    this.dependencies.assertCurrent?.()
    this.episode(snapshot, episodeId)
    if (this.read(snapshot.document.id, episodeId)) throw new Error('当前集已经存在剪辑时间线')
    const now = Date.now()
    let cursor = 0
    const clips: VisualEditingClip[] = []
    for (const shot of snapshot.document.shots.filter(item => item.episodeId === episodeId)) {
      if (!shot.mediaId) continue
      const media = snapshot.media.find(item => item.id === shot.mediaId)
      if (!media || (media.kind !== 'image' && media.kind !== 'video')) continue
      const duration = Math.max(shot.duration, 0.1)
      const outputVersion = snapshot.shotStates[shot.id]?.outputVersion ?? 0
      clips.push({ id: randomUUID(), source: { type: 'shot-media', shotId: shot.id, mediaId: media.id, mediaHash: media.hash, shotOutputVersion: outputVersion }, start: cursor, duration, sourceIn: 0, sourceOut: duration, label: shot.title, ...((media.kind === 'image' || media.kind === 'video') ? {} : {}) })
      cursor += duration
    }
    if (!clips.length) throw new Error('当前集没有可剪辑的已采用镜头')
    const timeline: VisualEditingDocument = { schemaVersion: 1, id: randomUUID(), productionId: snapshot.document.id, episodeId, revision: 1, baseProductionRevision: snapshot.document.revision, tracks: [{ id: 'video', kind: 'video', clips }], duration: cursor, createdAt: now, updatedAt: now }
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
}
