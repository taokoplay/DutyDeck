import type { VisualMedia, VisualProductionSnapshot } from '@dutydeck/shared'

/** 一份素材在正式作品中的使用位置，供导出页定位来源。 */
export interface VisualDeliveryUsage {
  /** 来源对象身份与类型；镜头同时保留所属集数。 */
  kind: 'shot' | 'asset'
  id: string
  episodeId?: string
  /** 使用业务名称拼成的位置说明，不以内部素材身份作标题。 */
  label: string
}

/** 同一媒体只展示一次，保留所有使用位置以及宿主计算的更新状态。 */
export interface VisualDeliveryItem {
  id: string
  title: string
  group: 'shot' | 'asset'
  media?: VisualMedia
  usages: VisualDeliveryUsage[]
  needsUpdate: boolean
}

/** 导出清单只包含正式绑定的素材，并统计仍待制作的内容。 */
export interface VisualDeliveryModel {
  items: VisualDeliveryItem[]
  unmadeShots: number
  unmadeAssets: number
}

/** 从正式快照投影导出列表，未采用候选与未绑定媒体不属于交付物。 */
export function buildVisualDelivery(snapshot: Pick<VisualProductionSnapshot, 'document' | 'media' | 'shotStates'>): VisualDeliveryModel {
  /** 单次索引让共享素材去重保持线性，不为每个镜头扫描整库。 */
  const mediaById = new Map(snapshot.media.map(item => [item.id, item]))
  const episodesById = new Map(snapshot.document.episodes.map(item => [item.id, item.title]))
  const itemsById = new Map<string, VisualDeliveryItem>()
  const episodePositions = new Map<string, number>()
  const result: VisualDeliveryModel = { items: [], unmadeShots: 0, unmadeAssets: 0 }
  /** 首个使用位置决定主标题与分组，其他位置归入同一文件。 */
  const add = (mediaId: string, title: string, usage: VisualDeliveryUsage, needsUpdate: boolean): void => {
    const existing = itemsById.get(mediaId)
    if (existing) { existing.usages.push(usage); existing.needsUpdate ||= needsUpdate; return }
    itemsById.set(mediaId, { id: mediaId, title, group: usage.kind, media: mediaById.get(mediaId), usages: [usage], needsUpdate })
  }
  for (const shot of snapshot.document.shots) {
    /** 镜头序号在每集独立计算，包含待制作镜头的位置。 */
    const position = (episodePositions.get(shot.episodeId) ?? 0) + 1
    episodePositions.set(shot.episodeId, position)
    if (!shot.mediaId) { result.unmadeShots++; continue }
    const unit = `${snapshot.document.kind === 'image' ? '图片' : '镜头'} ${position}`
    const title = shot.title.trim() || unit
    const label = `${episodesById.get(shot.episodeId) || '未命名集数'} · ${unit}${title === unit ? '' : ` · ${title}`}`
    add(shot.mediaId, title, { kind: 'shot', id: shot.id, episodeId: shot.episodeId, label }, !!snapshot.shotStates[shot.id]?.needsUpdate)
  }
  for (const asset of snapshot.document.assets) {
    if (!asset.mediaId) { result.unmadeAssets++; continue }
    /** 业务资料无名称时使用清晰占位，绝不回退到内部 UUID。 */
    const title = asset.name.trim() || '未命名资产'
    add(asset.mediaId, title, { kind: 'asset', id: asset.id, label: `${asset.type} · ${title}` }, false)
  }
  result.items = [...itemsById.values()]
  return result
}

/** 后缀来自已校验的媒体类型，避免无后缀 UUID 无法被系统识别。 */
const MEDIA_EXTENSIONS: Record<string, string> = {
  'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/gif': 'gif',
  'video/mp4': 'mp4', 'video/webm': 'webm', 'video/quicktime': 'mov',
  'audio/mpeg': 'mp3', 'audio/wav': 'wav', 'audio/x-wav': 'wav', 'audio/ogg': 'ogg',
  'audio/mp4': 'm4a', 'audio/flac': 'flac', 'audio/webm': 'webm', 'application/json': 'json',
}

/** 将用户可读标题转换为跨平台下载文件名；后缀必须来自实际 MIME。 */
export function visualDeliveryFileName(title: string, mime: string): string {
  /** 限制 Unicode 字符数，给 UTF-8 文件名与浏览器重名序号留出空间。 */
  let name = Array.from(title.replace(/[<>:"/\\|?*\u0000-\u001f\u007f]/g, '-').trim()).slice(0, 55).join('').replace(/^[. ]+|[. ]+$/g, '') || '素材'
  if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(name)) name = `_${name}`
  return `${name}.${MEDIA_EXTENSIONS[mime] ?? 'bin'}`
}
