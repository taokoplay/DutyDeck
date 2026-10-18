import { Type } from 'typebox'
import type { TSchema } from 'typebox'
import { Value } from 'typebox/value'
import type { ToolDefinition } from '@earendil-works/pi-coding-agent'
import { parseVisualProductionCommand } from '@dutydeck/shared'
import type { VisualEditingTimelineSnapshot, VisualProductionInputs, VisualProductionMethod, VisualProductionResults, VisualProductionSnapshot } from '@dutydeck/shared'
/** 工具只能使用主运行时固定的会话身份。 */
export interface VisualProductionAgentToolOptions {
  sessionId: string
  sdk: Pick<typeof import('@earendil-works/pi-coding-agent'), 'defineTool'>
  execute<M extends VisualProductionMethod>(method: M, input: VisualProductionInputs[M], signal?: AbortSignal): Promise<VisualProductionResults[M]>
  assertAccess(write: boolean): void | Promise<void>
}
/** 纯读取不产生持久状态。 */
export const VISUAL_PRODUCTION_AGENT_READ_TOOL_NAMES = ['visual_production_open_context', 'visual_production_inspect_media', 'visual_production_close_context', 'visual_production_list', 'visual_production_read', 'visual_production_read_shot', 'visual_production_export_manifest', 'visual_production_media_catalog', 'visual_production_read_media_configuration', 'visual_production_read_timeline'] as const
/** 候选和媒体导入同样需要写权限；不暴露正式保存或采纳。 */
export const VISUAL_PRODUCTION_AGENT_WRITE_TOOL_NAMES = ['visual_production_record_observation', 'visual_production_create', 'visual_production_begin_job', 'visual_production_propose', 'visual_production_propose_shot', 'visual_production_propose_timeline_edit', 'visual_production_reference_media', 'visual_production_update_job', 'visual_production_fail_job', 'visual_production_cancel_job', 'visual_production_import_file', 'visual_production_import_media'] as const
/** 宿主权限包装使用精确工具白名单。 */
export const VISUAL_PRODUCTION_AGENT_TOOL_NAMES = [...VISUAL_PRODUCTION_AGENT_READ_TOOL_NAMES, ...VISUAL_PRODUCTION_AGENT_WRITE_TOOL_NAMES] as const
/** Agent 单次正文硬预算；历史候选正文始终不进入工具响应。 */
const MAX_AGENT_RESPONSE_CHARS = 48 * 1024
/** 分页参数仅属于模型读取呈现，不扩展宿主 IPC 权限。 */
interface ReadOptions { section?: 'overview' | 'episodes' | 'assets' | 'shots'; offset?: number; limit?: number }
/** 投影作品到有界 Agent 上下文，返回可继续读取的分页游标。 */
function projectSnapshot(snapshot: VisualProductionSnapshot, options: ReadOptions = {}): unknown {
  /** 历史只保留身份与结果摘要；草稿只通过 propose 提交、UI 预览。 */
  const candidates = snapshot.candidates.map(candidate => ({ id: candidate.id, baseRevision: candidate.baseRevision, jobId: candidate.jobId, status: candidate.status, summary: candidate.summary.slice(0, 160) }))
  const jobs = snapshot.jobs.map(job => ({ id: job.id, baseRevision: job.baseRevision, ...('compatibleRevision' in job && typeof job.compatibleRevision === 'number' ? { compatibleRevision: job.compatibleRevision } : {}), status: job.status, shotId: job.shotId }))
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
interface ShotReadOptions { referenceOffset?: number; referenceLimit?: number; textOffset?: number; textLimit?: number }
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
  /** 作品目标、配音、音乐、镜头三段正文和本页资产描述使用同一个文本游标。 */
  const { title, kind, brief, ratio, fps, voice, music } = snapshot.document
  const page = (textLimit: number) => {
    const mediaIds = new Set([shot.mediaId, ...assets.map(item => item.mediaId)])
    const total = Math.max(brief.length, voice.length, music.length, shot.scene.length, shot.motion.length, shot.dialogue.length, ...assets.map(item => item.description.length))
    const textOffset = Math.min(options.textOffset ?? 0, total)
    const end = Math.min(textOffset + textLimit, total)
    /** 同一字段按 textOffset 顺序拼接；较短字段的后续页为空字符串。 */
    const fragment = (value: string): string => value.slice(textOffset, end)
    return {
      productionId: snapshot.document.id, revision: snapshot.document.revision,
      settings: { title, kind, brief: fragment(brief), ratio, fps, voice: fragment(voice), music: fragment(music) },
      episode: snapshot.document.episodes.find(item => item.id === shot.episodeId),
      shot: { ...shot, scene: fragment(shot.scene), motion: fragment(shot.motion), dialogue: fragment(shot.dialogue), assetIds: assets.map(item => item.id) },
      state: snapshot.shotStates[shot.id], assets: assets.map(item => ({ ...item, description: fragment(item.description) })),
      media: snapshot.media.filter(item => mediaIds.has(item.id)),
      referencePage: { offset, total: shot.assetIds.length, nextOffset: offset + assets.length < shot.assetIds.length ? offset + assets.length : null },
      textPage: { offset: textOffset, total, nextOffset: end < total ? end : null },
      truncated: textOffset > 0 || end < total,
      guidance: 'shot.assetIds 与 assets 仅含本页引用。先保持 referenceOffset 不变，沿 textPage.nextOffset 用 textOffset 续读并拼接 settings.brief/voice/music、shot.scene/motion/dialogue 与各资产 description；读完文本后，沿 referencePage.nextOffset 继续引用页并将 textOffset 重置为0。所有页必须基于同一 revision，再开始生成。',
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
/** 时间线读取只返回结构化片段、来源 hash 和候选摘要，不携带媒体二进制。 */
function projectTimeline(snapshot: VisualEditingTimelineSnapshot): unknown {
  return {
    timeline: snapshot.timeline,
    needsReplacementClipIds: snapshot.needsReplacementClipIds,
    candidates: snapshot.candidates.map(candidate => ({ id: candidate.id, baseRevision: candidate.baseRevision, status: candidate.status, summary: candidate.summary, operations: candidate.operations })),
    exportJobs: snapshot.exportJobs.map(job => ({ id: job.id, timelineRevision: job.timelineRevision, status: job.status, message: job.message })),
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
    Type.Object({ type: Type.Literal('moveClip'), trackId: id, clipId: id, toIndex: Type.Integer({ minimum: 0 }) }),
    Type.Object({ type: Type.Literal('splitClip'), trackId: id, clipId: id, at: Type.Number({ minimum: 0 }) }),
    Type.Object({ type: Type.Literal('trimClip'), trackId: id, clipId: id, sourceIn: Type.Number({ minimum: 0 }), sourceOut: Type.Number({ minimum: 0 }) }),
    Type.Object({ type: Type.Literal('setVolume'), trackId: id, clipId: id, volume: Type.Number({ minimum: 0, maximum: 1 }) }),
    Type.Object({ type: Type.Literal('setCaption'), trackId: id, clipId: Type.Optional(id), text: Type.String(), start: Type.Number({ minimum: 0 }), duration: Type.Number({ minimum: 0 }) }),
    Type.Object({ type: Type.Literal('removeClip'), trackId: id, clipId: id }),
  ])
  const draft = Type.Object({ title: Type.String(), kind, brief: Type.String(), ratio: Type.String(), fps: Type.Number(), voice: Type.String(), music: Type.String(), episodes: Type.Array(Type.Object({ id, title: Type.String() })), assets: Type.Array(Type.Object({ id, name: Type.String(), type: Type.Union(['角色', '场景', '产品', '道具', '风格', '品牌', '声音'].map(value => Type.Literal(value))), description: Type.String(), locked: Type.Boolean(), mediaId })), shots: Type.Array(Type.Object({ id, episodeId: id, title: Type.String(), duration: Type.Number(), scene: Type.String(), motion: Type.String(), dialogue: Type.String(), assetIds: Type.Array(id), mediaId })) })
  const definitions: Array<{ name: string; method: VisualProductionMethod; description: string; fields: Record<string, TSchema>; write?: boolean }> = [
    { name: 'visual_production_list', method: 'list', description: '列出当前 Agent 项目下的影像作品。原画布与交互设计保持独立。', fields: {} },
    { name: 'visual_production_read', method: 'load', description: '读取正式作品。候选仅返回摘要；大型作品默认概览，使用section=episodes/assets/shots和offset/limit分页读取，nextOffset为空时结束。终态历史仅保留近期。先读当前版本再修改。', fields: { ...target, section: Type.Optional(Type.Union(['overview', 'episodes', 'assets', 'shots'].map(value => Type.Literal(value)))), offset: Type.Optional(Type.Integer({ minimum: 0, maximum: 10000 })), limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 50 })) } },
    { name: 'visual_production_read_shot', method: 'load', description: '读取目标镜头、作品设定及一页绑定资产和媒体身份。shot.assetIds仅含本页引用；先沿textPage.nextOffset用textOffset拼接完整长文本，再沿referencePage.nextOffset用referenceOffset续读引用并重置textOffset。所有页revision须一致。', fields: { ...target, shotId: id, referenceOffset: Type.Optional(Type.Integer({ minimum: 0, maximum: 200 })), referenceLimit: Type.Optional(Type.Integer({ minimum: 1, maximum: 20 })), textOffset: Type.Optional(Type.Integer({ minimum: 0, maximum: 16000 })), textLimit: Type.Optional(Type.Integer({ minimum: 1, maximum: 16000 })) } },
    { name: 'visual_production_media_catalog', method: 'mediaCatalog', description: '分页读取API模型与ComfyUI服务。connection条目仅表示允许向该服务寻找对应类别工作流，不证明服务器具备该输出能力；不枚举模板，不自动配对服务与模板。available仅表示本地配置有效，未验证在线或节点模型。已保存的旧固定工作流按精确版本兼容。制作仍须符合当前作品启用范围。', fields: { ...target, offset: Type.Optional(Type.Integer({ minimum: 0 })), limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 20 })) } },
    { name: 'visual_production_read_media_configuration', method: 'load', description: '分页读取作品制作配置、默认来源及参数。未配置表示继承全局可用目录；显式空entries禁止生成。先begin_job冻结配置；API模型用media_prepare_generation。ComfyUI由Agent选工作流：优先使用对应类别的默认服务，显式传connectionId给media_discover_workflows，按任务、输出类型、参考数量和输入角色分页筛选；用候选descriptor和contentHash调用media_use_remote_workflow，再media_inspect_workflow核对真实输入、节点、模型，最后以回执中的精确workflowId/revision准备media_prepare_run。影像任务不传canvasId或targetNodeId。不得按名称默认选第一项或擅自切到未授权服务；目录失败不能当作无匹配，真实无匹配时说明缺口并遵循已有媒体授权策略。旧固定工作流保持精确版本与参数。多个活动任务提供visualJobId。配置参数自动补入，可用当次inputs覆盖；超出参考上限须说明，不得悄悄拼图或丢弃参考。', fields: { ...target, offset: Type.Optional(Type.Integer({ minimum: 0 })), limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 20 })) } },
    { name: 'visual_production_read_timeline', method: 'loadTimeline', description: '读取指定集的剪辑时间线、片段来源版本、待替换提示和候选摘要。只返回结构化元数据，不读取媒体二进制。', fields: { ...target, episodeId: id } },
    { name: 'visual_production_create', method: 'create', description: '创建用户明确要求的新影像作品。', fields: { title: Type.String(), kind }, write: true },
    { name: 'visual_production_begin_job', method: 'beginJob', description: '冻结当前正式版本与制作配置并登记本会话生成任务；shotId 限定为只修改一个镜头。后续媒体准备按冻结方案执行，多个活动任务须向媒体工具提供visualJobId。', fields: { ...base, instruction: Type.String(), shotId: Type.Optional(id) }, write: true },
    { name: 'visual_production_reference_media', method: 'referenceMedia', description: '把本轮任务允许使用的正式镜头或绑定资产媒体转换为完整 MediaAssetRef，供 media_prepare_generation 的 inputs.reference 使用；不会生成，不返回路径。必须沿用返回引用的全部字段。', fields: { ...base, jobId: id, mediaId: id }, write: true },
    { name: 'visual_production_update_job', method: 'updateJob', description: '记录本轮真实制作阶段：preparing 准备参考，generating 执行媒体工具，reviewing 检查产物；不代表供应商百分比或生成成功。终态不可恢复，重试须新建任务。', fields: { ...base, jobId: id, stage: Type.Union(['preparing', 'generating', 'reviewing'].map(value => Type.Literal(value))) }, write: true },
    { name: 'visual_production_propose_shot', method: 'proposeShot', description: '真实产物经 import_media/import_file 导入后，仅替换本轮单镜头任务的输出并提交候选；主mediaId为首选，alternativeMediaIds最多15个替选，宿主保留设定、资产、排序和其他镜头。空镜头且只有一个输出时宿主可自动采用；已有画面或多个输出仍由用户选择。', fields: { ...base, jobId: id, shotId: id, mediaId: id, alternativeMediaIds, summary: Type.String() }, write: true },
    { name: 'visual_production_propose', method: 'propose', description: '提交本会话任务的完整候选，保留锁定资产与任务范围。仅为空镜头填入唯一图片时宿主可自动采用，返回 adopted 后需重读正式版本；涉及规划、资产、设定或多图的候选由用户在影像面板采用。真实生成媒体须先通过既有媒体工具执行并导入副本；禁止把占位符描述成完成生成。', fields: { ...base, jobId: id, draft, summary: Type.String() }, write: true },
    { name: 'visual_production_propose_timeline_edit', method: 'proposeTimelineEdit', description: '根据当前集剪辑时间线提出结构化修改候选，不直接修改正式时间线。候选必须基于最新 timeline revision；用户在剪辑面板预览并采用。', fields: { ...target, episodeId: id, expectedRevision: Type.Integer({ minimum: 1 }), operations: Type.Array(timelineOperation, { maxItems: 100 }), summary: Type.String() }, write: true },
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
        /** read_shot 是有界呈现，不给底层 load 增加未声明参数。 */
        const { shotId: readShotId, referenceOffset, referenceLimit, textOffset, textLimit, ...loadFields } = fields
        const command = parseVisualProductionCommand({ method: definition.method, input: { ...(definition.name === 'visual_production_read_shot' ? loadFields : fields), sessionId: options.sessionId } })
        const result = await options.execute(command.method, command.input, signal)
        signal?.throwIfAborted()
        /** 每种写操作也避免将完整历史草稿回传上下文。 */
        let response: unknown = result
        if (definition.name === 'visual_production_read_shot') response = projectShot(result as VisualProductionSnapshot, readShotId as string, { referenceOffset, referenceLimit, textOffset, textLimit } as ShotReadOptions)
        else if (command.method === 'loadTimeline') response = projectTimeline(result as VisualEditingTimelineSnapshot)
        else if (command.method === 'load' || command.method === 'create' || command.method === 'failJob' || command.method === 'cancelJob') response = projectSnapshot(result as VisualProductionSnapshot, { section, offset, limit } as ReadOptions)
        if (definition.name === 'visual_production_read_media_configuration' || command.method === 'mediaCatalog') {
          /** 配置与目录按实际JSON长度分页，避免大型工作流参数挤爆上下文。 */
          const configuration = definition.name === 'visual_production_read_media_configuration' ? (result as VisualProductionSnapshot).mediaConfiguration : undefined
          const entries = command.method === 'mediaCatalog' ? result as VisualProductionResults['mediaCatalog'] : configuration?.entries ?? []
          const start = Math.min(typeof offset === 'number' ? offset : 0, entries.length)
          const items: unknown[] = []
          const page = { revision: configuration?.revision ?? 0, defaults: configuration?.defaults ?? {}, inherited: definition.name === 'visual_production_read_media_configuration' && !configuration, entries: items, total: entries.length, nextOffset: null as number | null }
          for (const entry of entries.slice(start, start + (typeof limit === 'number' ? limit : 10))) {
            items.push(entry)
            if (JSON.stringify(page).length > MAX_AGENT_RESPONSE_CHARS - 64) { items.pop(); break }
          }
          if (items.length === 0 && start < entries.length) throw new Error('单条制作配置超过工具读取预算，请缩短配置参数')
          page.nextOffset = start + items.length < entries.length ? start + items.length : null
          response = page
        }
        if (command.method === 'propose' || command.method === 'proposeShot') {
          const { draft: _draft, ...summary } = result as VisualProductionResults['propose']
          response = summary
        }
        if (command.method === 'proposeTimelineEdit') {
          const { timeline: _timeline, operations: _operations, ...summary } = result as VisualProductionResults['proposeTimelineEdit']
          response = summary
        }
        const text = JSON.stringify(response)
        if (text.length > MAX_AGENT_RESPONSE_CHARS && command.method !== 'exportManifest') throw new Error('影像工具响应超过预算，请缩小读取范围')
        return { content: [{ type: 'text' as const, text }], details: response }
      },
    })
  })
}
