/** 影像生成执行所需的宿主工具；缺失时不能把模块显示为可执行。 */
export const VISUAL_PRODUCTION_EXECUTE_TOOLS = [
  'visual_production_read',
  'visual_production_read_script',
  'visual_production_read_shot',
  'visual_production_read_timeline',
  'visual_production_list_export_jobs',
  'visual_production_begin_job',
  'visual_production_update_shot_plan',
  'visual_production_propose_script',
  'visual_production_record_workflow_discovery',
  'visual_production_reference_media',
  'visual_production_propose_shot',
  'visual_production_review_candidate',
  'visual_production_adopt_candidate',
  'visual_production_create_rough_cut',
  'visual_production_propose_timeline_edit',
  'visual_production_adopt_timeline_edit',
  'visual_production_request_export',
  'visual_production_request_preview',
  'visual_production_cancel_export',
  'visual_production_import_file',
  'visual_production_import_media',
  'media_list_models',
  'media_prepare_generation',
  'media_execute_generation',
  'media_wait_generation',
  'media_import_local_file',
  'media_list_assets',
  'media_get_asset_file',
  'media_discover_workflows',
  'media_inspect_workflow',
  'media_prepare_run',
  'media_execute_run',
  'media_wait_run',
] as const

/** 计划模式只读取作品、目录与工作流定义，不要求执行和写入工具。 */
export const VISUAL_PRODUCTION_PLAN_TOOLS = [
  'visual_production_read',
  'visual_production_read_script',
  'visual_production_read_shot',
  'visual_production_read_timeline',
  'visual_production_list_export_jobs',
  'visual_production_media_catalog',
  'media_list_models',
] as const

/** 本轮工具就绪状态；required 与 missing 用于运行日志和明确错误。 */
export interface VisualProductionToolingState {
  status: 'ready' | 'incomplete'
  required: string[]
  missing: string[]
}

/** 工具缺失使用稳定错误码，Renderer 和 Agent 不解析自然语言猜测原因。 */
export class VisualProductionToolingError extends Error {
  readonly code = 'VISUAL_PRODUCTION_TOOLING_UNAVAILABLE'
  readonly missing: readonly string[]

  constructor(missing: readonly string[]) {
    super(`VISUAL_PRODUCTION_TOOLING_UNAVAILABLE: 缺少影像创作工具 ${missing.join(', ')}`)
    this.name = 'VisualProductionToolingError'
    this.missing = missing
  }
}

/**
 * 比较模块要求与本轮最终注册的工具名。
 * @param toolNames 最终准备交给 Agent 的工具名。
 * @param permissionMode 计划模式只检查读取能力。
 * @param assertReady 为 true 时在缺失工具上抛出稳定错误。
 * @returns 可写入运行日志的审计结果。
 */
export function assessVisualProductionTooling(
  toolNames: readonly string[],
  permissionMode: 'plan' | 'execute',
  assertReady = false,
): VisualProductionToolingState {
  const required = [...(permissionMode === 'plan' ? VISUAL_PRODUCTION_PLAN_TOOLS : VISUAL_PRODUCTION_EXECUTE_TOOLS)]
  const available = new Set(toolNames)
  const missing = required.filter(name => !available.has(name))
  if (assertReady && missing.length) throw new VisualProductionToolingError(missing)
  return { status: missing.length ? 'incomplete' : 'ready', required, missing }
}

/**
 * 将实际注册的影像工具写入单轮系统提示，避免模型依据历史上下文误报工具缺失。
 * @param state 当前工具审计结果。
 * @returns 紧凑的可用性约束；无相关工具时为空。
 */
export function buildVisualProductionToolingPrompt(state: VisualProductionToolingState): string {
  const tools = state.required.filter(name => !state.missing.includes(name))
  if (!tools.length) return ''
  /** 依据所选模式的要求判断权限，缺失工具不能让执行模式冒充计划模式。 */
  const planning = !state.required.includes('visual_production_begin_job')
  return `<visual_production_tooling>\n本轮已由宿主注册以下影像与媒体工具：${tools.join(', ')}。\n${planning ? '当前为计划模式：仅使用本轮读取与能力发现工具，不创建任务、提交候选、采用、生成媒体或导出；创作与制作建议不表示已经执行。' : '当前为执行模式：仅执行用户要求且已获授权的阶段，具体顺序遵守影像执行与质量合同。'}\n模块已启用不代表历史运行或子会话拥有相同工具；禁止根据历史上下文判断工具缺失，只有当前调用返回结构化不可用错误时才能报告缺失并保留错误码。子 Agent 和委派会话不自动继承专业模块工具。媒体运行的 projectId 是工作区 ID，不是影像作品或 Canvas ID；来源须核对影像 job、候选和 mediaExecutions，不能仅凭 projectId 或 canvas.json 归类。\n</visual_production_tooling>`
}
