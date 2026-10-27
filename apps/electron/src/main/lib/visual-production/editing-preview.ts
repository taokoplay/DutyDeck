import { parseVisualEditingDocument, resolveVisualShotOutputs } from '@dutydeck/shared'
import type { VisualEditingDocument, VisualMedia, VisualProductionInputs, VisualProductionSnapshot } from '@dutydeck/shared'

/** 待审来源绑定候选、镜头与独立输出槽，不能写入正式时间线。 */
export interface VisualPreviewOutput {
  candidateId: string
  shotId: string
  media: VisualMedia
  outputVersion: number
}

/** 选择当前会话、当前集及当前版本的候选输出；审核失败仍可审片，不意味着可采用。 */
export function selectVisualPreviewOutputs(snapshot: VisualProductionSnapshot, timeline: VisualEditingDocument, input: VisualProductionInputs['requestPreview']): VisualPreviewOutput[] {
  if (snapshot.document.id !== input.productionId || snapshot.document.revision !== input.baseRevision
    || timeline.productionId !== input.productionId || timeline.episodeId !== input.episodeId || timeline.revision !== input.expectedTimelineRevision) throw new Error('VISUAL_EDITING_CONFLICT: 预览作品或时间线版本已变化')
  if (!Number.isFinite(input.range.start) || !Number.isFinite(input.range.end) || input.range.start < 0 || input.range.end <= input.range.start
    || input.range.end > timeline.duration || input.range.end - input.range.start > 60) throw new Error('预览范围须在时间线内且不超过60秒')
  if (input.candidateIds.length < 1 || input.candidateIds.length > 8 || new Set(input.candidateIds).size !== input.candidateIds.length) throw new Error('预览必须指定1至8个不同候选')
  /** 每个画面或声音位置只允许一个明确候选，避免顺序决定结果。 */
  const occupied = new Set<string>()
  const selected: VisualPreviewOutput[] = []
  const mediaById = new Map(snapshot.media.map(media => [media.id, media]))
  for (const candidateId of input.candidateIds) {
    const candidate = snapshot.candidates.find(item => item.id === candidateId)
    const job = snapshot.jobs.find(item => item.id === candidate?.jobId)
    const shot = snapshot.document.shots.find(item => item.id === job?.shotId)
    const draftShot = candidate?.draft.shots.find(item => item.id === shot?.id)
    if (!candidate || candidate.status !== 'ready' || candidate.baseRevision !== input.baseRevision
      || !job || job.sessionId !== input.sessionId || job.status !== 'candidate'
      || !shot || shot.episodeId !== input.episodeId || !draftShot || draftShot.episodeId !== input.episodeId) throw new Error('预览候选已过期、跨会话或不属于当前集的镜头')
    const before = resolveVisualShotOutputs(shot, mediaById)
    const after = resolveVisualShotOutputs(draftShot, mediaById)
    let changes = 0
    for (const kind of ['image', 'video', 'audio'] as const) {
      if (before[kind] === after[kind]) continue
      const media = mediaById.get(after[kind] ?? '')
      if (!media || media.kind !== kind) throw new Error('预览候选输出缺少有效的已登记媒体')
      if (kind === 'audio' && !input.settings.includeVoice) throw new Error('预览声音候选必须启用独立语音轨')
      const slot = `${shot.id}:${kind === 'audio' ? 'audio' : 'picture'}`
      if (occupied.has(slot)) throw new Error('同一镜头预览位置存在多个候选，请明确选择')
      occupied.add(slot)
      selected.push({ candidateId, shotId: shot.id, media: structuredClone(media), outputVersion: snapshot.shotStates[shot.id]?.outputVersion ?? 0 })
      changes++
    }
    if (!changes) throw new Error('预览候选没有可组合的媒体变化')
    if (!timeline.tracks.some(track => track.kind === 'video' && track.clips.some(clip => clip.source?.shotId === shot.id && clip.start < input.range.end && clip.start + clip.duration > input.range.start))) throw new Error('预览候选镜头不在指定画面范围内')
  }
  return selected
}

/** 用候选临时覆盖画面并按真实时长补声，再裁切和平移全部轨道；不改变任何正式输入。 */
export function buildVisualEditingPreview(timeline: VisualEditingDocument, outputs: readonly VisualPreviewOutput[], durations: ReadonlyMap<string, number>, range: { start: number; end: number }): VisualEditingDocument {
  const preview = structuredClone(timeline)
  for (const output of outputs) {
    const source = { type: 'shot-media' as const, shotId: output.shotId, mediaId: output.media.id, mediaHash: output.media.hash, shotOutputVersion: output.outputVersion }
    const pictureClips = preview.tracks.find(track => track.kind === 'video')!.clips.filter(clip => clip.source?.shotId === output.shotId)
    if (output.media.kind !== 'audio') {
      for (const clip of pictureClips) {
        clip.source = { ...source }
        clip.label = `${output.media.kind === 'image' ? '候选静帧' : '候选视频'} · ${clip.label}`.slice(0, 200)
        if (output.media.kind === 'image') { clip.sourceIn = 0; clip.sourceOut = clip.duration }
      }
      continue
    }
    const duration = durations.get(output.media.id)
    if (!duration || !Number.isFinite(duration) || duration < 0.01) throw new Error('无法确认候选声音的真实时长')
    const start = Math.min(...pictureClips.map(clip => clip.start))
    const end = Math.max(...pictureClips.map(clip => clip.start + clip.duration))
    if (duration > end - start + 0.001) throw new Error('候选声音长于镜头，请先修正台词时长或剪辑计划，不能静默截断')
    let voice = preview.tracks.find(track => track.kind === 'voice')
    if (!voice) { voice = { id: 'preview-voice', kind: 'voice', clips: [] }; preview.tracks.push(voice) }
    voice.clips = voice.clips.filter(clip => clip.source?.shotId !== output.shotId)
    voice.clips.push({ id: `preview-${output.candidateId}`, source, start, duration, sourceIn: 0, sourceOut: duration, label: '候选声音（待听验）', volume: 1 })
  }
  for (const track of preview.tracks) {
    track.clips = track.clips.flatMap(clip => {
      const start = Math.max(clip.start, range.start)
      const end = Math.min(clip.start + clip.duration, range.end)
      if (end <= start) return []
      const sourceIn = clip.sourceIn + start - clip.start
      return [{ ...clip, start: start - range.start, duration: end - start, sourceIn, sourceOut: sourceIn + end - start }]
    }).sort((left, right) => left.start - right.start)
  }
  preview.duration = range.end - range.start
  /** 当前编码器使用顺序拼接，画面空档必须明确拒绝，不能悄悄缩短声画时间。 */
  let cursor = 0
  for (const clip of preview.tracks.find(track => track.kind === 'video')?.clips ?? []) {
    if (Math.abs(clip.start - cursor) > 0.0001) throw new Error('预览范围含画面空档，请先修正剪辑时间线')
    cursor += clip.duration
  }
  if (Math.abs(cursor - preview.duration) > 0.0001) throw new Error('预览范围含画面空档，请先修正剪辑时间线')
  return parseVisualEditingDocument(preview)
}
