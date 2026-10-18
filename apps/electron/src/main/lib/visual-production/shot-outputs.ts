import type { VisualProductionDraft } from '@dutydeck/shared'

/**
 * 识别只替换现有镜头媒体的候选，任何设定、顺序或资产变更均返回 null。
 * @param current 当前正式草稿。
 * @param proposed 候选草稿。
 * @returns 有变化的镜头与非空媒体身份；无变化或非纯画面候选返回 null。
 */
export function shotOutputChanges(current: VisualProductionDraft, proposed: VisualProductionDraft): Map<string, string> | null {
  /** 顶层只比较业务字段，忽略正式文档的宿主身份与时间。 */
  const fields = ['title', 'kind', 'brief', 'ratio', 'fps', 'voice', 'music', 'episodes', 'assets'] as const
  if (fields.some(field => JSON.stringify(current[field]) !== JSON.stringify(proposed[field])) || current.shots.length !== proposed.shots.length) return null
  /** 同一位置必须是同一镜头，避免将重排混同为图片采用。 */
  const changes = new Map<string, string>()
  for (let index = 0; index < current.shots.length; index++) {
    const previous = current.shots[index]!
    const next = proposed.shots[index]!
    if (JSON.stringify({ ...previous, mediaId: next.mediaId }) !== JSON.stringify(next)) return null
    if (next.mediaId !== previous.mediaId) {
      if (!next.mediaId) return null
      changes.set(next.id, next.mediaId)
    }
  }
  return changes.size ? changes : null
}

/** 根据已验证的媒体变更构造新草稿，保留当前版本的所有其他内容。 */
export function withShotOutputs(current: VisualProductionDraft, outputs: ReadonlyMap<string, string>): VisualProductionDraft {
  const { title, kind, brief, ratio, fps, voice, music, episodes, assets, shots } = current
  return { title, kind, brief, ratio, fps, voice, music, episodes, assets, shots: shots.map(shot => outputs.has(shot.id) ? { ...shot, mediaId: outputs.get(shot.id)! } : shot) }
}
