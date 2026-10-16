import type { VisualProductionCommand, VisualProductionDraft, VisualProductionInputs, VisualProductionKind, VisualProductionMethod } from './visual-production'
import type { MediaAssetRef } from './media'

/** IPC、文件存储和 Agent 共用的硬预算。 */
export const VISUAL_PRODUCTION_LIMITS = { projects: 100, episodes: 100, assets: 200, shots: 300, candidates: 32, jobs: 100, media: 500, totalChars: 262144, metadataBytes: 8388608, mediaBytes: 33554432 } as const
/** 不改变正式数据、任务或媒体的命令。 */
export const VISUAL_PRODUCTION_READ_METHODS: readonly VisualProductionMethod[] = ['list', 'load', 'mediaContent', 'exportManifest']
/** 固定业务资产分类。 */
export const VISUAL_ASSET_TYPES = ['角色', '场景', '产品', '道具', '风格', '品牌', '声音'] as const
/** 支持的预览比例，禁止任意 CSS 值。 */
export const VISUAL_PRODUCTION_RATIOS = ['16:9', '9:16', '1:1', '4:5', '4:3', '3:4', '21:9'] as const

/** 统一抛错不包含未验证输入。 */
function invalid(field: string): never { throw new Error(`VISUAL_PRODUCTION_INVALID: ${field}`) }
/** 限制普通对象并拒绝额外字段，返回待逐项验证的对象。 */
function object(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) return invalid('参数必须为普通对象')
  if (Object.keys(value).some(key => !keys.includes(key))) return invalid('存在不支持的字段')
  return value as Record<string, unknown>
}
/** 字符串具有明确上限，必填字段拒绝纯空白。 */
function string(value: unknown, field: string, max = 128, empty = false): string {
  if (typeof value !== 'string' || value.length > max || value.includes('\0') || (!empty && !value.trim())) return invalid(field)
  return value
}
/** 身份可安全作为索引和路径单段，同时拒绝原型属性名。 */
export function assertVisualProductionId(value: unknown): asserts value is string {
  if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(value) || ['__proto__', 'constructor', 'prototype'].includes(value)) invalid('对象身份无效')
}
/** 验证身份并返回，以构造独立白名单副本。 */
function id(value: unknown): string { assertVisualProductionId(value); return value }
/** 正式版本必须为正安全整数。 */
function revision(value: unknown): number { if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) return invalid('版本无效'); return value }
/** 只接受显式布尔值。 */
function boolean(value: unknown): boolean { if (typeof value !== 'boolean') return invalid('锁定状态无效'); return value }
/** 数组预算在 map/复制前检查。 */
function array(value: unknown, max: number): unknown[] { if (!Array.isArray(value) || value.length > max) return invalid('条目数量超出预算'); return value }
/** 同一集合中的身份和引用不能重复。 */
function unique(values: string[]): void { if (new Set(values).size !== values.length) invalid('身份或引用重复') }
/** 作品类型必须属于产品已实现入口。 */
function kind(value: unknown): VisualProductionKind { if (!['comic', 'film', 'promo', 'image'].includes(String(value))) return invalid('作品类型无效'); return value as VisualProductionKind }
/** 可空的内部媒体身份，拒绝 URL 与外部路径。 */
function mediaId(value: unknown): string | null { return value === null ? null : id(value) }

/** 验证授权项目内的普通来源文件，不允许隐藏内部存储、链接语法或路径回退。 */
export function parseVisualProductionRelativePath(value: unknown): string {
  /** 原始相对路径保留中文和空格，文件读取仍在主进程复核句柄。 */
  const path = string(value, '来源路径无效', 1024)
  if (path.includes('\\') || path.includes(':') || path.startsWith('/') || path.split('/').some(part => !part || part.startsWith('.'))) return invalid('来源必须是项目内的普通相对文件')
  return path
}

/**
 * 验证完整作品草稿，返回没有共享引用的规范对象。
 * @param value 不可信 IPC、文件或 Agent 草稿。
 * @returns 关系完整且文本有界的可编辑内容。
 */
export function parseVisualProductionDraft(value: unknown): VisualProductionDraft {
  /** 根字段仅允许业务可编辑数据。 */
  const draft = object(value, ['title', 'kind', 'brief', 'ratio', 'fps', 'voice', 'music', 'episodes', 'assets', 'shots'])
  /** 作品类型影响镜头时长合同。 */
  const productionKind = kind(draft.kind)
  if (!(VISUAL_PRODUCTION_RATIOS as readonly unknown[]).includes(draft.ratio)) invalid('画面比例无效')
  if (![24, 25, 30, 50, 60].includes(draft.fps as number)) invalid('帧率无效')
  /** 先建立集数索引，供镜头归属检查。 */
  const episodes = array(draft.episodes, VISUAL_PRODUCTION_LIMITS.episodes).map(value => {
    const entry = object(value, ['id', 'title'])
    return { id: id(entry.id), title: string(entry.title, '集数名称', 120) }
  })
  unique(episodes.map(entry => entry.id))
  /** 资产是作品级集合，锁定状态属于正式内容。 */
  const assets = array(draft.assets, VISUAL_PRODUCTION_LIMITS.assets).map(value => {
    const entry = object(value, ['id', 'name', 'type', 'description', 'locked', 'mediaId'])
    if (!(VISUAL_ASSET_TYPES as readonly unknown[]).includes(entry.type)) invalid('资产类型无效')
    return { id: id(entry.id), name: string(entry.name, '资产名称', 120), type: entry.type as string, description: string(entry.description, '资产描述', 8000, true), locked: boolean(entry.locked), mediaId: mediaId(entry.mediaId) }
  })
  unique(assets.map(entry => entry.id))
  /** 线性检查引用，避免镜头与资产数量相乘。 */
  const episodeIds = new Set(episodes.map(entry => entry.id))
  const assetIds = new Set(assets.map(entry => entry.id))
  /** 每个镜头必须归属现有集数并引用现有资产。 */
  const shots = array(draft.shots, VISUAL_PRODUCTION_LIMITS.shots).map(value => {
    const entry = object(value, ['id', 'episodeId', 'title', 'duration', 'scene', 'motion', 'dialogue', 'assetIds', 'mediaId'])
    const episodeId = id(entry.episodeId)
    if (!episodeIds.has(episodeId)) invalid('镜头所属集数不存在')
    const references = array(entry.assetIds, VISUAL_PRODUCTION_LIMITS.assets).map(id)
    unique(references)
    if (references.some(reference => !assetIds.has(reference))) invalid('镜头引用资产不存在')
    if (typeof entry.duration !== 'number' || !Number.isFinite(entry.duration) || entry.duration > 600 || entry.duration < 0 || (productionKind !== 'image' && entry.duration === 0)) invalid('镜头时长无效')
    return { id: id(entry.id), episodeId, title: string(entry.title, '镜头名称', 120), duration: entry.duration, scene: string(entry.scene, '画面描述', 8000, true), motion: string(entry.motion, '动作描述', 8000, true), dialogue: string(entry.dialogue, '对白', 8000, true), assetIds: references, mediaId: mediaId(entry.mediaId) }
  })
  unique(shots.map(entry => entry.id))
  /** 规范结果最后执行总量预算，不接受局部上限叠加后的无界作品。 */
  const result: VisualProductionDraft = { title: string(draft.title, '作品名称', 120), kind: productionKind, brief: string(draft.brief, '作品目标', 16000, true), ratio: draft.ratio as string, fps: draft.fps as number, voice: string(draft.voice, '配音要求', 4000, true), music: string(draft.music, '音乐要求', 4000, true), episodes, assets, shots }
  if (JSON.stringify(result).length > VISUAL_PRODUCTION_LIMITS.totalChars) invalid('作品总文本超出预算')
  return result
}

/** 既有媒体库的内容身份必须完整，不能仅凭 assetId 引用最新版本。 */
function mediaReference(value: unknown): MediaAssetRef {
  const ref = object(value, ['assetId', 'revision', 'hash', 'mediaKind'])
  const hash = string(ref.hash, '素材哈希', 64)
  if (!/^[a-f0-9]{64}$/.test(hash) || !['image', 'video', 'audio'].includes(String(ref.mediaKind))) invalid('媒体身份无效')
  return { assetId: id(ref.assetId), revision: revision(ref.revision), hash, mediaKind: ref.mediaKind as MediaAssetRef['mediaKind'] }
}

/** 输入白名单；调用方不能通过附加字段选择目录或伪造系统状态。 */
const METHOD_FIELDS: Record<VisualProductionMethod, readonly string[]> = {
  list: [], create: ['title', 'kind'], load: [], save: ['baseRevision', 'draft'], importFile: ['relativePath'], importMedia: ['reference'], mediaContent: ['mediaId'], beginJob: ['baseRevision', 'instruction', 'shotId'], propose: ['baseRevision', 'jobId', 'draft', 'summary'], adopt: ['baseRevision', 'candidateId'], discardCandidate: ['candidateId'], cancelJob: ['jobId'], failJob: ['jobId', 'message'], exportManifest: [],
}

/** 解析 UI/Agent 公用信封；返回 method/input 关联的判别联合。 */
export function parseVisualProductionCommand(value: unknown): VisualProductionCommand {
  const command = object(value, ['method', 'input'])
  if (typeof command.method !== 'string' || !Object.hasOwn(METHOD_FIELDS, command.method)) return invalid('不支持的命令')
  const method = command.method as VisualProductionMethod
  const input = object(command.input, ['sessionId', ...(method === 'list' || method === 'create' ? [] : ['productionId']), ...METHOD_FIELDS[method]])
  const sessionId = id(input.sessionId)
  /** 受关联类型约束的构造器，避免丢失请求/返回值映射。 */
  const result = <M extends VisualProductionMethod>(name: M, data: VisualProductionInputs[M]): VisualProductionCommand => ({ method: name, input: data }) as VisualProductionCommand
  if (method === 'list') return result(method, { sessionId })
  if (method === 'create') return result(method, { sessionId, title: string(input.title, '作品名称', 120), kind: kind(input.kind) })
  const base = { sessionId, productionId: id(input.productionId) }
  switch (method) {
    case 'load': case 'exportManifest': return result(method, base)
    case 'save': return result(method, { ...base, baseRevision: revision(input.baseRevision), draft: parseVisualProductionDraft(input.draft) })
    case 'importFile': return result(method, { ...base, relativePath: parseVisualProductionRelativePath(input.relativePath) })
    case 'importMedia': return result(method, { ...base, reference: mediaReference(input.reference) })
    case 'mediaContent': return result(method, { ...base, mediaId: id(input.mediaId) })
    case 'beginJob': return result(method, { ...base, baseRevision: revision(input.baseRevision), instruction: string(input.instruction, '任务要求', 16000), ...(input.shotId === undefined ? {} : { shotId: id(input.shotId) }) })
    case 'propose': return result(method, { ...base, baseRevision: revision(input.baseRevision), jobId: id(input.jobId), draft: parseVisualProductionDraft(input.draft), summary: string(input.summary, '候选说明', 2000) })
    case 'adopt': return result(method, { ...base, baseRevision: revision(input.baseRevision), candidateId: id(input.candidateId) })
    case 'discardCandidate': return result(method, { ...base, candidateId: id(input.candidateId) })
    case 'cancelJob': return result(method, { ...base, jobId: id(input.jobId) })
    case 'failJob': return result(method, { ...base, jobId: id(input.jobId), message: string(input.message, '失败说明', 2000) })
  }
}
