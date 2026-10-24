import { PROTOTYPE_LIMITS } from '@dutydeck/shared'
import type { PrototypeAsset, PrototypeDraft, PrototypeReferenceRole } from '@dutydeck/shared'
import { copyPrototypeDraft } from './interaction-design-model'

/** 单次拖入参考图数量上限，避免一次拖放触发无界 IPC 和图片解码。 */
export const INTERACTION_REFERENCE_DROP_LIMIT = 20

/** 允许拖入的被动图片 MIME；SVG 不进入资产库。 */
const REFERENCE_IMAGE_MIME_TYPES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp'])
/** 部分系统拖放不给 MIME，合法扩展名作为兼容依据。 */
const REFERENCE_IMAGE_EXTENSION = /\.(?:png|jpe?g|gif|webp)$/i

/**
 * 判断拖入文件是否可作为参考图。
 * @param file 文件名、系统和大小；不读取正文。
 * @returns 是否为受支持且不超过资产上限的被动图片。
 */
export function isInteractionReferenceImageFile(file: Pick<File, 'name' | 'type' | 'size'>): boolean {
  if (file.size <= 0 || file.size > PROTOTYPE_LIMITS.assetBytes) return false
  if (file.type) return REFERENCE_IMAGE_MIME_TYPES.has(file.type.toLowerCase())
  return REFERENCE_IMAGE_EXTENSION.test(file.name)
}

/** 新参考图的用户输入；图片正文仍由独立资产库管理。 */
export interface AddPrototypeReferenceInput {
  /** 稳定参考图身份。 */
  id: string
  /** 用户可读标题。 */
  title: string
  /** 结构、视觉或文案用途。 */
  role: PrototypeReferenceRole
  /** 至少一个页面关联；未知页面会被忽略。 */
  pageIds: string[]
  /** 可选来源说明。 */
  source?: string
}

/**
 * 将已登记资产加入参考图库。
 * @param document 当前原型。
 * @param asset 已通过项目资产库校验的图片。
 * @param input 参考图元数据。
 * @returns 带新参考图、不共享可变对象的草稿。
 */
export function addPrototypeReference(
  document: PrototypeDraft,
  asset: PrototypeAsset,
  input: AddPrototypeReferenceInput,
): ReturnType<typeof copyPrototypeDraft> {
  if ((document.references ?? []).some(reference => reference.assetId === asset.id)) throw new Error('该图片已经是参考图')
  const validPages = new Set(document.pages.map(page => page.id))
  const pageIds = [...new Set(input.pageIds)].filter(pageId => validPages.has(pageId))
  if (!pageIds.length) throw new Error('参考图至少关联一个页面')
  const next = copyPrototypeDraft(document)
  next.references = [
    ...(next.references ?? []),
    {
      id: input.id,
      assetId: asset.id,
      title: input.title.trim() || asset.name,
      role: input.role,
      ...(input.source?.trim() ? { source: input.source.trim() } : {}),
      usages: pageIds.map(pageId => ({ pageId })),
    },
  ]
  return next
}

/**
 * 替换参考图的页面级关联，保留状态和流程关系之外的身份。
 * @param document 当前原型。
 * @param referenceId 参考图身份。
 * @param pageIds 新页面集合。
 * @returns 更新后的草稿。
 */
export function setPrototypeReferencePages(
  document: PrototypeDraft,
  referenceId: string,
  pageIds: string[],
): ReturnType<typeof copyPrototypeDraft> {
  const validPages = new Set(document.pages.map(page => page.id))
  const nextPageIds = [...new Set(pageIds)].filter(pageId => validPages.has(pageId))
  if (!nextPageIds.length) throw new Error('参考图至少关联一个页面')
  const next = copyPrototypeDraft(document)
  next.references = (next.references ?? []).map(reference => reference.id === referenceId
    ? { ...reference, usages: nextPageIds.map(pageId => ({ pageId })) }
    : reference)
  return next
}

/**
 * 从当前草稿移除参考图关系，不删除独立资产。
 * @param document 当前原型。
 * @param referenceId 参考图身份。
 * @returns 更新后的草稿。
 */
export function removePrototypeReference(
  document: PrototypeDraft,
  referenceId: string,
): ReturnType<typeof copyPrototypeDraft> {
  const next = copyPrototypeDraft(document)
  next.references = (next.references ?? []).filter(reference => reference.id !== referenceId)
  return next
}

/**
 * 将一组已登记资产自动加入同一页面的参考图集合。
 * @param document 当前原型。
 * @param assets 已通过主进程图片检查的资产。
 * @param pageId 目标页面。
 * @param role 默认用途；拖入图片按视觉参考登记。
 * @returns 至少新增一项时的草稿；全部已存在时返回 null。
 */
export function addPrototypeAssetReferences(
  document: PrototypeDraft,
  assets: PrototypeAsset[],
  pageId: string,
  role: PrototypeReferenceRole = 'visual',
): PrototypeDraft | null {
  if (!document.pages.some(page => page.id === pageId)) throw new Error('参考图关联页面不存在')
  const existingAssetIds = new Set((document.references ?? []).map(reference => reference.assetId))
  const additions = assets.filter(asset => {
    if (existingAssetIds.has(asset.id)) return false
    existingAssetIds.add(asset.id)
    return true
  })
  if (!additions.length) return null
  const next = copyPrototypeDraft(document)
  next.references = [
    ...(next.references ?? []),
    ...additions.map(asset => ({
      id: crypto.randomUUID(),
      assetId: asset.id,
      title: asset.name.replace(/\.[^.]+$/, '') || asset.name,
      role,
      source: '拖入图片',
      usages: [{ pageId }],
    })),
  ]
  return next
}
