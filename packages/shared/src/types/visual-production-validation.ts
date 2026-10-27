import type { VisualProductionMediaConfiguration, VisualProductionMediaEntry, VisualProductionMediaKind, VisualProductionMediaSource, VisualProductionMediaExecution } from './visual-production-media'
import type { VisualCandidateReview, VisualCandidateReviewInput, VisualEpisodeScript, VisualJob, VisualProductionCommand, VisualProductionDraft, VisualProductionInputs, VisualProductionKind, VisualProductionMethod, VisualReviewGate, VisualReviewGateStatus, VisualReviewIssue, VisualScriptBeatPurpose, VisualShotAudioTransition, VisualShotContinuityPlan, VisualShotTransition, VisualShotVideoMode } from './visual-production'
import { VISUAL_SHOT_ACTION_PHASES, VISUAL_SHOT_AUDIO_TRANSITIONS } from './visual-production'
import type { MediaAssetRef } from './media'
import { parseVisualEditingDocument, parseVisualEditingExportSettings, parseVisualEditingOperations } from './visual-editing'

/** IPC、文件存储和 Agent 共用的硬预算。 */
export const VISUAL_PRODUCTION_LIMITS = { projects: 100, episodes: 100, assets: 200, shots: 300, candidates: 32, jobs: 100, media: 500, totalChars: 262144, metadataBytes: 8388608, mediaBytes: 33554432 } as const
/** 不改变正式数据、任务或媒体的命令。 */
export const VISUAL_PRODUCTION_READ_METHODS: readonly VisualProductionMethod[] = ['list', 'load', 'mediaContent', 'exportManifest', 'mediaCatalog', 'resolveMediaWorkflow', 'loadTimeline', 'listExportJobs']
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
/** 新建时间线或导出任务允许使用零表示尚未有正式版本。 */
function expectedRevision(value: unknown, field: string): number { if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) return invalid(field); return value }
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

/**
 * 解析候选审核结论，限制门禁状态、问题数量和时间点。
 * @param value 不可信审核对象。
 * @param metadata 读取持久记录时要求宿主会话与时间。
 * @returns 独立审核对象；输入请求不包含宿主元数据。
 */
export function parseVisualCandidateReview(value: unknown, metadata = false): VisualCandidateReview | VisualCandidateReviewInput {
  const keys = ['technical', 'motion', 'continuity', 'audio', 'conclusion', 'unchecked', 'issues', ...(metadata ? ['sessionId', 'reviewedAt'] : [])]
  const review = object(value, keys)
  const gateStatus = (field: string): VisualReviewGateStatus => {
    if (!['pending', 'passed', 'warning', 'failed'].includes(String(review[field]))) invalid(`${field} 审核状态`)
    return review[field] as VisualReviewGateStatus
  }
  const issues = array(review.issues, 32).map(item => {
    const issue = object(item, ['gate', 'severity', 'message', 'atSeconds'])
    if (!['technical', 'motion', 'continuity', 'audio'].includes(String(issue.gate)) || !['warning', 'error'].includes(String(issue.severity))) invalid('审核问题类型')
    if (issue.atSeconds !== undefined && (typeof issue.atSeconds !== 'number' || !Number.isFinite(issue.atSeconds) || issue.atSeconds < 0 || issue.atSeconds > 600)) invalid('审核问题时间')
    return { gate: issue.gate as VisualReviewGate, severity: issue.severity as VisualReviewIssue['severity'], message: string(issue.message, '审核问题', 1000), ...(issue.atSeconds === undefined ? {} : { atSeconds: issue.atSeconds }) }
  })
  const unchecked = array(review.unchecked, 16).map(item => string(item, '未检查范围', 1000))
  const result = { technical: gateStatus('technical'), motion: gateStatus('motion'), continuity: gateStatus('continuity'), ...(review.audio === undefined ? {} : { audio: gateStatus('audio') }), conclusion: string(review.conclusion, '审核总结', 4000), unchecked, issues }
  if (!metadata) return result
  if (typeof review.reviewedAt !== 'number' || !Number.isFinite(review.reviewedAt) || review.reviewedAt < 0) invalid('审核时间')
  return { ...result, sessionId: id(review.sessionId), reviewedAt: review.reviewedAt }
}

/**
 * 解析 Agent 的镜头视频制作计划。
 * @param value 不可信的视频计划；缺省兼容旧镜头。
 * @param references 当前镜头已绑定的资产身份集合；结构预解析时可省略。
 * @returns 与生成模式和转场语义一致的规范对象。
 */
function videoPlan(value: unknown, references?: ReadonlySet<string>) {
  if (value === undefined) return undefined
  const entry = object(value, ['mode', 'firstFrameAssetId', 'lastFrameAssetId', 'transitionIn', 'rationale'])
  if (!['text-to-video', 'image-to-video', 'first-last-frame'].includes(String(entry.mode))) invalid('视频生成方式无效')
  if (!['hard-cut', 'match-cut', 'dissolve'].includes(String(entry.transitionIn))) invalid('镜头转场方式无效')
  const firstFrameAssetId = entry.firstFrameAssetId === null ? null : id(entry.firstFrameAssetId)
  const lastFrameAssetId = entry.lastFrameAssetId === null ? null : id(entry.lastFrameAssetId)
  if (firstFrameAssetId && references && !references.has(firstFrameAssetId) || lastFrameAssetId && references && !references.has(lastFrameAssetId)) invalid('首尾帧资产未加入镜头引用')
  if (entry.mode === 'text-to-video' && (firstFrameAssetId || lastFrameAssetId)) invalid('文生视频不能绑定首尾帧')
  if (entry.mode === 'image-to-video' && lastFrameAssetId) invalid('首帧视频不能绑定尾帧')
  if (entry.mode === 'first-last-frame' && !lastFrameAssetId) invalid('首尾帧模式缺少尾帧')
  if (firstFrameAssetId && firstFrameAssetId === lastFrameAssetId) invalid('首帧与尾帧不能相同')
  return {
    mode: entry.mode as VisualShotVideoMode,
    firstFrameAssetId,
    lastFrameAssetId,
    transitionIn: entry.transitionIn as VisualShotTransition,
    rationale: string(entry.rationale, '视频生成依据', 2000),
  }
}

/**
 * 解析镜头的衔接合同，并核对动作锚点只能引用当前镜头已绑定资产。
 * @param value 不可信衔接合同；缺省兼容旧镜头。
 * @param references 当前镜头引用资产集合；结构预解析时可省略。
 * @returns 与视频计划和动作相位一致的独立对象。
 */
function continuityPlan(value: unknown, references?: ReadonlySet<string>): VisualShotContinuityPlan | undefined {
  if (value === undefined) return undefined
  const entry = object(value, ['entryState', 'exitState', 'anchors', 'audioTransition', 'rationale'])
  const anchors = array(entry.anchors, 12).map(item => {
    const anchor = object(item, ['phase', 'state', 'assetId'])
    if (!VISUAL_SHOT_ACTION_PHASES.includes(anchor.phase as never)) invalid('动作相位无效')
    const assetId = anchor.assetId === null ? null : id(anchor.assetId)
    if (assetId && references && !references.has(assetId)) invalid('动作锚点资产未加入镜头引用')
    return {
      phase: anchor.phase as VisualShotContinuityPlan['anchors'][number]['phase'],
      state: string(anchor.state, '动作锚点状态', 2000),
      assetId,
    }
  })
  unique(anchors.map(anchor => anchor.phase))
  unique(anchors.flatMap(anchor => anchor.assetId ? [anchor.assetId] : []))
  if (!VISUAL_SHOT_AUDIO_TRANSITIONS.includes(entry.audioTransition as never)) invalid('声音接续方式无效')
  return {
    entryState: string(entry.entryState, '入场状态', 4000),
    exitState: string(entry.exitState, '出场状态', 4000),
    anchors,
    audioTransition: entry.audioTransition as VisualShotAudioTransition,
    rationale: string(entry.rationale, '衔接依据', 2000),
  }
}

/** 验证授权项目内的普通来源文件，不允许隐藏内部存储、链接语法或路径回退。 */
export function parseVisualProductionRelativePath(value: unknown): string {
  /** 原始相对路径保留中文和空格，文件读取仍在主进程复核句柄。 */
  const path = string(value, '来源路径无效', 1024)
  if (path.includes('\\') || path.includes(':') || path.startsWith('/') || path.split('/').some(part => !part || part.startsWith('.'))) return invalid('来源必须是项目内的普通相对文件')
  return path
}

/**
 * 验证一集结构化剧本，保留节拍顺序和镜头映射。
 * @param value IPC、文件或 Agent 提供的剧本对象。
 * @returns 与输入不共享引用的剧本。
 */
export function parseVisualEpisodeScript(value: unknown): VisualEpisodeScript {
  const script = object(value, ['logline', 'audiencePromise', 'hook', 'turningPoint', 'payoff', 'targetDurationSeconds', 'productionNotes', 'beats'])
  if (typeof script.targetDurationSeconds !== 'number' || !Number.isFinite(script.targetDurationSeconds)
    || script.targetDurationSeconds < 0 || script.targetDurationSeconds > 3600) invalid('剧本目标时长无效')
  const purposes = ['hook', 'setup', 'inciting-incident', 'rising-action', 'reveal', 'turn', 'resolution', 'tag'] as const
  const beats = array(script.beats, 100).map(value => {
    const beat = object(value, ['id', 'title', 'purpose', 'dramaticQuestion', 'synopsis', 'visualAction', 'dialogue', 'sound', 'continuity', 'shotIds'])
    if (!purposes.includes(beat.purpose as VisualScriptBeatPurpose)) invalid('剧本节拍功能无效')
    const shotIds = array(beat.shotIds, VISUAL_PRODUCTION_LIMITS.shots).map(id)
    unique(shotIds)
    return {
      id: id(beat.id),
      title: string(beat.title, '节拍名称', 120),
      purpose: beat.purpose as VisualScriptBeatPurpose,
      dramaticQuestion: string(beat.dramaticQuestion, '戏剧问题', 4000, true),
      synopsis: string(beat.synopsis, '节拍概述', 8000, true),
      visualAction: string(beat.visualAction, '视觉动作', 8000, true),
      dialogue: string(beat.dialogue, '剧本对白', 8000, true),
      sound: string(beat.sound, '剧本声音', 4000, true),
      continuity: string(beat.continuity, '连续性约束', 8000, true),
      shotIds,
    }
  })
  unique(beats.map(beat => beat.id))
  return {
    logline: string(script.logline, '一句话故事', 2000, true),
    audiencePromise: string(script.audiencePromise, '观众承诺', 4000, true),
    hook: string(script.hook, '开场钩子', 4000, true),
    turningPoint: string(script.turningPoint, '核心转折', 4000, true),
    payoff: string(script.payoff, '阶段结果', 4000, true),
    targetDurationSeconds: script.targetDurationSeconds,
    productionNotes: string(script.productionNotes, '拍摄总要求', 16000, true),
    beats,
  }
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
    const entry = object(value, ['id', 'title', 'script'])
    return { id: id(entry.id), title: string(entry.title, '集数名称', 120), ...(entry.script === undefined ? {} : { script: parseVisualEpisodeScript(entry.script) }) }
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
    const entry = object(value, ['id', 'episodeId', 'title', 'duration', 'scene', 'motion', 'dialogue', 'soundDesign', 'continuityPlan', 'videoPlan', 'assetIds', 'mediaId', 'outputs'])
    const episodeId = id(entry.episodeId)
    if (!episodeIds.has(episodeId)) invalid('镜头所属集数不存在')
    const references = array(entry.assetIds, VISUAL_PRODUCTION_LIMITS.assets).map(id)
    unique(references)
    if (references.some(reference => !assetIds.has(reference))) invalid('镜头引用资产不存在')
    if (typeof entry.duration !== 'number' || !Number.isFinite(entry.duration) || entry.duration > 600 || entry.duration < 0 || (productionKind !== 'image' && entry.duration === 0)) invalid('镜头时长无效')
    /** 独立输出必须显式提供三个槽，缺省字段仍兼容旧镜头。 */
    const outputs = entry.outputs === undefined ? undefined : object(entry.outputs, ['image', 'video', 'audio'])
    /** 声音设计保持可选，但显式提供时须包含两段有界文本。 */
    const soundDesign = entry.soundDesign === undefined ? undefined : object(entry.soundDesign, ['effects', 'music'])
    /** 视频计划先按当前镜头引用核对，避免保存后才发现帧来源无权访问。 */
    const plan = videoPlan(entry.videoPlan, new Set(references))
    /** 衔接锚点同样只能来自本镜已引用资产，避免审片设计指向无权读取的画面。 */
    const continuity = continuityPlan(entry.continuityPlan, new Set(references))
    return { id: id(entry.id), episodeId, title: string(entry.title, '镜头名称', 120), duration: entry.duration, scene: string(entry.scene, '画面描述', 8000, true), motion: string(entry.motion, '动作描述', 8000, true), dialogue: string(entry.dialogue, '对白', 8000, true), ...(soundDesign === undefined ? {} : { soundDesign: { effects: string(soundDesign.effects, '环境与音效', 8000, true), music: string(soundDesign.music, '镜头配乐', 8000, true) } }), ...(continuity === undefined ? {} : { continuityPlan: continuity }), ...(plan === undefined ? {} : { videoPlan: plan }), assetIds: references, mediaId: mediaId(entry.mediaId), ...(outputs === undefined ? {} : { outputs: { image: mediaId(outputs.image), video: mediaId(outputs.video), audio: mediaId(outputs.audio) } }) }
  })
  unique(shots.map(entry => entry.id))
  /** 剧本只能映射到同一集的正式镜头，防止跨集引用造成生产顺序漂移。 */
  const shotEpisodeIds = new Map(shots.map(shot => [shot.id, shot.episodeId]))
  for (const episode of episodes) for (const beat of episode.script?.beats ?? []) {
    if (beat.shotIds.some(shotId => shotEpisodeIds.get(shotId) !== episode.id)) invalid('剧本节拍引用其他集或不存在的镜头')
  }
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
  /** 外部媒体身份沿用统一媒体合同，不用于影像存储路径。 */
  const assetId = string(ref.assetId, '媒体资产身份', 256)
  if (!/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,255}$/.test(assetId) || ['__proto__', 'constructor', 'prototype'].includes(assetId)) return invalid('媒体资产身份')
  return { assetId, revision: revision(ref.revision), hash, mediaKind: ref.mediaKind as MediaAssetRef['mediaKind'] }
}

/** 外部媒体配置身份沿用媒体配置合同，不作为影像路径段使用。 */
function externalMediaId(value: unknown): string {
  if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(value) || ['__proto__', 'constructor', 'prototype'].includes(value)) return invalid('媒体配置身份')
  return value
}

/** 严格解析制作来源，不允许保存认证信息或服务器地址。 */
function mediaSource(value: unknown): VisualProductionMediaSource {
  const source = object(value, ['type', 'modelRef', 'connectionId', 'workflowId', 'workflowRevision'])
  if (source.type === 'model') {
    object(value, ['type', 'modelRef'])
    return { type: 'model', modelRef: string(source.modelRef, '模型身份', 1024) }
  }
  if (source.type === 'connection') {
    object(value, ['type', 'connectionId'])
    return { type: 'connection', connectionId: externalMediaId(source.connectionId) }
  }
  if (source.type !== 'workflow') return invalid('制作来源类型')
  object(value, ['type', 'connectionId', 'workflowId', 'workflowRevision'])
  return { type: 'workflow', connectionId: externalMediaId(source.connectionId), workflowId: externalMediaId(source.workflowId), workflowRevision: revision(source.workflowRevision) }
}
/** 默认参数有界且只接受基本值，禁止原型键。 */
function mediaParameters(value: unknown): VisualProductionMediaEntry['parameters'] {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return invalid('制作参数')
  const keys = Object.keys(value)
  if (keys.length > 128) return invalid('制作参数数量')
  const parameters = object(value, keys)
  const result: VisualProductionMediaEntry['parameters'] = {}
  for (const key of keys) {
    if (!/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,255}$/.test(key) || ['__proto__', 'constructor', 'prototype'].includes(key)) return invalid('制作参数键')
    const item = parameters[key]
    if (typeof item === 'string') result[key] = string(item, '制作参数值', 16384, true)
    else if (typeof item === 'boolean' || (typeof item === 'number' && Number.isFinite(item))) result[key] = item
    else return invalid('制作参数值')
  }
  return result
}
/** 文件和 IPC 共用配置验证，默认必须引用同类别的已启用项。 */
export function parseVisualProductionMediaConfiguration(value: unknown): VisualProductionMediaConfiguration {
  const config = object(value, ['revision', 'entries', 'defaults'])
  const entries = array(config.entries, 100).map(value => {
    const entry = object(value, ['id', 'name', 'kind', 'source', 'parameters'])
    if (!['image', 'video', 'audio'].includes(String(entry.kind))) return invalid('制作媒体类别')
    const source = mediaSource(entry.source)
    const parameters = mediaParameters(entry.parameters)
    if (source.type === 'connection' && Object.keys(parameters).length) return invalid('服务方案不能保存工作流参数')
    return { id: id(entry.id), name: string(entry.name, '制作方案名称', 200), kind: entry.kind as VisualProductionMediaEntry['kind'], source, parameters }
  })
  unique(entries.map(entry => entry.id))
  const defaults = object(config.defaults, ['image', 'video', 'audio'])
  const result: VisualProductionMediaConfiguration = { revision: revision(config.revision), entries, defaults: {} }
  for (const key of ['image', 'video', 'audio'] as const) {
    if (defaults[key] === undefined) continue
    const selected = id(defaults[key])
    if (!entries.some(entry => entry.id === selected && entry.kind === key)) return invalid('默认方案不在启用范围')
    result.defaults[key] = selected
  }
  return result
}
/** 可信运行回执仍做持久化预算和身份校验，返回独立副本。 */
export function parseVisualProductionMediaExecution(value: unknown): VisualProductionMediaExecution {
  const receipt = object(value, ['runId', 'engine', 'entryId', 'name', 'kind', 'source', 'parameters', 'referenceAssets', 'phase', 'createdAt', 'prompt', 'outputCount'])
  if (!['model', 'workflow'].includes(String(receipt.engine)) || !['image', 'video', 'audio'].includes(String(receipt.kind))) return invalid('制作记录类型')
  if (typeof receipt.createdAt !== 'number' || !Number.isFinite(receipt.createdAt) || receipt.createdAt < 0) return invalid('制作记录时间')
  if (receipt.outputCount !== undefined && (typeof receipt.outputCount !== 'number' || !Number.isSafeInteger(receipt.outputCount) || receipt.outputCount < 0 || receipt.outputCount > 500)) return invalid('制作输出数量')
  const source = mediaSource(receipt.source)
  if (source.type === 'connection' || source.type !== receipt.engine) return invalid('制作记录来源')
  return { ...(receipt.outputCount === undefined ? {} : { outputCount: receipt.outputCount as number }), runId: id(receipt.runId), engine: receipt.engine as VisualProductionMediaExecution['engine'], ...(receipt.entryId === undefined ? {} : { entryId: id(receipt.entryId) }), name: string(receipt.name, '制作记录名称', 200), kind: receipt.kind as VisualProductionMediaExecution['kind'], source, parameters: mediaParameters(receipt.parameters), referenceAssets: array(receipt.referenceAssets, 128).map(mediaReference), phase: string(receipt.phase, '制作运行阶段', 80), createdAt: receipt.createdAt, ...(receipt.prompt === undefined ? {} : { prompt: string(receipt.prompt, '生成提示词', 16384, true) }) }
}

/** 输入白名单；调用方不能通过附加字段选择目录或伪造系统状态。 */
const METHOD_FIELDS: Record<VisualProductionMethod, readonly string[]> = {
  requestPreview: ['baseRevision', 'episodeId', 'expectedTimelineRevision', 'candidateIds', 'range', 'settings'],
  resolveMediaWorkflow: ['source', 'kind'], mediaCatalog: [], saveMediaConfiguration: ['expectedRevision', 'entries', 'defaults'], recordMediaExecution: ['baseRevision', 'jobId', 'runId', 'engine'],
  referenceMedia: ['baseRevision', 'jobId', 'mediaId'], proposeShot: ['baseRevision', 'jobId', 'shotId', 'mediaId', 'alternativeMediaIds', 'summary'], proposeScript: ['baseRevision', 'jobId', 'episodeId', 'script', 'summary'], reviewCandidate: ['baseRevision', 'candidateId', 'review'], updateJob: ['baseRevision', 'jobId', 'stage'],
  list: [], create: ['title', 'kind'], load: [], autoAdoptShots: [], save: ['baseRevision', 'draft'], updateShotPlan: ['baseRevision', 'shotId', 'videoPlan', 'continuityPlan', 'references'], importFile: ['relativePath'], importMedia: ['reference'], mediaContent: ['mediaId'], beginJob: ['baseRevision', 'instruction', 'shotId', 'mediaKind'], recordWorkflowDiscovery: ['baseRevision', 'jobId', 'discovery'], propose: ['baseRevision', 'jobId', 'draft', 'summary'], adopt: ['baseRevision', 'candidateId'], discardCandidate: ['candidateId'], cancelJob: ['jobId'], failJob: ['jobId', 'message'], exportManifest: [], loadTimeline: ['episodeId'], createRoughCut: ['episodeId', 'baseProductionRevision'], saveTimeline: ['episodeId', 'expectedRevision', 'timeline'], proposeTimelineEdit: ['episodeId', 'expectedRevision', 'operations', 'summary'], adoptTimelineEdit: ['episodeId', 'candidateId', 'expectedRevision'], discardTimelineEdit: ['episodeId', 'candidateId'], requestExport: ['episodeId', 'expectedTimelineRevision', 'settings'], listExportJobs: ['episodeId'], cancelExport: ['episodeId', 'exportJobId'],
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
    case 'autoAdoptShots': return result(method, base)
    case 'load': case 'exportManifest': case 'mediaCatalog': case 'loadTimeline': case 'listExportJobs': return result(method, method === 'load' || method === 'exportManifest' || method === 'mediaCatalog' ? base : { ...base, episodeId: id(input.episodeId) })
    case 'resolveMediaWorkflow': {
      const source = mediaSource(input.source)
      if (source.type !== 'workflow' || !['image', 'video', 'audio'].includes(String(input.kind))) return invalid('工作流来源或输出类别')
      return result(method, { ...base, source, kind: input.kind as VisualProductionMediaEntry['kind'] })
    }
    case 'saveMediaConfiguration': {
      if (typeof input.expectedRevision !== 'number' || !Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 0) return invalid('制作配置版本')
      const configuration = parseVisualProductionMediaConfiguration({ revision: 1, entries: input.entries, defaults: input.defaults })
      return result(method, { ...base, expectedRevision: input.expectedRevision, entries: configuration.entries, defaults: configuration.defaults })
    }
    case 'recordMediaExecution': {
      if (input.engine !== 'model' && input.engine !== 'workflow') return invalid('制作执行引擎')
      return result(method, { ...base, baseRevision: revision(input.baseRevision), jobId: id(input.jobId), runId: id(input.runId), engine: input.engine })
    }
    case 'save': return result(method, { ...base, baseRevision: revision(input.baseRevision), draft: parseVisualProductionDraft(input.draft) })
    case 'updateShotPlan': {
      /** 新引用只负责把已导入媒体提升为镜头资产，不能覆盖文档中的既有资产。 */
      const references = input.references === undefined ? [] : array(input.references, 12).map(value => {
        const entry = object(value, ['assetId', 'mediaId', 'name', 'type', 'description'])
        if (!(VISUAL_ASSET_TYPES as readonly unknown[]).includes(entry.type)) invalid('计划引用资产类型无效')
        return {
          assetId: id(entry.assetId),
          mediaId: id(entry.mediaId),
          name: string(entry.name, '计划引用资产名称', 120),
          type: entry.type as string,
          description: string(entry.description, '计划引用资产说明', 8000, true),
        }
      })
      unique(references.map(reference => reference.assetId))
      /** 结构先按请求内显式身份校验；保存层再以合并后的完整镜头引用复核。 */
      const plan = videoPlan(input.videoPlan)!
      const continuity = continuityPlan(input.continuityPlan)!
      return result(method, {
        ...base,
        baseRevision: revision(input.baseRevision),
        shotId: id(input.shotId),
        videoPlan: plan,
        continuityPlan: continuity,
        ...(references.length ? { references } : {}),
      })
    }
    case 'importFile': return result(method, { ...base, relativePath: parseVisualProductionRelativePath(input.relativePath) })
    case 'importMedia': return result(method, { ...base, reference: mediaReference(input.reference) })
    case 'mediaContent': return result(method, { ...base, mediaId: id(input.mediaId) })
    case 'beginJob': {
      if (input.mediaKind !== undefined && !['image', 'video', 'audio', 'mixed'].includes(String(input.mediaKind))) return invalid('任务媒体类别无效')
      return result(method, { ...base, baseRevision: revision(input.baseRevision), instruction: string(input.instruction, '任务要求', 16000), ...(input.shotId === undefined ? {} : { shotId: id(input.shotId) }), ...(input.mediaKind === undefined ? {} : { mediaKind: input.mediaKind as VisualProductionInputs['beginJob']['mediaKind'] }) })
    }
    case 'recordWorkflowDiscovery': {
      const value = object(input.discovery, ['status', 'connectionId', 'mediaKind', 'candidateCount', 'blockedCount', 'nextOffset', 'snapshotId', 'checkedAt', 'selectedWorkflow', 'message'])
      if (!['required', 'scanning', 'candidates', 'selected', 'no-match', 'blocked'].includes(String(value.status)) || !['image', 'video', 'audio'].includes(String(value.mediaKind))) invalid('工作流发现状态')
      if (typeof value.candidateCount !== 'number' || !Number.isSafeInteger(value.candidateCount) || value.candidateCount < 0
        || typeof value.blockedCount !== 'number' || !Number.isSafeInteger(value.blockedCount) || value.blockedCount < 0) invalid('工作流发现数量')
      if (value.nextOffset !== null && (typeof value.nextOffset !== 'number' || !Number.isSafeInteger(value.nextOffset) || value.nextOffset < 0)) invalid('工作流发现游标')
      const selected = value.selectedWorkflow === undefined ? undefined : object(value.selectedWorkflow, ['workflowId', 'workflowRevision', 'contentHash'])
      const selectedWorkflow = selected === undefined ? undefined : { workflowId: id(selected.workflowId), workflowRevision: revision(selected.workflowRevision), contentHash: string(selected.contentHash, '工作流内容哈希', 64) }
      if (selectedWorkflow && !/^[a-f0-9]{64}$/.test(selectedWorkflow.contentHash) || value.status === 'selected' && !selectedWorkflow) invalid('工作流选择身份')
      return result(method, { ...base, baseRevision: revision(input.baseRevision), jobId: id(input.jobId), discovery: {
        status: value.status as NonNullable<VisualJob['workflowDiscovery']>['status'], connectionId: externalMediaId(value.connectionId),
        mediaKind: value.mediaKind as VisualProductionMediaKind, candidateCount: value.candidateCount, blockedCount: value.blockedCount,
        nextOffset: value.nextOffset as number | null, ...(value.snapshotId === undefined ? {} : { snapshotId: string(value.snapshotId, '资源快照身份', 256) }),
        ...(value.checkedAt === undefined ? {} : { checkedAt: typeof value.checkedAt === 'number' && Number.isFinite(value.checkedAt) && value.checkedAt >= 0 ? value.checkedAt : invalid('工作流发现时间') }),
        ...(selectedWorkflow ? { selectedWorkflow } : {}), ...(value.message === undefined ? {} : { message: string(value.message, '工作流发现说明', 2000, true) }),
      } })
    }
    case 'referenceMedia': return result(method, { ...base, baseRevision: revision(input.baseRevision), jobId: id(input.jobId), mediaId: id(input.mediaId) })
    case 'proposeShot': {
      /** 一次提交所有替选，先去重校验再由宿主决定是否存在唯一画面。 */
      const primary = id(input.mediaId)
      const alternatives = input.alternativeMediaIds === undefined ? undefined : array(input.alternativeMediaIds, 15).map(id)
      unique([primary, ...(alternatives ?? [])])
      return result(method, { ...base, baseRevision: revision(input.baseRevision), jobId: id(input.jobId), shotId: id(input.shotId), mediaId: primary, ...(alternatives === undefined ? {} : { alternativeMediaIds: alternatives }), summary: string(input.summary, '候选说明', 2000) })
    }
    case 'proposeScript': return result(method, {
      ...base, baseRevision: revision(input.baseRevision), jobId: id(input.jobId), episodeId: id(input.episodeId),
      script: parseVisualEpisodeScript(input.script), summary: string(input.summary, '候选说明', 2000),
    })
    case 'reviewCandidate': return result(method, { ...base, baseRevision: revision(input.baseRevision), candidateId: id(input.candidateId), review: parseVisualCandidateReview(input.review) as VisualCandidateReviewInput })
    case 'updateJob': {
      if (!['preparing', 'generating', 'reviewing'].includes(String(input.stage))) return invalid('任务阶段无效')
      return result(method, { ...base, baseRevision: revision(input.baseRevision), jobId: id(input.jobId), stage: input.stage as VisualProductionInputs['updateJob']['stage'] })
    }
    case 'propose': return result(method, { ...base, baseRevision: revision(input.baseRevision), jobId: id(input.jobId), draft: parseVisualProductionDraft(input.draft), summary: string(input.summary, '候选说明', 2000) })
    case 'adopt': return result(method, { ...base, baseRevision: revision(input.baseRevision), candidateId: id(input.candidateId) })
    case 'discardCandidate': return result(method, { ...base, candidateId: id(input.candidateId) })
    case 'cancelJob': return result(method, { ...base, jobId: id(input.jobId) })
    case 'failJob': return result(method, { ...base, jobId: id(input.jobId), message: string(input.message, '失败说明', 2000) })
    case 'createRoughCut': return result(method, { ...base, episodeId: id(input.episodeId), baseProductionRevision: revision(input.baseProductionRevision) })
    case 'saveTimeline': return result(method, { ...base, episodeId: id(input.episodeId), expectedRevision: expectedRevision(input.expectedRevision, '时间线版本'), timeline: parseVisualEditingDocument(input.timeline) })
    case 'proposeTimelineEdit': return result(method, { ...base, episodeId: id(input.episodeId), expectedRevision: expectedRevision(input.expectedRevision, '时间线版本'), operations: parseVisualEditingOperations(input.operations), summary: string(input.summary, '时间线候选说明', 2000) })
    case 'adoptTimelineEdit': return result(method, { ...base, episodeId: id(input.episodeId), candidateId: id(input.candidateId), expectedRevision: expectedRevision(input.expectedRevision, '时间线版本') })
    case 'discardTimelineEdit': return result(method, { ...base, episodeId: id(input.episodeId), candidateId: id(input.candidateId) })
    case 'requestPreview': {
      /** 候选数量与片段长度双重设限，防止审片任务变为无界编码。 */
      const candidateIds = array(input.candidateIds, 8).map(id)
      if (!candidateIds.length || new Set(candidateIds).size !== candidateIds.length) return invalid('预览候选身份')
      const range = object(input.range, ['start', 'end'])
      if (typeof range.start !== 'number' || typeof range.end !== 'number' || !Number.isFinite(range.start) || !Number.isFinite(range.end) || range.start < 0 || range.end <= range.start || range.end - range.start > 60) return invalid('预览时间范围')
      return result(method, { ...base, baseRevision: revision(input.baseRevision), episodeId: id(input.episodeId), expectedTimelineRevision: expectedRevision(input.expectedTimelineRevision, '预览时间线版本'), candidateIds, range: { start: range.start, end: range.end }, settings: parseVisualEditingExportSettings(input.settings) })
    }
    case 'requestExport': return result(method, { ...base, episodeId: id(input.episodeId), expectedTimelineRevision: expectedRevision(input.expectedTimelineRevision, '导出时间线版本'), settings: parseVisualEditingExportSettings(input.settings) })
    case 'cancelExport': return result(method, { ...base, episodeId: id(input.episodeId), exportJobId: id(input.exportJobId) })
  }
}
