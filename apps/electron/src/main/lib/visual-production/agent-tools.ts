import { Type } from 'typebox'
import type { TSchema } from 'typebox'
import { Value } from 'typebox/value'
import type { ToolDefinition } from '@earendil-works/pi-coding-agent'
import { parseVisualProductionCommand } from '@proma/shared'
import type { VisualProductionInputs, VisualProductionMethod, VisualProductionResults, VisualProductionSnapshot } from '@proma/shared'
/** 工具只能使用主运行时固定的会话身份。 */
export interface VisualProductionAgentToolOptions {
  sessionId: string
  sdk: Pick<typeof import('@earendil-works/pi-coding-agent'), 'defineTool'>
  execute<M extends VisualProductionMethod>(method: M, input: VisualProductionInputs[M], signal?: AbortSignal): Promise<VisualProductionResults[M]>
  assertAccess(write: boolean): void | Promise<void>
}
/** 纯读取不产生持久状态。 */
export const VISUAL_PRODUCTION_AGENT_READ_TOOL_NAMES = ['visual_production_list', 'visual_production_read', 'visual_production_export_manifest'] as const
/** 候选和媒体导入同样需要写权限；不暴露正式保存或采纳。 */
export const VISUAL_PRODUCTION_AGENT_WRITE_TOOL_NAMES = ['visual_production_create', 'visual_production_begin_job', 'visual_production_propose', 'visual_production_fail_job', 'visual_production_cancel_job', 'visual_production_import_file', 'visual_production_import_media'] as const
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
  const jobs = snapshot.jobs.map(job => ({ id: job.id, baseRevision: job.baseRevision, status: job.status, shotId: job.shotId }))
  const full = { ...snapshot, candidates, jobs }
  if (!options.section && JSON.stringify(full).length <= MAX_AGENT_RESPONSE_CHARS) return full
  /** 概览不含镜头长描述；分页支持重建完整正式草稿。 */
  const { episodes, assets, shots, ...production } = snapshot.document
  const overview = { production, counts: { episodes: episodes.length, assets: assets.length, shots: shots.length, media: snapshot.media.length, candidates: candidates.length, jobs: jobs.length }, candidates: candidates.slice(-8), jobs: jobs.slice(-8), section: 'overview', guidance: '使用 section=episodes/assets/shots 和 offset/limit 分页读取。终态任务及候选仅有界保留近期记录。' }
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
/** 创建固定领域操作；严格解析器再次验证完整输入。 */
export function buildVisualProductionAgentTools(options: VisualProductionAgentToolOptions): ToolDefinition[] {
  /** 通用身份与正式版本字段。 */
  const id = Type.String({ minLength: 1, maxLength: 128 })
  const revision = Type.Integer({ minimum: 1 })
  const target = { productionId: id }
  const base = { ...target, baseRevision: revision }
  const kind = Type.Union(['comic', 'film', 'promo', 'image'].map(value => Type.Literal(value)))
  const mediaId = Type.Union([id, Type.Null()])
  const draft = Type.Object({ title: Type.String(), kind, brief: Type.String(), ratio: Type.String(), fps: Type.Number(), voice: Type.String(), music: Type.String(), episodes: Type.Array(Type.Object({ id, title: Type.String() })), assets: Type.Array(Type.Object({ id, name: Type.String(), type: Type.Union(['角色', '场景', '产品', '道具', '风格', '品牌', '声音'].map(value => Type.Literal(value))), description: Type.String(), locked: Type.Boolean(), mediaId })), shots: Type.Array(Type.Object({ id, episodeId: id, title: Type.String(), duration: Type.Number(), scene: Type.String(), motion: Type.String(), dialogue: Type.String(), assetIds: Type.Array(id), mediaId })) })
  const definitions: Array<{ name: string; method: VisualProductionMethod; description: string; fields: Record<string, TSchema>; write?: boolean }> = [
    { name: 'visual_production_list', method: 'list', description: '列出当前 Agent 项目下的影像作品。原画布与交互设计保持独立。', fields: {} },
    { name: 'visual_production_read', method: 'load', description: '读取正式作品。候选仅返回摘要；大型作品默认概览，使用section=episodes/assets/shots和offset/limit分页读取，nextOffset为空时结束。终态历史仅保留近期。先读当前版本再修改。', fields: { ...target, section: Type.Optional(Type.Union(['overview', 'episodes', 'assets', 'shots'].map(value => Type.Literal(value)))), offset: Type.Optional(Type.Integer({ minimum: 0, maximum: 10000 })), limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 50 })) } },
    { name: 'visual_production_create', method: 'create', description: '创建用户明确要求的新影像作品。', fields: { title: Type.String(), kind }, write: true },
    { name: 'visual_production_begin_job', method: 'beginJob', description: '冻结当前正式版本并登记本会话生成任务；shotId 限定为只修改一个镜头。', fields: { ...base, instruction: Type.String(), shotId: Type.Optional(id) }, write: true },
    { name: 'visual_production_propose', method: 'propose', description: '提交本会话任务的完整候选，不修改正式版。保留锁定资产与任务范围。真实生成媒体须先通过既有媒体工具执行并导入副本；禁止把占位符描述成完成生成。用户在影像面板采纳。', fields: { ...base, jobId: id, draft, summary: Type.String() }, write: true },
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
        const command = parseVisualProductionCommand({ method: definition.method, input: { ...fields, sessionId: options.sessionId } })
        const result = await options.execute(command.method, command.input, signal)
        signal?.throwIfAborted()
        /** 每种写操作也避免将完整历史草稿回传上下文。 */
        let response: unknown = result
        if (command.method === 'load' || command.method === 'create' || command.method === 'failJob' || command.method === 'cancelJob') response = projectSnapshot(result as VisualProductionSnapshot, { section, offset, limit } as ReadOptions)
        if (command.method === 'propose') {
          const { draft: _draft, ...summary } = result as VisualProductionResults['propose']
          response = summary
        }
        const text = JSON.stringify(response)
        if (text.length > MAX_AGENT_RESPONSE_CHARS && command.method !== 'exportManifest') throw new Error('影像工具响应超过预算，请缩小读取范围')
        return { content: [{ type: 'text' as const, text }], details: response }
      },
    })
  })
}
