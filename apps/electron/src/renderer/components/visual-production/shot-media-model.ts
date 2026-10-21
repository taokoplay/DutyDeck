import { resolveVisualShotOutputs } from '@dutydeck/shared'
import type { VisualCandidate, VisualMedia, VisualProductionSnapshot, VisualShot } from '@dutydeck/shared'

/** 分镜三类输出的稳定顺序与用户名称。 */
export const SHOT_MEDIA_KINDS = ['image', 'video', 'audio'] as const
/** 同一名称供预览、选择器和候选比较使用。 */
export const SHOT_MEDIA_LABELS = { image: '画面', video: '影片', audio: '音频' }

/** 独立素材位区分正式输出和待采用预览，预览不改变绑定。 */
export interface ShotMediaSlot {
  /** 素材位只接受对应种类。 */
  kind: VisualMedia['kind']
  /** 当前正式采用的媒体；尚未采用时为空。 */
  adopted?: VisualMedia
  /** 优先正式输出，否则展示最新可采用候选。 */
  preview?: VisualMedia
  /** 仅包含当前镜头、当前版本且实际改变该槽的候选。 */
  candidates: VisualCandidate[]
}

/** 从最新快照构造分镜素材位；旧候选仅声明其 mediaId 所属种类。 */
export function buildShotMediaSlots(snapshot: VisualProductionSnapshot, shot: VisualShot): ShotMediaSlot[] {
  /** 索引元数据，避免每个候选重复扫描媒体库。 */
  const media = new Map(snapshot.media.map(item => [item.id, item]))
  /** 旧分镜按真实媒体类型解析，不把视频当作图片。 */
  const outputs = resolveVisualShotOutputs(shot, media)
  /** 冻结同一镜头可采用的候选差异，其他镜头与过期内容不能混入。 */
  const pending = snapshot.candidates.filter(item => item.status === 'ready' && item.baseRevision === snapshot.document.revision)
    .map(item => ({ candidate: item, shot: item.draft.shots.find(value => value.id === shot.id) }))
    .filter(item => item.shot !== undefined).sort((left, right) => right.candidate.createdAt - left.candidate.createdAt)
  return SHOT_MEDIA_KINDS.map(kind => {
    /** 显式三槽候选比较对应槽，旧候选只影响 mediaId 的实际种类。 */
    const candidates = pending.filter(item => {
      const proposed = resolveVisualShotOutputs(item.shot!, media)[kind]
      return !!proposed && proposed !== outputs[kind] && media.get(proposed)?.kind === kind
    }).map(item => item.candidate)
    /** 空槽可预览候选，但不得在数据与状态上称为已采用。 */
    const adopted = outputs[kind] ? media.get(outputs[kind]!) : undefined
    const first = candidates[0]?.draft.shots.find(item => item.id === shot.id)
    const previewId = first ? resolveVisualShotOutputs(first, media)[kind] : null
    return { kind, adopted, preview: adopted ?? (previewId ? media.get(previewId) : undefined), candidates }
  })
}
