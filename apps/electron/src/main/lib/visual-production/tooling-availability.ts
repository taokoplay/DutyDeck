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
  return `<visual_production_tooling>\n本轮已由宿主注册以下影像与媒体工具：${tools.join(', ')}。\n模块已启用不代表工作台或历史运行一定拥有全部工具；本轮必须依据这份实际清单调用。禁止根据历史上下文判断工具缺失；只有实际调用返回结构化不可用错误时，才能报告缺失，并保留错误码。子 Agent 和委派会话不会自动继承父会话的专业模块工具，不能把子会话的工具缺失推断成主 Agent 缺失。媒体运行记录中的 projectId 是工作区 ID，不是 Canvas 或影像作品 ID；判断产物来源必须核对影像作品的 job、候选和 mediaExecutions，不能仅凭 projectId 或 canvas.json 归类。\n影像 Agent 可以完成作品、剧本、镜头计划、媒体生成、候选审核、精确采纳、粗剪、时间线修改和导出请求等全部步骤。普通操作在用户任务范围内直接执行，不额外请求确认；只有锁定角色或资产的正式变更由宿主自动弹出项目原生权限卡，Agent 必须等待宿主返回，不能自行宣称获批，也不存在永久或绕过授权。\n媒体任务执行后由 Host 托管等待终态；不要用 media_wait_run 高频刷新进度，也不要因此维持一个没有交付价值的工具循环。Agent 应结束当前工具步骤，Host 会在成功、失败或取消后自动续行；只有诊断明确需要当前瞬时进度时才读取一次。\n视频生成必须先检查一集结构化剧本：用 visual_production_read_script 读取叙事与镜头映射；缺失或需要重构时，综合作品 brief 和现有镜头，用 visual_production_propose_script 提交整集候选。任务需要推进正式内容时，重新读取最新 revision 后用 visual_production_adopt_candidate 采用精确候选；有多个真实替选需要用户比较时可以保留候选并说明差异。剧本要写明钩子、因果、转折、阶段结果、观众问题、视觉动作方向、声音、连续性和目标时长，不能只扩写画面。\n单镜生成前必须从镜头读取或写入 continuityPlan：明确继承的入场状态、交给下一镜的出场状态、复杂动作的关键中间态和声音接续。画面转场只写 videoPlan.transitionIn；声音先入、延续或对白跨切点写 continuityPlan.audioTransition。复杂动作优先建立可读中间锚点，不能只凭首尾帧推断全过程。若 videoPlan 或 continuityPlan 缺失，先 read_shot 取最新 revision，再用 visual_production_update_shot_plan 原子写入目标镜头计划；references 可把本作品已导入的首尾帧媒体登记为镜头资产。成功后重新 begin_job。VIDEO_PLAN_REQUIRED 只能这样解决，不得改试无 job、Canvas 或其他绕过路径。\n剪辑按 visual_production_read_timeline → visual_production_create_rough_cut → visual_production_propose_timeline_edit → visual_production_adopt_timeline_edit 执行，所有 revision 与 candidateId 必须来自本次读取。需要成片时使用 visual_production_request_export 冻结正式时间线，再用 visual_production_list_export_jobs 核对真实终态；编码器缺失、排队中或失败都不能宣称已经交付成片。\n当视频默认方案是 ComfyUI connection 时，连接已接入不等于工作流已验证。不要等待用户切换 Canvas 或提供服务器地址；同一 Agent 应调用 media_discover_workflows(connectionId, mediaKind=video, inputKinds=实际首尾帧角色, refresh=true)，再调用 media_inspect_workflow 核对输入、输出、模型、分辨率和时长。选中候选后使用 media_use_remote_workflow 写入真实身份；若完整目录确无语义匹配或服务不可用，使用 visual_production_record_workflow_discovery 保存 no-match/blocked 及原因。只有完整目录确无语义匹配后，automatic 授权下才可按真实节点 schema 自动创建并验证候选工作流；ask 授权下先请求一次明确授权。\n</visual_production_tooling>`
}
