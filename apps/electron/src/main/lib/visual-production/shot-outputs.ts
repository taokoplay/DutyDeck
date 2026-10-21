import { resolveVisualShotOutputs, withVisualShotOutput } from '@dutydeck/shared'
import type { VisualMedia, VisualProductionDraft, VisualShotOutputs } from '@dutydeck/shared'

/** 每镜头只记录真正变化的槽，重建候选时不覆盖其他已采用输出。 */
export type ShotOutputChanges = Map<string, Partial<VisualShotOutputs>>

/** 识别纯输出候选；旧草稿只声明单一媒体所属槽，其余槽不是删除指令。 */
export function shotOutputChanges(current: VisualProductionDraft, proposed: VisualProductionDraft, media: ReadonlyMap<string, VisualMedia>): ShotOutputChanges | null {
  /** 顶层仅比较业务内容。 */
  const fields = ['title', 'kind', 'brief', 'ratio', 'fps', 'voice', 'music', 'episodes', 'assets'] as const
  if (fields.some(field => JSON.stringify(current[field]) !== JSON.stringify(proposed[field])) || current.shots.length !== proposed.shots.length) return null
  /** 输出变更按槽存储。 */
  const changes: ShotOutputChanges = new Map()
  for (let index = 0; index < current.shots.length; index++) {
    const previous = current.shots[index]!
    const next = proposed.shots[index]!
    if (JSON.stringify({ ...previous, mediaId: null, outputs: undefined }) !== JSON.stringify({ ...next, mediaId: null, outputs: undefined })) return null
    const before = resolveVisualShotOutputs(previous, media)
    const after = resolveVisualShotOutputs(next, media)
    const delta: Partial<VisualShotOutputs> = {}
    for (const kind of ['image', 'video', 'audio'] as const) {
      if (!next.outputs && !after[kind]) continue
      if (before[kind] !== after[kind]) delta[kind] = after[kind]
    }
    if (Object.keys(delta).length) changes.set(next.id, delta)
  }
  return changes.size ? changes : null
}

/** 将指定槽变更应用于最新正式草稿，保持其他槽和全部设定不变。 */
export function withShotOutputs(current: VisualProductionDraft, changes: ReadonlyMap<string, Partial<VisualShotOutputs>>, media: ReadonlyMap<string, VisualMedia>): VisualProductionDraft {
  const { title, kind, brief, ratio, fps, voice, music, episodes, assets, shots } = current
  return { title, kind, brief, ratio, fps, voice, music, episodes, assets, shots: shots.map(shot => {
    const outputs = changes.get(shot.id)
    if (!outputs) return shot
    let next = shot
    for (const kind of ['image', 'video', 'audio'] as const) if (outputs[kind] !== undefined) next = withVisualShotOutput(next, kind, outputs[kind]!, media)
    return next
  }) }
}
