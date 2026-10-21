import type { VisualMedia, VisualShot, VisualShotOutputs } from '../types/visual-production'

/** 解析独立输出；旧镜头依据已登记媒体种类归类，不猜测图片类型。 */
export function resolveVisualShotOutputs(shot: VisualShot, media: ReadonlyMap<string, VisualMedia>): VisualShotOutputs {
  if (shot.outputs) return { ...shot.outputs }
  /** 空输出避免未知旧引用被错误分类。 */
  const outputs: VisualShotOutputs = { image: null, video: null, audio: null }
  /** 已登记素材是兼容分类的唯一依据。 */
  const kind = shot.mediaId ? media.get(shot.mediaId)?.kind : undefined
  if (kind) outputs[kind] = shot.mediaId
  return outputs
}

/** 替换指定槽并保留其他输出，同时维护旧消费者使用的视觉主引用。 */
export function withVisualShotOutput(shot: VisualShot, kind: VisualMedia['kind'], mediaId: string | null, media: ReadonlyMap<string, VisualMedia>): VisualShot {
  /** 只复制当前镜头的三个小型引用，不读取素材字节。 */
  const outputs = { ...resolveVisualShotOutputs(shot, media), [kind]: mediaId }
  return { ...shot, outputs, mediaId: outputs.video ?? outputs.image ?? null }
}

/** 旧候选只声明非空单媒体，保留当前其他槽；显式三槽中的 null 仍表示清空。 */
export function mergeLegacyVisualShotOutputs(proposed: VisualShot, current: VisualShot | undefined, media: ReadonlyMap<string, VisualMedia>): VisualShot {
  if (proposed.outputs) return proposed
  /** 新镜头没有继承来源；已有镜头沿用正式三槽。 */
  const outputs = current ? resolveVisualShotOutputs(current, media) : { image: null, video: null, audio: null }
  /** 旧空引用不是独立槽删除指令。 */
  const kind = proposed.mediaId ? media.get(proposed.mediaId)?.kind : undefined
  if (kind) outputs[kind] = proposed.mediaId
  return { ...proposed, outputs, mediaId: outputs.video ?? outputs.image ?? null }
}
