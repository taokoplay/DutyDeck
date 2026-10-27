import { Type } from 'typebox'
import type { TSchema } from 'typebox'
import { Value } from 'typebox/value'
import type { ToolDefinition } from '@earendil-works/pi-coding-agent'
import { parseVisualProductionCommand, resolveVisualShotOutputs, VISUAL_SHOT_ACTION_PHASES, VISUAL_SHOT_AUDIO_TRANSITIONS } from '@dutydeck/shared'
import type { VisualEditingTimelineSnapshot, VisualJob, VisualProductionInputs, VisualProductionMethod, VisualProductionResults, VisualProductionSnapshot } from '@dutydeck/shared'
/** 工具只能使用主运行时固定的会话身份。 */
export interface VisualProductionAgentToolOptions {
  sessionId: string
  sdk: Pick<typeof import('@earendil-works/pi-coding-agent'), 'defineTool'>
  execute<M extends VisualProductionMethod>(method: M, input: VisualProductionInputs[M], signal?: AbortSignal): Promise<VisualProductionResults[M]>
  assertAccess(write: boolean): void | Promise<void>
}
/** 纯读取不产生持久状态。 */
export const VISUAL_PRODUCTION_AGENT_READ_TOOL_NAMES = ['visual_production_open_context', 'visual_production_inspect_media', 'visual_production_close_context', 'visual_production_list', 'visual_production_read', 'visual_production_read_script', 'visual_production_read_shot', 'visual_production_export_manifest', 'visual_production_media_catalog', 'visual_production_read_media_configuration', 'visual_production_read_timeline', 'visual_production_list_export_jobs'] as const
/** 候选、媒体导入和明确授权的候选采纳需要写权限。 */
export const VISUAL_PRODUCTION_AGENT_WRITE_TOOL_NAMES = ['visual_production_record_observation', 'visual_production_create', 'visual_production_begin_job', 'visual_production_update_shot_plan', 'visual_production_record_workflow_discovery', 'visual_production_propose', 'visual_production_propose_script', 'visual_production_propose_shot', 'visual_production_review_candidate', 'visual_production_adopt_candidate', 'visual_production_create_rough_cut', 'visual_production_propose_timeline_edit', 'visual_production_adopt_timeline_edit', 'visual_production_request_export', 'visual_production_request_preview', 'visual_production_cancel_export', 'visual_production_reference_media', 'visual_production_update_job', 'visual_production_fail_job', 'visual_production_cancel_job', 'visual_production_import_file', 'visual_production_import_media'] as const
/** 宿主权限包装使用精确工具白名单。 */
export const VISUAL_PRODUCTION_AGENT_TOOL_NAMES = [...VISUAL_PRODUCTION_AGENT_READ_TOOL_NAMES, ...VISUAL_PRODUCTION_AGENT_WRITE_TOOL_NAMES] as const
/** Agent 单次正文硬预算；历史候选正文始终不进入工具响应。 */
const MAX_AGENT_RESPONSE_CHARS = 48 * 1024
/** 分页参数仅属于模型读取呈现，不扩展宿主 IPC 权限。 */
interface ReadOptions { section?: 'overview' | 'episodes' | 'assets' | 'shots'; offset?: number; limit?: number }
/** 投影作品到有界 Agent 上下文，返回可继续读取的分页游标。 */
function projectSnapshot(snapshot: VisualProductionSnapshot, options: ReadOptions = {}): unknown {
  /** 历史只保留身份与结果摘要；草稿只通过 propose 提交、UI 预览。 */
  const candidates = snapshot.candidates.map(candidate => ({ id: candidate.id, baseRevision: candidate.baseRevision, jobId: candidate.jobId, status: candidate.status, summary: candidate.summary.slice(0, 160), ...(candidate.reviewRequired ? { reviewRequired: true } : {}), ...(candidate.reviewAudioRequired ? { reviewAudioRequired: true } : {}), ...(candidate.review ? { review: candidate.review } : {}) }))
  const jobs = snapshot.jobs.map(job => ({ id: job.id, baseRevision: job.baseRevision, ...(job.compatibleRevision === undefined ? {} : { compatibleRevision: job.compatibleRevision }), status: job.status, ...(job.mediaKind === undefined ? {} : { mediaKind: job.mediaKind }), ...(job.workflowDiscovery === undefined ? {} : { workflowDiscovery: job.workflowDiscovery }), shotId: job.shotId }))
  const full = { ...snapshot, candidates, jobs }
  if (!options.section && JSON.stringify(full).length <= MAX_AGENT_RESPONSE_CHARS) return full
  /** 概览不含镜头长描述；分页支持重建完整正式草稿。 */
  const { episodes, assets, shots, ...production } = snapshot.document
  const overview = { production, mediaConfiguration: snapshot.mediaConfiguration ? { revision: snapshot.mediaConfiguration.revision, defaults: snapshot.mediaConfiguration.defaults, entryCount: snapshot.mediaConfiguration.entries.length, guidance: '使用 visual_production_read_media_configuration 分页读取已启用方案与默认参数。' } : { inherited: true }, counts: { episodes: episodes.length, assets: assets.length, shots: shots.length, media: snapshot.media.length, candidates: candidates.length, jobs: jobs.length }, candidates: candidates.slice(-8), jobs: jobs.slice(-8), section: 'overview', guidance: '使用 section=episodes/assets/shots 和 offset/limit 分页读取。终态任务及候选仅有界保留近期记录。' }
  if (!options.section || options.section === 'overview') return overview
  const source = snapshot.document[options.section]
  const offset = Math.min(options.offset ?? 0, source.length)
  const limit = options.limit ?? 20
  const items: unknown[] = []
  const result = { productionId: snapshot.document.id, revision: snapshot.document.revision, section: options.section, offset, total: source.length, items, nextOffset: null as number | null }
  for (const item of source.slice(offset, offset + limit)) {
    items.push(item)
    if (JSON.stringify(result).length > MAX_AGENT_RESPONSE_CHARS - 64) { items.pop(); break }
  }
  result.nextOffset = offset + items.length < source.length ? offset + items.length : null
  if (!items.length && offset < source.length) throw new Error('单条影像内容超过工具读取预算')
  return result
}
/** 镜头引用与长文本分页只影响工具呈现，不改变正式绑定关系或制作正文。 */
interface ShotReadOptions { referenceOffset?: number; referenceLimit?: number; textOffset?: number; textLimit?: number; /** 显式请求时才将作品长正文纳入分页。 */ includeProductionText?: boolean }
/** 返回目标镜头上下文；先读完本页长文本，再继续下一页引用，能够完整重建所有约束。 */
function projectShot(snapshot: VisualProductionSnapshot, shotId: string, options: ShotReadOptions = {}): unknown {
  /** 目标身份只在当前作品中解析，不允许数组下标漂移。 */
  const shot = snapshot.document.shots.find(item => item.id === shotId)
  if (!shot) throw new Error('镜头不存在')
  /** 按镜头绑定顺序分页；索引避免逐条遍历整个作品资产库。 */
  const assetIndex = new Map(snapshot.document.assets.map(item => [item.id, item]))
  const offset = Math.min(options.referenceOffset ?? 0, shot.assetIds.length)
  const assets = shot.assetIds.slice(offset, offset + (options.referenceLimit ?? 20)).map(id => {
    const asset = assetIndex.get(id)
    if (!asset) throw new Error('镜头引用资产不存在')
    return { ...asset, version: snapshot.assetVersions[id] }
  })
  /** 默认只分页镜头与资产约束；全局创作正文由调用方显式选择，避免重复占用上下文。 */
  const { title, kind, brief, ratio, fps, voice, music } = snapshot.document
  /** 在回执中明确标识全局正文是否包含，不能以空字符串冒充已读取。 */
  const productionTextIncluded = options.includeProductionText === true
  const page = (textLimit: number) => {
    const mediaIds = new Set([...Object.values(resolveVisualShotOutputs(shot, new Map(snapshot.media.map(item => [item.id, item])))), ...assets.map(item => item.mediaId)])
    const total = Math.max(...(productionTextIncluded ? [brief.length, voice.length, music.length] : []), shot.scene.length, shot.motion.length, shot.dialogue.length, shot.soundDesign?.effects.length ?? 0, shot.soundDesign?.music.length ?? 0, ...assets.map(item => item.description.length))
    const textOffset = Math.min(options.textOffset ?? 0, total)
    const end = Math.min(textOffset + textLimit, total)
    /** 同一字段按 textOffset 顺序拼接；较短字段的后续页为空字符串。 */
    const fragment = (value: string): string => value.slice(textOffset, end)
    /** 镜头读取只带剧本摘要；完整节拍由 read_script 分页，避免单次响应被长剧本挤爆。 */
    const sourceEpisode = snapshot.document.episodes.find(item => item.id === shot.episodeId)
    const episode = sourceEpisode ? {
      ...sourceEpisode,
      ...(sourceEpisode.script ? { script: {
        logline: sourceEpisode.script.logline,
        audiencePromise: sourceEpisode.script.audiencePromise,
        targetDurationSeconds: sourceEpisode.script.targetDurationSeconds,
        beatCount: sourceEpisode.script.beats.length,
      } } : {}),
    } : undefined
    return {
      productionId: snapshot.document.id, revision: snapshot.document.revision,
      productionTextIncluded,
      settings: { title, kind, ratio, fps, ...(productionTextIncluded ? { brief: fragment(brief), voice: fragment(voice), music: fragment(music) } : {}) },
      episode,
      shot: { ...shot, scene: fragment(shot.scene), motion: fragment(shot.motion), dialogue: fragment(shot.dialogue), ...(shot.soundDesign ? { soundDesign: { effects: fragment(shot.soundDesign.effects), music: fragment(shot.soundDesign.music) } } : {}), assetIds: assets.map(item => item.id) },
      state: snapshot.shotStates[shot.id], assets: assets.map(item => ({ ...item, description: fragment(item.description) })),
      media: snapshot.media.filter(item => mediaIds.has(item.id)),
      referencePage: { offset, total: shot.assetIds.length, nextOffset: offset + assets.length < shot.assetIds.length ? offset + assets.length : null },
      textPage: { offset: textOffset, total, nextOffset: end < total ? end : null },
      truncated: textOffset > 0 || end < total,
      guidance: 'productionTextIncluded 标明是否包含作品正文；尚未取得当前 revision 全局 brief/voice/music 约束时，显式传 includeProductionText=true，从 textOffset=0 分页读取并拼接 settings.brief/voice/music，续页保持该参数不变。全局正文已完整读取后，其他镜头省略该参数或传false，避免重复加载作品说明。shot.assetIds 与 assets 仅含本页引用。先保持 referenceOffset 不变，沿 textPage.nextOffset 用 textOffset 续读并拼接 shot.scene/motion/dialogue、shot.soundDesign.effects/music（若存在）与各资产 description；完整剧本节拍使用 visual_production_read_script。读完文本后，沿 referencePage.nextOffset 继续引用页并将 textOffset 重置为0。所有页必须基于同一 revision，再开始生成。',
    }
  }
  /** 先按不含长文本的元数据确定引用页大小，避免文本续页过程中引用游标漂移。 */
  while (assets.length > 1 && JSON.stringify(page(0)).length > MAX_AGENT_RESPONSE_CHARS - 1024) assets.pop()
  /** 根据实际 JSON 长度缩小文本页；换行和控制字符的转义膨胀也计入预算。 */
  let textLimit = options.textLimit ?? 16000
  let result = page(textLimit)
  while (textLimit > 1 && JSON.stringify(result).length > MAX_AGENT_RESPONSE_CHARS) {
    textLimit = Math.max(1, Math.floor(textLimit / 2))
    result = page(textLimit)
  }
  return result
}
/**
 * 返回一集结构化剧本和映射镜头摘要。
 * @param snapshot 当前正式作品。
 * @param episodeId 目标集数。
 * @param offset 节拍起始位置。
 * @param limit 本页最多返回的节拍数量。
 * @returns 有界剧本页；未结构化时返回空状态和现有镜头供 Agent 整理。
 */
function projectScript(snapshot: VisualProductionSnapshot, episodeId: string, offset = 0, limit = 10): unknown {
  const episode = snapshot.document.episodes.find(item => item.id === episodeId)
  if (!episode) throw new Error('剧本所属集数不存在')
  const shots = snapshot.document.shots.filter(item => item.episodeId === episodeId)
  const shotById = new Map(shots.map(item => [item.id, item]))
  const beats = episode.script?.beats ?? []
  const start = Math.min(offset, beats.length)
  const items: unknown[] = []
  const result = {
    productionId: snapshot.document.id,
    revision: snapshot.document.revision,
    episode: { id: episode.id, title: episode.title },
    script: episode.script ? {
      logline: episode.script.logline,
      audiencePromise: episode.script.audiencePromise,
      hook: episode.script.hook,
      turningPoint: episode.script.turningPoint,
      payoff: episode.script.payoff,
      targetDurationSeconds: episode.script.targetDurationSeconds,
      productionNotes: episode.script.productionNotes,
      totalBeats: beats.length,
    } : null,
    beats: items,
    offset: start,
    nextOffset: null as number | null,
    shots: shots.map(shot => ({ id: shot.id, title: shot.title, duration: shot.duration, hasVideoPlan: Boolean(shot.videoPlan), assetIds: shot.assetIds })),
    guidance: episode.script
      ? '沿 nextOffset 读取全部节拍。剧本负责因果、观众问题、视觉动作方向、声音与连续性；精确 scene/motion/dialogue/soundDesign/videoPlan 仍以镜头为准。'
      : '该集尚无结构化剧本。综合作品 brief 与现有镜头生成节拍，使用 proposeScript 提交整集剧本候选；不得覆盖正式镜头。',
  }
  for (const beat of beats.slice(start, start + Math.max(1, Math.min(limit, 20)))) {
    items.push({ ...beat, shots: beat.shotIds.flatMap(id => {
      const shot = shotById.get(id)
      return shot ? [{ id: shot.id, title: shot.title, duration: shot.duration }] : []
    }) })
    if (JSON.stringify(result).length > MAX_AGENT_RESPONSE_CHARS - 64) {
      items.pop()
      break
    }
  }
  if (!items.length && start < beats.length) throw new Error('单条剧本节拍超过工具读取预算，请缩短字段后重试')
  result.nextOffset = start + items.length < beats.length ? start + items.length : null
  return result
}
/** 时间线读取只返回结构化片段、来源 hash 和候选摘要，不携带媒体二进制。 */
function projectTimeline(snapshot: VisualEditingTimelineSnapshot): unknown {
  return {
    timeline: snapshot.timeline,
    needsReplacementClipIds: snapshot.needsReplacementClipIds,
    candidates: snapshot.candidates.map(candidate => ({ id: candidate.id, baseRevision: candidate.baseRevision, status: candidate.status, summary: candidate.summary, operations: candidate.operations })),
    exportJobs: snapshot.exportJobs.map(job => ({ id: job.id, timelineRevision: job.timelineRevision, status: job.status, message: job.message })),
  }
}
/** 时间线写回执只返回版本、轨道关系和任务状态，完整片段正文由 read_timeline 获取。 */
function projectTimelineWriteResult(snapshot: VisualEditingTimelineSnapshot): unknown {
  const { timeline } = snapshot
  return {
    timeline: timeline ? {
      id: timeline.id,
      productionId: timeline.productionId,
      episodeId: timeline.episodeId,
      revision: timeline.revision,
      baseProductionRevision: timeline.baseProductionRevision,
      duration: timeline.duration,
      updatedAt: timeline.updatedAt,
      tracks: timeline.tracks.map(track => ({ id: track.id, kind: track.kind, clipCount: track.clips.length })),
    } : null,
    needsReplacementClipIds: snapshot.needsReplacementClipIds,
    candidates: snapshot.candidates.map(candidate => ({ id: candidate.id, baseRevision: candidate.baseRevision, status: candidate.status, summary: candidate.summary })),
    exportJobs: snapshot.exportJobs.map(job => ({ id: job.id, timelineRevision: job.timelineRevision, status: job.status, message: job.message })),
    guidance: '写回执不重复完整片段正文；需要继续编辑或核对来源时重新调用 visual_production_read_timeline。',
  }
}
/** 创建固定领域操作；严格解析器再次验证完整输入。 */
export function buildVisualProductionAgentTools(options: VisualProductionAgentToolOptions): ToolDefinition[] {
  /** 通用身份与正式版本字段。 */
  const id = Type.String({ minLength: 1, maxLength: 128 })
  const revision = Type.Integer({ minimum: 1 })
  const target = { productionId: id }
  const base = { ...target, baseRevision: revision }
  const kind = Type.Union(['comic', 'film', 'promo', 'image'].map(value => Type.Literal(value)))
  const mediaId = Type.Union([id, Type.Null()])
  const alternativeMediaIds = Type.Optional(Type.Array(id, { maxItems: 15 }))
  /** Agent 可提出的有限时间线操作，宿主还会用 shared parser 复核。 */
  const timelineOperation = Type.Union([
    Type.Object({ type: Type.Literal('replaceClipSource'), trackId: id, clipId: id, source: Type.Object({ type: Type.Literal('shot-media'), shotId: id, mediaId: id, mediaHash: Type.String({ pattern: '^[a-f0-9]{64}$' }), shotOutputVersion: Type.Integer({ minimum: 0 }) }) }),
    Type.Object({ type: Type.Literal('insertAudioClip'), trackId: id, kind: Type.Union([Type.Literal('voice'), Type.Literal('music')]), clipId: Type.Optional(id), source: Type.Object({ type: Type.Literal('shot-media'), shotId: id, mediaId: id, mediaHash: Type.String({ pattern: '^[a-f0-9]{64}$' }), shotOutputVersion: Type.Integer({ minimum: 0 }) }), start: Type.Number({ minimum: 0 }), sourceIn: Type.Number({ minimum: 0 }), sourceOut: Type.Number({ minimum: 0 }), volume: Type.Optional(Type.Number({ minimum: 0, maximum: 1 })), label: Type.String({ minLength: 1, maxLength: 200 }) }),
    Type.Object({ type: Type.Literal('moveClip'), trackId: id, clipId: id, toIndex: Type.Integer({ minimum: 0 }) }),
    Type.Object({ type: Type.Literal('splitClip'), trackId: id, clipId: id, at: Type.Number({ minimum: 0 }) }),
    Type.Object({ type: Type.Literal('trimClip'), trackId: id, clipId: id, sourceIn: Type.Number({ minimum: 0 }), sourceOut: Type.Number({ minimum: 0 }) }),
    Type.Object({ type: Type.Literal('setVolume'), trackId: id, clipId: id, volume: Type.Number({ minimum: 0, maximum: 1 }) }),
    Type.Object({ type: Type.Literal('setCaption'), trackId: id, clipId: Type.Optional(id), text: Type.String(), start: Type.Number({ minimum: 0 }), duration: Type.Number({ minimum: 0 }) }),
    Type.Object({ type: Type.Literal('removeClip'), trackId: id, clipId: id }),
  ])
  /** 媒体候选保留三门兼容，新增声音门用于独立音频验收。 */
  const reviewStatus = Type.Union(['pending', 'passed', 'warning', 'failed'].map(value => Type.Literal(value)))
  const reviewGate = Type.Union(['technical', 'motion', 'continuity', 'audio'].map(value => Type.Literal(value)))
  const candidateReview = Type.Object({
    technical: reviewStatus,
    motion: reviewStatus,
    continuity: reviewStatus,
    audio: Type.Optional(reviewStatus),
    conclusion: Type.String({ minLength: 1, maxLength: 4000 }),
    unchecked: Type.Array(Type.String({ maxLength: 1000 }), { maxItems: 16 }),
    issues: Type.Array(Type.Object({ gate: reviewGate, severity: Type.Union([Type.Literal('warning'), Type.Literal('error')]), message: Type.String({ minLength: 1, maxLength: 1000 }), atSeconds: Type.Optional(Type.Number({ minimum: 0, maximum: 600 })) }), { maxItems: 32 }),
  })
  /** 剧本节拍只约束叙事与拍摄意图，镜头仍是逐帧制作的权威字段。 */
  const scriptBeat = Type.Object({
    id,
    title: Type.String({ minLength: 1, maxLength: 120 }),
    purpose: Type.Union(['hook', 'setup', 'inciting-incident', 'rising-action', 'reveal', 'turn', 'resolution', 'tag'].map(value => Type.Literal(value))),
    dramaticQuestion: Type.String({ maxLength: 4000 }),
    synopsis: Type.String({ maxLength: 8000 }),
    visualAction: Type.String({ maxLength: 8000 }),
    dialogue: Type.String({ maxLength: 8000 }),
    sound: Type.String({ maxLength: 4000 }),
    continuity: Type.String({ maxLength: 8000 }),
    shotIds: Type.Array(id, { maxItems: 300 }),
  })
  const episodeScript = Type.Object({
    logline: Type.String({ maxLength: 2000 }), audiencePromise: Type.String({ maxLength: 4000 }),
    hook: Type.String({ maxLength: 4000 }), turningPoint: Type.String({ maxLength: 4000 }), payoff: Type.String({ maxLength: 4000 }),
    targetDurationSeconds: Type.Number({ minimum: 0, maximum: 3600 }), productionNotes: Type.String({ maxLength: 16000 }),
    beats: Type.Array(scriptBeat, { maxItems: 100 }),
  })
  /** 连贯性合同在工具层显式建模，Agent 不能只写一段自由文本说明转场。 */
  const shotContinuityPlan = Type.Object({
    entryState: Type.String({ minLength: 1, maxLength: 4000 }),
    exitState: Type.String({ minLength: 1, maxLength: 4000 }),
    anchors: Type.Array(Type.Object({
      phase: Type.Union(VISUAL_SHOT_ACTION_PHASES.map(value => Type.Literal(value))),
      state: Type.String({ minLength: 1, maxLength: 2000 }),
      assetId: Type.Union([id, Type.Null()]),
    }), { maxItems: 12 }),
    audioTransition: Type.Union(VISUAL_SHOT_AUDIO_TRANSITIONS.map(value => Type.Literal(value))),
    rationale: Type.String({ minLength: 1, maxLength: 2000 }),
  })
  const continuityPlan = Type.Optional(shotContinuityPlan)
  /** 视频计划同时供整稿候选和单镜头计划写入复用，避免两种 schema 漂移。 */
  const shotVideoPlan = Type.Object({
    mode: Type.Union(['text-to-video', 'image-to-video', 'first-last-frame'].map(value => Type.Literal(value))),
    firstFrameAssetId: Type.Union([id, Type.Null()]),
    lastFrameAssetId: Type.Union([id, Type.Null()]),
    transitionIn: Type.Union(['hard-cut', 'match-cut', 'dissolve'].map(value => Type.Literal(value))),
    rationale: Type.String({ minLength: 1, maxLength: 2000 }),
  })
  /** 计划引用只能登记本作品已导入媒体，不能在工具参数中写入任意路径。 */
  const shotPlanReference = Type.Object({
    assetId: id,
    mediaId: id,
    name: Type.String({ minLength: 1, maxLength: 120 }),
    type: Type.Union(['角色', '场景', '产品', '道具', '风格', '品牌', '声音'].map(value => Type.Literal(value))),
    description: Type.String({ maxLength: 8000 }),
  })
  const draft = Type.Object({ title: Type.String(), kind, brief: Type.String(), ratio: Type.String(), fps: Type.Number(), voice: Type.String(), music: Type.String(), episodes: Type.Array(Type.Object({ id, title: Type.String(), script: Type.Optional(episodeScript) })), assets: Type.Array(Type.Object({ id, name: Type.String(), type: Type.Union(['角色', '场景', '产品', '道具', '风格', '品牌', '声音'].map(value => Type.Literal(value))), description: Type.String(), locked: Type.Boolean(), mediaId })), shots: Type.Array(Type.Object({ id, episodeId: id, title: Type.String(), duration: Type.Number(), scene: Type.String(), motion: Type.String(), dialogue: Type.String(), soundDesign: Type.Optional(Type.Object({ effects: Type.String({ maxLength: 8000 }), music: Type.String({ maxLength: 8000 }) })), continuityPlan, videoPlan: Type.Optional(shotVideoPlan), assetIds: Type.Array(id), mediaId, outputs: Type.Optional(Type.Object({ image: mediaId, video: mediaId, audio: mediaId })) })) })
  const definitions: Array<{ name: string; method: VisualProductionMethod; description: string; fields: Record<string, TSchema>; write?: boolean }> = [
    { name: 'visual_production_list', method: 'list', description: '列出当前 Agent 项目下的影像作品。原画布与交互设计保持独立。', fields: {} },
    { name: 'visual_production_read', method: 'load', description: '读取正式作品。候选仅返回摘要；大型作品默认概览，使用section=episodes/assets/shots和offset/limit分页读取，nextOffset为空时结束。终态历史仅保留近期。先读当前版本再修改。', fields: { ...target, section: Type.Optional(Type.Union(['overview', 'episodes', 'assets', 'shots'].map(value => Type.Literal(value)))), offset: Type.Optional(Type.Integer({ minimum: 0, maximum: 10000 })), limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 50 })) } },
    { name: 'visual_production_read_script', method: 'load', description: '分页读取一集结构化剧本、观众承诺、钩子、转折、阶段结果、拍摄总要求与镜头映射。未结构化时返回现有镜头摘要。先读取完整剧本和当前镜头，再提交整集剧本候选。', fields: { ...target, episodeId: id, offset: Type.Optional(Type.Integer({ minimum: 0, maximum: 100 })), limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 20 })) } },
    { name: 'visual_production_read_shot', method: 'load', description: '读取目标镜头、一页绑定资产与媒体身份；默认作品设定仅含title/kind/ratio/fps，productionTextIncluded明确标记是否含全局正文。尚未取得当前revision作品brief/voice/music时传includeProductionText=true，并在该次所有续页保持此参数；已完整读取全局正文后，其他镜头省略或传false，避免重复加载作品说明。shot.assetIds仅含本页引用；先沿textPage.nextOffset用textOffset拼接完整长文本，再沿referencePage.nextOffset用referenceOffset续读引用并重置textOffset。所有页revision须一致。', fields: { ...target, shotId: id, includeProductionText: Type.Optional(Type.Boolean()), referenceOffset: Type.Optional(Type.Integer({ minimum: 0, maximum: 200 })), referenceLimit: Type.Optional(Type.Integer({ minimum: 1, maximum: 20 })), textOffset: Type.Optional(Type.Integer({ minimum: 0, maximum: 16000 })), textLimit: Type.Optional(Type.Integer({ minimum: 1, maximum: 16000 })) } },
    { name: 'visual_production_media_catalog', method: 'mediaCatalog', description: '分页读取API模型与ComfyUI服务。connection条目仅表示允许向该服务寻找对应类别工作流，不证明服务器具备该输出能力；不枚举模板，不自动配对服务与模板。available仅表示本地配置有效，未验证在线或节点模型。已保存的旧固定工作流按精确版本兼容。制作仍须符合当前作品启用范围。', fields: { ...target, offset: Type.Optional(Type.Integer({ minimum: 0 })), limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 20 })) } },
    { name: 'visual_production_read_media_configuration', method: 'load', description: '分页读取作品制作配置、默认来源及参数；传jobId读取当前会话该任务的冻结配置，不能用新配置替代。未配置表示继承全局可用目录；显式空entries禁止生成。先begin_job冻结配置；API模型用media_prepare_generation。ComfyUI由Agent选工作流：优先使用对应类别的默认服务，显式传connectionId给media_discover_workflows，按任务、输出类型、参考数量和输入角色分页筛选；用候选descriptor和contentHash调用media_use_remote_workflow，再media_inspect_workflow核对真实输入、节点、模型，最后以回执中的精确workflowId/revision准备media_prepare_run。影像任务不传canvasId或targetNodeId。不得按名称默认选第一项或擅自切到未授权服务；目录失败不能当作无匹配，真实无匹配时说明缺口并遵循已有媒体授权策略。旧固定工作流保持精确版本与参数。多个活动任务提供visualJobId。配置参数自动补入，可用当次inputs覆盖；超出参考上限须说明，不得悄悄拼图或丢弃参考。', fields: { ...target, jobId: Type.Optional(id), offset: Type.Optional(Type.Integer({ minimum: 0 })), limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 20 })) } },
    { name: 'visual_production_read_timeline', method: 'loadTimeline', description: '读取指定集的剪辑时间线、片段来源版本、待替换提示和候选摘要。只返回结构化元数据，不读取媒体二进制。', fields: { ...target, episodeId: id } },
    { name: 'visual_production_list_export_jobs', method: 'listExportJobs', description: '读取指定集已登记的成片导出任务及真实终态；不读取或导出媒体二进制。', fields: { ...target, episodeId: id } },
    { name: 'visual_production_create', method: 'create', description: '创建用户明确要求的新影像作品。', fields: { title: Type.String(), kind }, write: true },
    { name: 'visual_production_begin_job', method: 'beginJob', description: '冻结当前正式版本与制作配置并登记本会话生成任务；shotId 限定为只修改一个镜头，mediaKind 明确本任务制作图片、视频、音频或混合内容。ComfyUI 默认来源会登记工作流发现要求。后续媒体准备按冻结方案执行，多个活动任务须向媒体工具提供visualJobId。', fields: { ...base, instruction: Type.String(), shotId: Type.Optional(id), mediaKind: Type.Optional(Type.Union(['image', 'video', 'audio', 'mixed'].map(value => Type.Literal(value)))) }, write: true },
    { name: 'visual_production_update_shot_plan', method: 'updateShotPlan', description: '原子保存单个镜头的视频生成计划与连续性合同，返回新正式版本，不修改剧情、其他镜头或现有资产。用户明确要求生成或直接优化时，先 read_shot 取最新 revision；若视频准备返回 VIDEO_PLAN_REQUIRED，立即调用本工具写入计划，再重新 begin_job，禁止改试无 job、Canvas 或其他绕过路径。references 只用于把本作品已导入的首帧、尾帧或动作锚点媒体登记为非锁定资产并加入目标镜头引用。', fields: { ...base, shotId: id, videoPlan: shotVideoPlan, continuityPlan: shotContinuityPlan, references: Type.Optional(Type.Array(shotPlanReference, { maxItems: 12 })) }, write: true },
    { name: 'visual_production_record_workflow_discovery', method: 'recordWorkflowDiscovery', description: '保存本轮 ComfyUI 工作流发现的最终审计结论。media_discover_workflows 会由宿主自动写入扫描页；当完整目录确无语义匹配时提交 no-match，当服务或工作流无法读取且无法继续时提交 blocked，并写明具体原因。选中工作流必须改用 media_use_remote_workflow，让宿主从真实回执写入精确版本和 contentHash；此工具不能伪造 selected。', fields: { ...base, jobId: id, status: Type.Union([Type.Literal('no-match'), Type.Literal('blocked')]), connectionId: id, mediaKind: Type.Union(['image', 'video', 'audio'].map(value => Type.Literal(value))), candidateCount: Type.Integer({ minimum: 0 }), blockedCount: Type.Integer({ minimum: 0 }), nextOffset: Type.Union([Type.Integer({ minimum: 0 }), Type.Null()]), snapshotId: Type.Optional(Type.String({ minLength: 1, maxLength: 256 })), message: Type.String({ minLength: 1, maxLength: 2000 }) }, write: true },
    { name: 'visual_production_reference_media', method: 'referenceMedia', description: '把本轮任务允许使用的正式镜头或绑定资产媒体转换为完整 MediaAssetRef，供 media_prepare_generation 的 inputs.reference 使用；调用时必须包装为 { kind: "asset", asset: <完整引用> }，不会生成，不返回路径。必须沿用返回引用的全部字段。', fields: { ...base, jobId: id, mediaId: id }, write: true },
    { name: 'visual_production_update_job', method: 'updateJob', description: '记录本轮真实制作阶段：preparing 准备参考，generating 执行媒体工具，reviewing 检查产物；不代表供应商百分比或生成成功。终态不可恢复，重试须新建任务。', fields: { ...base, jobId: id, stage: Type.Union(['preparing', 'generating', 'reviewing'].map(value => Type.Literal(value))) }, write: true },
    { name: 'visual_production_propose_script', method: 'proposeScript', description: '提交一集结构化剧本候选，不修改正式镜头或媒体。先综合作品 brief、现有镜头、资产与创作边界，覆盖开场钩子、因果推进、核心转折、阶段结果、观众问题、视觉动作方向、声音和连续性，并把每个节拍映射到真实 shotId。精确 scene、motion、dialogue、soundDesign、continuityPlan 和 videoPlan 仍写镜头；剧本不能另造事实或把未生成内容写成已完成。任务需要推进正式剧本时，重新读取最新 revision 后用 adopt_candidate 采用精确候选。', fields: { ...base, jobId: id, episodeId: id, script: episodeScript, summary: Type.String({ minLength: 1, maxLength: 2000 }) }, write: true },
    { name: 'visual_production_propose_shot', method: 'proposeShot', description: '真实产物经 import_media/import_file 导入后，按媒体类型仅替换本轮单镜头的画面、影片或音频槽并提交候选，保留另外两种输出；主mediaId为首选，alternativeMediaIds最多15个替选，宿主保留设定、资产、排序和其他镜头。影片或音频候选提交后必须调用 visual_production_review_candidate 完成技术与内容审核，新增音频还需 audio 门通过；未通过前不能采用。画面候选保持原流程。空画面槽且只有一个图片输出时宿主可自动采用；已有画面或多个输出保留候选供精确采用。', fields: { ...base, jobId: id, shotId: id, mediaId: id, alternativeMediaIds, summary: Type.String() }, write: true },
    { name: 'visual_production_review_candidate', method: 'reviewCandidate', description: '影片或音频候选提交后，由当前 Agent 在同一任务中检查真实产物并保存审核。打开绑定 candidateId、revision、媒体hash和必要前后镜头的上下文，inspect 实际样本并记录观察。technical 检查解码/时长/规格；motion 检查必需视角、动作次序、物理和生成瑕疵；continuity 检查叙事、身份、道具、轴线、切点和声音接续；新增音频候选必须提供 audio，核对完整听验、准确台词/说话者、旁白与内心声、声线语气、可懂度、拟音/环境声/音效/音乐、同步及混音。纯音频不适用的 motion 项须在结论说明。未实际听验时 audio=pending；ASR、波形、AAC或抽帧不等于听验。问题写 gate、severity、message 和可定位 atSeconds；未覆盖范围写 unchecked。已证实缺失用户关键内容必须对应门 failed+error，不能用 warning 放行；warning 只表示轻微瑕疵，证据不足保持 pending。失败后把“问题→依据→最小修正→继承约束→新指令→复验标准”落实到新任务，在剩余授权/预算内定向优化，不重复提交未知状态请求。该工具只保存审核，不生成媒体或扩大授权。', fields: { ...base, candidateId: id, review: candidateReview }, write: true },
    { name: 'visual_production_adopt_candidate', method: 'adopt', description: '在当前用户任务需要推进正式内容时采用精确候选。先读取最新正式版本并确认 candidateId、baseRevision、审核与任务范围仍有效；有多个真实替选且需要用户审美选择时可先保留候选并说明差异。该工具不能绕过视频审核、版本冲突或锁定资产授权：若候选修改锁定角色/资产，宿主会自动弹出一次性精确权限卡并等待用户决定。', fields: { ...base, candidateId: id }, write: true },
    { name: 'visual_production_propose', method: 'propose', description: '提交本会话任务的完整候选，保留未要求修改的内容与任务范围；用户目标明确要求调整锁定资产时，可在候选中写明精确新值，正式采用阶段再由宿主请求一次性授权。正式开始生成前，Agent 必须同时写入 continuityPlan 与 videoPlan：continuityPlan 描述入场状态、出场状态、复杂动作中间锚点、声音接续（声音先入/延续/对白跨切点）和判断依据，锚点资产必须加入该镜头 assetIds；videoPlan 根据同样的动作与空间判断选择生成方式。无需画面锚点时用 text-to-video；只有起点画面时用 image-to-video；需要约束结束状态时用 first-last-frame，并把首尾帧资产加入该镜头 assetIds；transitionIn 只表达剪辑入场方式，硬切、匹配剪辑或叠化独立于视频模型输入。镜头显式包含 outputs 时，mediaId 必须同步等于 outputs.video ?? outputs.image ?? null；修改独立槽时保留其他槽，不能只改 mediaId。仅为空镜头填入唯一图片时宿主可自动采用，返回 adopted 后需重读正式版本；其他候选可由 Agent 在任务范围内采用，存在多个替选需要比较时保留给用户选择。真实生成媒体须先通过既有媒体工具执行并导入副本；禁止把占位符描述为完成生成。', fields: { ...base, jobId: id, draft, summary: Type.String() }, write: true },
    { name: 'visual_production_create_rough_cut', method: 'createRoughCut', description: '按当前集已采用的镜头媒体建立初始剪辑时间线；已存在时间线时保留正式版本并返回现状。', fields: { ...target, episodeId: id, baseProductionRevision: revision }, write: true },
    { name: 'visual_production_propose_timeline_edit', method: 'proposeTimelineEdit', description: '根据当前集剪辑时间线提出结构化修改候选，不直接修改正式时间线。insertAudioClip 可按绝对 start 插入当前镜头已采用音频到 voice/music 轨，必要时创建轨道；replaceClipSource 仅更新指定片段同镜头当前已采用来源，保留剪点。所有 source 必须填写正式媒体 id/hash 和当前 shotOutputVersion，画面优先已采用视频，音轨使用已采用音频。新源较短时同批 trimClip 到有效范围，否则拒绝。候选必须基于最新 timeline revision；返回 candidateId 后可在任务需要推进正式剪辑时用 adopt_timeline_edit 采用。', fields: { ...target, episodeId: id, expectedRevision: Type.Integer({ minimum: 1 }), operations: Type.Array(timelineOperation, { maxItems: 100 }), summary: Type.String() }, write: true },
    { name: 'visual_production_adopt_timeline_edit', method: 'adoptTimelineEdit', description: '在任务需要推进正式剪辑时采用精确时间线候选。先读取最新时间线并确认 candidateId 与 expectedRevision 仍有效，再原子采用；不能绕过时间线版本冲突。', fields: { ...target, episodeId: id, candidateId: id, expectedRevision: revision }, write: true },
    { name: 'visual_production_request_preview', method: 'requestPreview', description: '请求影像模块原生候选审片，仅本机编码，不调用外部生成。允许未采用甚至审核 failed 的候选对比，不放宽采用门禁；冻结作品/时间线 revision、candidateIds、来源 hash 和最多60秒范围，回执交由 list_export_jobs 核验。先让候选预览在模块内可见，再审核和定向修正；不得用外部或/tmp影片冒充模块交付。', fields: { ...target, baseRevision: revision, episodeId: id, expectedTimelineRevision: revision, candidateIds: Type.Array(id, { minItems: 1, maxItems: 8, uniqueItems: true }), range: Type.Object({ start: Type.Number({ minimum: 0 }), end: Type.Number({ exclusiveMinimum: 0 }) }, { additionalProperties: false }), settings: Type.Object({ ratio: Type.String({ minLength: 1, maxLength: 32 }), fps: Type.Number({ minimum: 1, maximum: 240 }), includeVoice: Type.Boolean(), includeMusic: Type.Boolean(), includeCaptions: Type.Boolean() }) }, write: true },
    { name: 'visual_production_request_export', method: 'requestExport', description: '冻结当前正式时间线 revision、媒体 hash 和导出设置后请求真实 MP4 导出；随后用 list_export_jobs 核对终态。编码器缺失、排队中或失败时不得把清单、静帧或请求冒充已交付成片。', fields: { ...target, episodeId: id, expectedTimelineRevision: revision, settings: Type.Object({ ratio: Type.String({ minLength: 1, maxLength: 32 }), fps: Type.Number({ minimum: 1, maximum: 240 }), includeVoice: Type.Boolean(), includeMusic: Type.Boolean(), includeCaptions: Type.Boolean() }) }, write: true },
    { name: 'visual_production_cancel_export', method: 'cancelExport', description: '取消指定集仍可取消的成片导出任务。', fields: { ...target, episodeId: id, exportJobId: id }, write: true },
    { name: 'visual_production_fail_job', method: 'failJob', description: '记录当前会话任务的失败原因，不重试外部调用。', fields: { ...target, jobId: id, message: Type.String() }, write: true },
    { name: 'visual_production_cancel_job', method: 'cancelJob', description: '取消当前会话任务，迟到结果不得登记。', fields: { ...target, jobId: id }, write: true },
    { name: 'visual_production_import_file', method: 'importFile', description: '从已授权项目相对路径复制真实媒体到作品独立素材库。', fields: { ...target, relativePath: Type.String() }, write: true },
    { name: 'visual_production_import_media', method: 'importMedia', description: '按媒体服务返回的可信身份复制素材，校验项目、版本与 hash；不直接引用旧画布路径。', fields: { ...target, reference: Type.Object({ assetId: id, revision, hash: Type.String(), mediaKind: Type.Union([Type.Literal('image'), Type.Literal('video'), Type.Literal('audio')]) }) }, write: true },
    { name: 'visual_production_export_manifest', method: 'exportManifest', description: '导出当前正式版 JSON 制作清单，不代表已经渲染或交付视频文件。', fields: target },
  ]
  return definitions.map(definition => {
    const parameters = Type.Object(definition.fields, { additionalProperties: false })
    return options.sdk.defineTool({ name: definition.name, label: definition.name, description: definition.description, parameters,
      async execute(_callId, input, signal) {
        signal?.throwIfAborted()
        await options.assertAccess(Boolean(definition.write))
        signal?.throwIfAborted()
        if (!Value.Check(parameters, input)) throw new Error('VISUAL_PRODUCTION_INVALID_INPUT')
        const { section, offset, limit, ...fields } = input
        /** 剧本读取使用同一 load 命令，但以独立节拍分页呈现。 */
        const { episodeId: readEpisodeId, ...scriptLoadFields } = fields
        /** read_shot 是有界呈现，不给底层 load 增加未声明参数。 */
        const { shotId: readShotId, referenceOffset, referenceLimit, textOffset, textLimit, includeProductionText, ...loadFields } = fields
        /** 冻结配置的任务身份仅用于已授权快照投影，不扩展底层 load IPC 参数。 */
        const { jobId: configJobId, ...configLoadFields } = fields
        /** 工作流发现结论只接受 Agent 的语义判断字段，时间由宿主写入可信当前时间。 */
        const { productionId: workflowProductionId, baseRevision: workflowBaseRevision, jobId: workflowJobId, ...workflowDiscovery } = fields
        const commandInput = definition.name === 'visual_production_record_workflow_discovery'
          ? {
              sessionId: options.sessionId, productionId: workflowProductionId, baseRevision: workflowBaseRevision, jobId: workflowJobId,
              discovery: { ...workflowDiscovery, checkedAt: Date.now() },
            }
          : { ...(definition.name === 'visual_production_read_media_configuration' ? configLoadFields : definition.name === 'visual_production_read_shot' ? loadFields : definition.name === 'visual_production_read_script' ? scriptLoadFields : fields), sessionId: options.sessionId }
        const command = parseVisualProductionCommand({ method: definition.method, input: commandInput })
        const result = await options.execute(command.method, command.input, signal)
        signal?.throwIfAborted()
        /** 每种写操作也避免将完整历史草稿回传上下文。 */
        let response: unknown = result
        if (definition.name === 'visual_production_read_script') response = projectScript(result as VisualProductionSnapshot, readEpisodeId as string, typeof offset === 'number' ? offset : undefined, typeof limit === 'number' ? limit : undefined)
        else if (definition.name === 'visual_production_read_shot') response = projectShot(result as VisualProductionSnapshot, readShotId as string, { referenceOffset, referenceLimit, textOffset, textLimit, includeProductionText } as ShotReadOptions)
        else if (command.method === 'loadTimeline') response = projectTimeline(result as VisualEditingTimelineSnapshot)
        else if (command.method === 'load' || command.method === 'create' || command.method === 'failJob' || command.method === 'cancelJob') response = projectSnapshot(result as VisualProductionSnapshot, { section, offset, limit } as ReadOptions)
        if (command.method === 'adopt') {
          /** 采用已完成后只确认精确候选与新版本，避免长正文导致回执超预算而误报失败。 */
          const snapshot = result as VisualProductionSnapshot
          /** 按身份查找本次候选，不能把其他候选的采用结果混入回执。 */
          const candidate = snapshot.candidates.find(item => item.id === fields.candidateId)
          response = {
            production: { id: snapshot.document.id, revision: snapshot.document.revision },
            candidates: candidate ? [{ id: candidate.id, baseRevision: candidate.baseRevision, jobId: candidate.jobId, status: candidate.status }] : [],
            guidance: '正式内容已由宿主处理；继续操作前使用 read_shot 或分页 read 读取最新目标。',
          }
        }
        if (definition.name === 'visual_production_read_media_configuration' || command.method === 'mediaCatalog') {
          /** 配置与目录按实际JSON长度分页，避免大型工作流参数挤爆上下文。 */
          const snapshot = definition.name === 'visual_production_read_media_configuration' ? result as VisualProductionSnapshot : undefined
          /** 任务归属由宿主固定会话验证；旧任务无冻结配置时保留继承语义。 */
          const job = configJobId === undefined ? undefined : snapshot?.jobs.find(item => item.id === configJobId && item.sessionId === options.sessionId)
          if (snapshot && configJobId !== undefined && !job) throw new Error('任务不存在或不属于当前会话')
          /** 只在未指定任务时读取当前配置，绝不为旧任务静默替换参数。 */
          const configuration = configJobId === undefined ? snapshot?.mediaConfiguration : job?.mediaConfiguration
          const entries = command.method === 'mediaCatalog' ? result as VisualProductionResults['mediaCatalog'] : configuration?.entries ?? []
          const start = Math.min(typeof offset === 'number' ? offset : 0, entries.length)
          const items: unknown[] = []
          const page = { ...(job ? { jobId: job.id } : {}), revision: configuration?.revision ?? 0, defaults: configuration?.defaults ?? {}, inherited: definition.name === 'visual_production_read_media_configuration' && !configuration, entries: items, total: entries.length, nextOffset: null as number | null }
          for (const entry of entries.slice(start, start + (typeof limit === 'number' ? limit : 10))) {
            items.push(entry)
            if (JSON.stringify(page).length > MAX_AGENT_RESPONSE_CHARS - 64) { items.pop(); break }
          }
          if (items.length === 0 && start < entries.length) throw new Error('单条制作配置超过工具读取预算，请缩短配置参数')
          page.nextOffset = start + items.length < entries.length ? start + items.length : null
          response = page
        }
        if (command.method === 'beginJob' || command.method === 'updateJob') {
          /** 阶段回执保留任务身份与状态；完整冻结参数按 jobId 分页读取。 */
          const { mediaConfiguration, ...summary } = result as VisualJob
          response = {
            ...summary,
            mediaConfiguration: mediaConfiguration ? { revision: mediaConfiguration.revision, defaults: mediaConfiguration.defaults, entryCount: mediaConfiguration.entries.length } : { inherited: true },
            guidance: '任务已记录；仅在缺少参数时用 visual_production_read_media_configuration 和本任务 jobId 分页读取冻结配置，不重复扫描完整目录。',
          }
        }
        if (command.method === 'propose' || command.method === 'proposeScript' || command.method === 'proposeShot') {
          const { draft: _draft, ...summary } = result as VisualProductionResults['propose']
          response = summary
        }
        if (command.method === 'reviewCandidate') {
          /** 审核回执只返回状态和结论，不重复完整创作草稿。 */
          const { draft: _draft, ...summary } = result as VisualProductionResults['reviewCandidate']
          response = summary
        }
        if (command.method === 'recordWorkflowDiscovery') {
          /** 回执只返回持久化后的发现状态，避免重复返回整个任务上下文。 */
          const job = result as VisualJob
          response = { jobId: job.id, mediaKind: job.mediaKind, workflowDiscovery: job.workflowDiscovery }
        }
        if (command.method === 'updateShotPlan') {
          /** 计划写入只回传目标镜头与新版本，避免把整部作品再次塞入上下文。 */
          const snapshot = result as VisualProductionSnapshot
          const shot = snapshot.document.shots.find(item => item.id === (fields as { shotId: string }).shotId)
          response = {
            productionId: snapshot.document.id,
            revision: snapshot.document.revision,
            shot: shot ? {
              id: shot.id,
              title: shot.title,
              assetIds: shot.assetIds,
              videoPlan: shot.videoPlan,
              continuityPlan: shot.continuityPlan,
            } : undefined,
          }
        }
        if (command.method === 'proposeTimelineEdit') {
          const { timeline: _timeline, operations: _operations, ...summary } = result as VisualProductionResults['proposeTimelineEdit']
          response = summary
        }
        if (command.method === 'createRoughCut' || command.method === 'adoptTimelineEdit') {
          /** 时间线写入只返回版本、轨道关系和任务摘要，完整片段正文由读取工具获取。 */
          response = projectTimelineWriteResult(result as VisualProductionResults['createRoughCut'])
        }
        const text = JSON.stringify(response)
        if (text.length > MAX_AGENT_RESPONSE_CHARS && command.method !== 'exportManifest') throw new Error('影像工具响应超过预算，请缩小读取范围')
        return { content: [{ type: 'text' as const, text }], details: response }
      },
    })
  })
}
