import type { VisualMedia } from './visual-production'

/** 剪辑轨道的固定业务类型；首版不支持任意新增轨道。 */
export type VisualEditingTrackKind = 'video' | 'voice' | 'music' | 'caption'

/** 时间线片段只能引用影像作品内已经登记的不可变媒体副本。 */
export interface VisualEditingClipSource {
  /** 当前只允许引用镜头正式输出。 */
  type: 'shot-media'
  /** 来源镜头身份。 */
  shotId: string
  /** 来源媒体身份，与作品媒体索引一致。 */
  mediaId: string
  /** 建立片段时冻结的媒体 hash。 */
  mediaHash: string
  /** 建立片段时冻结的镜头输出版本。 */
  shotOutputVersion: number
}

/** 时间线上的一个可移动、可裁切片段。 */
export interface VisualEditingClip {
  /** 时间线片段身份，不复用镜头身份。 */
  id: string
  /** 画面、旁白和音乐片段有来源；字幕片段没有来源。 */
  source?: VisualEditingClipSource
  /** 在所属轨道上的开始时间，单位为秒。 */
  start: number
  /** 片段持续时间，单位为秒。 */
  duration: number
  /** 对源媒体的入点，单位为秒。 */
  sourceIn: number
  /** 对源媒体的出点，单位为秒。 */
  sourceOut: number
  /** 用户可读片段名称。 */
  label: string
  /** 旁白和音乐的线性音量，范围 0 到 1。 */
  volume?: number
  /** 字幕轨道的文字内容。 */
  caption?: { text: string }
}

/** 一条轨道及其按时间排序的片段。 */
export interface VisualEditingTrack {
  /** 轨道稳定身份。 */
  id: string
  /** 轨道用途。 */
  kind: VisualEditingTrackKind
  /** 轨道片段。 */
  clips: VisualEditingClip[]
}

/** 按集保存的剪辑时间线正式文档。 */
export interface VisualEditingDocument {
  /** 持久化格式版本。 */
  schemaVersion: 1
  /** 时间线稳定身份。 */
  id: string
  /** 所属影像作品。 */
  productionId: string
  /** 所属集数。 */
  episodeId: string
  /** 时间线单调版本。 */
  revision: number
  /** 建立或粗剪时使用的作品正式版本。 */
  baseProductionRevision: number
  /** 四类轨道。 */
  tracks: VisualEditingTrack[]
  /** 时间线总时长，单位为秒。 */
  duration: number
  /** 创建时间，毫秒。 */
  createdAt: number
  /** 保存时间，毫秒。 */
  updatedAt: number
}

/** 加载时计算的来源失效提示，不写回时间线正文。 */
export interface VisualEditingTimelineSnapshot {
  /** 当前集的正式时间线；尚未粗剪时为空。 */
  timeline: VisualEditingDocument | null
  /** 源镜头有新输出或媒体 hash 变化的片段身份。 */
  needsReplacementClipIds: string[]
  /** 当前时间线候选。 */
  candidates: VisualEditingTimelineCandidate[]
  /** 当前集的导出任务。 */
  exportJobs: VisualEditingExportJob[]
}

/** Agent 提交的结构化时间线候选。 */
export interface VisualEditingTimelineCandidate {
  /** 候选身份。 */
  id: string
  /** 候选基于的时间线版本。 */
  baseRevision: number
  /** 候选后的完整时间线。 */
  timeline: VisualEditingDocument
  /** 便于 UI 和 Agent 理解的操作摘要。 */
  operations: VisualEditingOperation[]
  /** 用户可读变更说明。 */
  summary: string
  /** 候选生命周期。 */
  status: 'ready' | 'adopted' | 'discarded' | 'stale'
  /** 创建候选的会话。 */
  sessionId: string
  /** 创建时间，毫秒。 */
  createdAt: number
}

/** Agent 可提出的有限编辑操作。 */
export type VisualEditingOperation =
  | { type: 'replaceClipSource'; trackId: string; clipId: string; source: VisualEditingClipSource }
  | { type: 'insertAudioClip'; trackId: string; kind: 'voice' | 'music'; clipId?: string; source: VisualEditingClipSource; start: number; sourceIn: number; sourceOut: number; volume?: number; label: string }
  | { type: 'moveClip'; trackId: string; clipId: string; toIndex: number }
  | { type: 'splitClip'; trackId: string; clipId: string; at: number }
  | { type: 'trimClip'; trackId: string; clipId: string; sourceIn: number; sourceOut: number }
  | { type: 'setVolume'; trackId: string; clipId: string; volume: number }
  | { type: 'setCaption'; trackId: string; clipId?: string; text: string; start: number; duration: number }
  | { type: 'removeClip'; trackId: string; clipId: string }

/** 导出时可由用户选择的有限设置。 */
export interface VisualEditingExportSettings {
  /** 输出比例沿用作品比例。 */
  ratio: string
  /** 输出帧率。 */
  fps: number
  /** 是否包含旁白轨。 */
  includeVoice: boolean
  /** 是否包含音乐轨。 */
  includeMusic: boolean
  /** 是否烧录字幕轨。 */
  includeCaptions: boolean
}

/** 独立的成片导出任务。 */
export interface VisualEditingExportJob {
  /** 存在时为未采用候选的本机审片任务；不能视为正式成片或采用证明。 */
  preview?: { productionRevision: number; candidateIds: string[]; range: { start: number; end: number } }
  /** 任务身份。 */
  id: string
  /** 所属影像作品。 */
  productionId: string
  /** 所属集数。 */
  episodeId: string
  /** 冻结的时间线版本。 */
  timelineRevision: number
  /** 冻结的来源媒体 hash。 */
  sourceHashes: string[]
  /** 冻结的导出设置。 */
  settings: VisualEditingExportSettings
  /** 导出生命周期。 */
  status: 'queued' | 'preparing' | 'rendering' | 'completed' | 'failed' | 'cancelled'
  /** 主进程编码器身份。 */
  encoderId?: string
  /** 已完成的输出媒体身份。 */
  artifactMediaId?: string
  /** 已完成输出的 hash。 */
  artifactHash?: string
  /** 用户可读错误或状态说明。 */
  message?: string
  /** 创建时间，毫秒。 */
  createdAt: number
  /** 更新时间，毫秒。 */
  updatedAt: number
}

/** 时间线合同使用的有界预算。 */
export const VISUAL_EDITING_LIMITS = {
  tracks: 4,
  clipsPerTrack: 1000,
  candidates: 32,
  operations: 100,
  maxDuration: 86400,
  maxCaptionLength: 4000,
} as const

/** 供时间线与 IPC 解析器复用的身份校验。 */
function assertId(value: unknown, field: string): asserts value is string {
  if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(value) || ['__proto__', 'constructor', 'prototype'].includes(value)) throw new Error(`VISUAL_EDITING_INVALID: ${field}`)
}

/** 解析有界非空文本。 */
function text(value: unknown, field: string, max: number, allowEmpty = false): string {
  if (typeof value !== 'string' || value.length > max || value.includes('\0') || (!allowEmpty && !value.trim())) throw new Error(`VISUAL_EDITING_INVALID: ${field}`)
  return value
}

/** 解析有限数字。 */
function finiteNumber(value: unknown, field: string, minimum = 0, maximum = Number.MAX_SAFE_INTEGER): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < minimum || value > maximum) throw new Error(`VISUAL_EDITING_INVALID: ${field}`)
  return value
}

/** 解析正整数身份版本。 */
function revision(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) throw new Error(`VISUAL_EDITING_INVALID: ${field}`)
  return value
}

/** 解析普通对象并拒绝隐藏字段。 */
function plainObject(value: unknown, keys: readonly string[], field: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) throw new Error(`VISUAL_EDITING_INVALID: ${field}`)
  const result = value as Record<string, unknown>
  if (Object.keys(result).some(key => !keys.includes(key))) throw new Error(`VISUAL_EDITING_INVALID: ${field}`)
  return result
}

/** 解析媒体来源 hash。 */
function mediaHash(value: unknown): string {
  const result = text(value, '媒体 hash', 64)
  if (!/^[a-f0-9]{64}$/.test(result)) throw new Error('VISUAL_EDITING_INVALID: 媒体 hash')
  return result
}

/** 解析字幕正文。 */
function caption(value: unknown): { text: string } {
  const data = plainObject(value, ['text'], '字幕')
  return { text: text(data.text, '字幕正文', VISUAL_EDITING_LIMITS.maxCaptionLength, true) }
}

/** 解析片段来源。 */
function clipSource(value: unknown): VisualEditingClipSource {
  const data = plainObject(value, ['type', 'shotId', 'mediaId', 'mediaHash', 'shotOutputVersion'], '片段来源')
  if (data.type !== 'shot-media') throw new Error('VISUAL_EDITING_INVALID: 片段来源类型')
  assertId(data.shotId, '来源镜头身份')
  assertId(data.mediaId, '来源媒体身份')
  return { type: 'shot-media', shotId: data.shotId, mediaId: data.mediaId, mediaHash: mediaHash(data.mediaHash), shotOutputVersion: finiteNumber(data.shotOutputVersion, '镜头输出版本', 0, Number.MAX_SAFE_INTEGER) }
}

/** 解析单个时间线片段并检查来源字段与轨道类型的关系。 */
function clip(value: unknown, kind: VisualEditingTrackKind): VisualEditingClip {
  const data = plainObject(value, ['id', 'source', 'start', 'duration', 'sourceIn', 'sourceOut', 'label', 'volume', 'caption'], '片段')
  assertId(data.id, '片段身份')
  const result: VisualEditingClip = {
    id: data.id,
    start: finiteNumber(data.start, '片段开始时间', 0, VISUAL_EDITING_LIMITS.maxDuration),
    duration: finiteNumber(data.duration, '片段时长', 0.01, VISUAL_EDITING_LIMITS.maxDuration),
    sourceIn: finiteNumber(data.sourceIn, '源入点', 0, VISUAL_EDITING_LIMITS.maxDuration),
    sourceOut: finiteNumber(data.sourceOut, '源出点', 0, VISUAL_EDITING_LIMITS.maxDuration),
    label: text(data.label, '片段名称', 200, true),
  }
  if (result.sourceOut <= result.sourceIn || result.sourceOut - result.sourceIn + 0.0001 < result.duration) throw new Error('VISUAL_EDITING_INVALID: 片段源范围')
  if (kind === 'caption') {
    if (data.source !== undefined || data.volume !== undefined || data.caption === undefined) throw new Error('VISUAL_EDITING_INVALID: 字幕片段字段')
    result.caption = caption(data.caption)
  } else {
    if (data.source === undefined || data.caption !== undefined) throw new Error('VISUAL_EDITING_INVALID: 媒体片段字段')
    result.source = clipSource(data.source)
    if (kind === 'video' && data.volume !== undefined) throw new Error('VISUAL_EDITING_INVALID: 画面片段音量')
    if ((kind === 'voice' || kind === 'music') && data.volume !== undefined) result.volume = finiteNumber(data.volume, '片段音量', 0, 1)
  }
  return result
}

/** 解析轨道并保证片段身份、时间范围和轨道用途一致。 */
function track(value: unknown): VisualEditingTrack {
  const data = plainObject(value, ['id', 'kind', 'clips'], '轨道')
  assertId(data.id, '轨道身份')
  if (!['video', 'voice', 'music', 'caption'].includes(String(data.kind))) throw new Error('VISUAL_EDITING_INVALID: 轨道类型')
  const kind = data.kind as VisualEditingTrackKind
  if (!Array.isArray(data.clips) || data.clips.length > VISUAL_EDITING_LIMITS.clipsPerTrack) throw new Error('VISUAL_EDITING_INVALID: 片段数量')
  const clips = data.clips.map(item => clip(item, kind))
  const ids = new Set<string>()
  for (const item of clips) {
    if (ids.has(item.id)) throw new Error('VISUAL_EDITING_INVALID: 片段身份重复')
    ids.add(item.id)
    if (item.start + item.duration > VISUAL_EDITING_LIMITS.maxDuration) throw new Error('VISUAL_EDITING_INVALID: 时间线范围')
  }
  const ordered = [...clips].sort((left, right) => left.start - right.start)
  for (let index = 1; index < ordered.length; index += 1) {
    const previous = ordered[index - 1]!
    const current = ordered[index]!
    if (previous.start + previous.duration > current.start + 0.0001) throw new Error('VISUAL_EDITING_INVALID: 时间线片段重叠')
  }
  return { id: data.id, kind, clips }
}

/** 解析完整时间线；这是文件、IPC 和 Agent 共用的唯一入口。 */
export function parseVisualEditingDocument(value: unknown): VisualEditingDocument {
  const data = plainObject(value, ['schemaVersion', 'id', 'productionId', 'episodeId', 'revision', 'baseProductionRevision', 'tracks', 'duration', 'createdAt', 'updatedAt'], '时间线')
  if (data.schemaVersion !== 1) throw new Error('VISUAL_EDITING_INVALID: 时间线格式版本')
  assertId(data.id, '时间线身份'); assertId(data.productionId, '作品身份'); assertId(data.episodeId, '集数身份')
  const timelineRevision = revision(data.revision, '时间线版本')
  const baseProductionRevision = revision(data.baseProductionRevision, '作品版本')
  const duration = finiteNumber(data.duration, '时间线时长', 0, VISUAL_EDITING_LIMITS.maxDuration)
  const createdAt = finiteNumber(data.createdAt, '创建时间', 0, Number.MAX_SAFE_INTEGER)
  const updatedAt = finiteNumber(data.updatedAt, '更新时间', createdAt, Number.MAX_SAFE_INTEGER)
  if (!Array.isArray(data.tracks) || data.tracks.length > VISUAL_EDITING_LIMITS.tracks) throw new Error('VISUAL_EDITING_INVALID: 轨道数量')
  const tracks = data.tracks.map(track)
  const trackIds = new Set<string>()
  const kinds = new Set<VisualEditingTrackKind>()
  let maxEnd = 0
  for (const item of tracks) {
    if (trackIds.has(item.id) || kinds.has(item.kind)) throw new Error('VISUAL_EDITING_INVALID: 轨道身份或类型重复')
    trackIds.add(item.id); kinds.add(item.kind)
    for (const clipItem of item.clips) maxEnd = Math.max(maxEnd, clipItem.start + clipItem.duration)
  }
  if (maxEnd > duration + 0.0001) throw new Error('VISUAL_EDITING_INVALID: 时间线时长不足')
  return { schemaVersion: 1, id: data.id, productionId: data.productionId, episodeId: data.episodeId, revision: timelineRevision, baseProductionRevision, tracks, duration, createdAt, updatedAt }
}

/** 解析编辑操作；宿主在应用操作前还会核对目标片段和版本。 */
export function parseVisualEditingOperation(value: unknown): VisualEditingOperation {
  const data = plainObject(value, ['type', 'trackId', 'kind', 'clipId', 'toIndex', 'at', 'sourceIn', 'sourceOut', 'volume', 'text', 'start', 'duration', 'label', 'source'], '编辑操作')
  if (typeof data.type !== 'string') throw new Error('VISUAL_EDITING_INVALID: 编辑操作类型')
  assertId(data.trackId, '编辑轨道身份')
  if (data.type === 'replaceClipSource') { assertId(data.clipId, '编辑片段身份'); return { type: 'replaceClipSource', trackId: data.trackId, clipId: data.clipId, source: clipSource(data.source) } }
  if (data.type === 'insertAudioClip') {
    if (data.kind !== 'voice' && data.kind !== 'music') throw new Error('VISUAL_EDITING_INVALID: 音频轨道类型')
    if (data.clipId !== undefined) assertId(data.clipId, '编辑片段身份')
    /** 音频源裁切入出点，单位为秒；start 仍表示时间线绝对起点。 */
    const sourceIn = finiteNumber(data.sourceIn, '音频入点', 0, VISUAL_EDITING_LIMITS.maxDuration)
    const sourceOut = finiteNumber(data.sourceOut, '音频出点', 0, VISUAL_EDITING_LIMITS.maxDuration)
    if (sourceOut <= sourceIn) throw new Error('VISUAL_EDITING_INVALID: 音频范围')
    return { type: 'insertAudioClip', trackId: data.trackId, kind: data.kind, ...(data.clipId === undefined ? {} : { clipId: data.clipId }), source: clipSource(data.source), start: finiteNumber(data.start, '音频开始时间', 0, VISUAL_EDITING_LIMITS.maxDuration), sourceIn, sourceOut, ...(data.volume === undefined ? {} : { volume: finiteNumber(data.volume, '音量', 0, 1) }), label: text(data.label, '音频片段名称', 200, true) }
  }
  if (data.type === 'moveClip') { assertId(data.clipId, '编辑片段身份'); return { type: 'moveClip', trackId: data.trackId, clipId: data.clipId, toIndex: finiteNumber(data.toIndex, '目标顺序', 0, VISUAL_EDITING_LIMITS.clipsPerTrack) } }
  if (data.type === 'splitClip') { assertId(data.clipId, '编辑片段身份'); return { type: 'splitClip', trackId: data.trackId, clipId: data.clipId, at: finiteNumber(data.at, '分割位置', 0, VISUAL_EDITING_LIMITS.maxDuration) } }
  if (data.type === 'trimClip') { assertId(data.clipId, '编辑片段身份'); return { type: 'trimClip', trackId: data.trackId, clipId: data.clipId, sourceIn: finiteNumber(data.sourceIn, '裁切入点', 0, VISUAL_EDITING_LIMITS.maxDuration), sourceOut: finiteNumber(data.sourceOut, '裁切出点', 0, VISUAL_EDITING_LIMITS.maxDuration) } }
  if (data.type === 'setVolume') { assertId(data.clipId, '编辑片段身份'); return { type: 'setVolume', trackId: data.trackId, clipId: data.clipId, volume: finiteNumber(data.volume, '音量', 0, 1) } }
  if (data.type === 'setCaption') { if (data.clipId !== undefined) assertId(data.clipId, '编辑片段身份'); return { type: 'setCaption', trackId: data.trackId, ...(data.clipId === undefined ? {} : { clipId: data.clipId }), text: text(data.text, '字幕正文', VISUAL_EDITING_LIMITS.maxCaptionLength, true), start: finiteNumber(data.start, '字幕开始时间', 0, VISUAL_EDITING_LIMITS.maxDuration), duration: finiteNumber(data.duration, '字幕时长', 0.01, VISUAL_EDITING_LIMITS.maxDuration) } }
  if (data.type === 'removeClip') { assertId(data.clipId, '编辑片段身份'); return { type: 'removeClip', trackId: data.trackId, clipId: data.clipId } }
  throw new Error('VISUAL_EDITING_INVALID: 不支持的编辑操作')
}

/** 解析候选操作列表，限制一次 Agent 修改的工作量。 */
export function parseVisualEditingOperations(value: unknown): VisualEditingOperation[] {
  if (!Array.isArray(value) || value.length > VISUAL_EDITING_LIMITS.operations) throw new Error('VISUAL_EDITING_INVALID: 编辑操作数量')
  return value.map(parseVisualEditingOperation)
}

/** 重新计算线性轨道的开始时间，保持片段顺序与总时长一致。 */
function reflowTrack(track: VisualEditingTrack): void {
  if (track.kind === 'caption' || track.kind === 'voice' || track.kind === 'music') return
  let cursor = 0
  for (const clip of track.clips) { clip.start = cursor; cursor += clip.duration }
}

/** 在一条轨道中查找片段，返回可安全修改的索引。 */
function locateClip(document: VisualEditingDocument, trackId: string, clipId: string): { track: VisualEditingTrack; index: number } {
  const track = document.tracks.find(item => item.id === trackId)
  if (!track) throw new Error('VISUAL_EDITING_INVALID: 轨道不存在')
  const index = track.clips.findIndex(item => item.id === clipId)
  if (index < 0) throw new Error('VISUAL_EDITING_INVALID: 片段不存在')
  return { track, index }
}

/** 应用 Agent 或本地编辑器的有限操作，返回全新时间线，不修改输入对象。 */
export function applyVisualEditingOperations(document: VisualEditingDocument, operations: VisualEditingOperation[]): VisualEditingDocument {
  const next = structuredClone(document)
  for (const operation of operations) {
    if (operation.type === 'insertAudioClip') {
      if (operation.sourceOut <= operation.sourceIn) throw new Error('VISUAL_EDITING_INVALID: 音频范围')
      /** 音频片段使用绝对时间定位；同候选中应通过删除后重新插入改变位置。 */
      let track = next.tracks.find(item => item.id === operation.trackId)
      if (track && track.kind !== operation.kind) throw new Error('VISUAL_EDITING_INVALID: 音频轨道类型不匹配')
      if (!track) {
        track = { id: operation.trackId, kind: operation.kind, clips: [] }
        next.tracks.push(track)
      }
      /** 片段身份集合用于防止 Agent 显式传入重复 ID。 */
      const used = new Set(track.clips.map(clip => clip.id))
      /** 未指定身份时由宿主生成稳定且不冲突的候选 ID。 */
      let clipId = operation.clipId ?? `${operation.kind}-clip-${track.clips.length + 1}`
      while (used.has(clipId)) {
        if (operation.clipId) throw new Error('VISUAL_EDITING_INVALID: 音频片段身份重复')
        clipId = `${clipId}-next`
      }
      track.clips.push({ id: clipId, source: clipSource(operation.source), start: operation.start, duration: operation.sourceOut - operation.sourceIn, sourceIn: operation.sourceIn, sourceOut: operation.sourceOut, label: operation.label, ...(operation.volume === undefined ? {} : { volume: operation.volume }) })
      track.clips.sort((left, right) => left.start - right.start)
    } else if (operation.type === 'replaceClipSource') {
      /** 只替换同一镜头媒体绑定，保留既有剪点与片段身份。 */
      const located = locateClip(next, operation.trackId, operation.clipId)
      const clip = located.track.clips[located.index]!
      if (!clip.source || located.track.kind === 'caption' || clip.source.shotId !== operation.source.shotId) throw new Error('VISUAL_EDITING_INVALID: 替换来源必须属于原镜头')
      clip.source = clipSource(operation.source)
    } else if (operation.type === 'moveClip') {
      const located = locateClip(next, operation.trackId, operation.clipId)
      if (located.track.kind === 'voice' || located.track.kind === 'music') throw new Error('VISUAL_EDITING_INVALID: 音频片段不支持顺序移动，请使用删除后插入')
      const [clip] = located.track.clips.splice(located.index, 1)
      if (!clip) throw new Error('VISUAL_EDITING_INVALID: 片段不存在')
      located.track.clips.splice(Math.min(operation.toIndex, located.track.clips.length), 0, clip)
      reflowTrack(located.track)
    } else if (operation.type === 'splitClip') {
      const located = locateClip(next, operation.trackId, operation.clipId)
      const clip = located.track.clips[located.index]!
      if (located.track.kind === 'caption' || !clip.source || operation.at <= clip.sourceIn || operation.at >= clip.sourceOut) throw new Error('VISUAL_EDITING_INVALID: 分割位置')
      const leftDuration = operation.at - clip.sourceIn
      const rightDuration = clip.sourceOut - operation.at
      const left = { ...clip, id: `${clip.id}-a`, duration: leftDuration, sourceOut: operation.at }
      const right = { ...clip, id: `${clip.id}-b`, start: clip.start + leftDuration, duration: rightDuration, sourceIn: operation.at }
      located.track.clips.splice(located.index, 1, left, right)
      reflowTrack(located.track)
    } else if (operation.type === 'trimClip') {
      const located = locateClip(next, operation.trackId, operation.clipId)
      const clip = located.track.clips[located.index]!
      if (!clip.source || operation.sourceOut <= operation.sourceIn || operation.sourceIn < 0) throw new Error('VISUAL_EDITING_INVALID: 裁切范围')
      clip.sourceIn = operation.sourceIn
      clip.sourceOut = operation.sourceOut
      clip.duration = operation.sourceOut - operation.sourceIn
      reflowTrack(located.track)
    } else if (operation.type === 'setVolume') {
      const located = locateClip(next, operation.trackId, operation.clipId)
      if (located.track.kind !== 'voice' && located.track.kind !== 'music') throw new Error('VISUAL_EDITING_INVALID: 音量轨道')
      located.track.clips[located.index]!.volume = operation.volume
    } else if (operation.type === 'setCaption') {
      const track = next.tracks.find(item => item.id === operation.trackId)
      if (!track || track.kind !== 'caption') throw new Error('VISUAL_EDITING_INVALID: 字幕轨道')
      if (operation.clipId) {
        const index = track.clips.findIndex(item => item.id === operation.clipId)
        if (index < 0) throw new Error('VISUAL_EDITING_INVALID: 字幕片段不存在')
        const clip = track.clips[index]!
        clip.start = operation.start; clip.duration = operation.duration; clip.sourceIn = 0; clip.sourceOut = operation.duration; clip.label = operation.text.slice(0, 80); clip.caption = { text: operation.text }
      } else {
        const used = new Set(track.clips.map(item => item.id))
        let id = `caption-${track.clips.length + 1}`
        while (used.has(id)) id = `${id}-next`
        track.clips.push({ id, start: operation.start, duration: operation.duration, sourceIn: 0, sourceOut: operation.duration, label: operation.text.slice(0, 80), caption: { text: operation.text } })
      }
    } else if (operation.type === 'removeClip') {
      const located = locateClip(next, operation.trackId, operation.clipId)
      located.track.clips.splice(located.index, 1)
      reflowTrack(located.track)
    }
  }
  const maxEnd = Math.max(0, ...next.tracks.flatMap(track => track.clips.map(clip => clip.start + clip.duration)))
  next.duration = maxEnd
  next.updatedAt = Date.now()
  return parseVisualEditingDocument(next)
}

/** 解析成片导出设置。 */
export function parseVisualEditingExportSettings(value: unknown): VisualEditingExportSettings {
  const data = plainObject(value, ['ratio', 'fps', 'includeVoice', 'includeMusic', 'includeCaptions'], '导出设置')
  if (typeof data.ratio !== 'string' || data.ratio.length > 16 || !/^\d+:\d+$/.test(data.ratio)) throw new Error('VISUAL_EDITING_INVALID: 输出比例')
  if (![24, 25, 30, 50, 60].includes(data.fps as number)) throw new Error('VISUAL_EDITING_INVALID: 输出帧率')
  if (typeof data.includeVoice !== 'boolean' || typeof data.includeMusic !== 'boolean' || typeof data.includeCaptions !== 'boolean') throw new Error('VISUAL_EDITING_INVALID: 导出轨道设置')
  return { ratio: data.ratio, fps: data.fps as number, includeVoice: data.includeVoice, includeMusic: data.includeMusic, includeCaptions: data.includeCaptions }
}

/** 判断媒体对象是否属于片段允许的媒体类别。 */
export function visualEditingMediaKindForTrack(trackKind: VisualEditingTrackKind): VisualMedia['kind'] | null {
  if (trackKind === 'video') return 'video'
  if (trackKind === 'voice' || trackKind === 'music') return 'audio'
  return null
}
