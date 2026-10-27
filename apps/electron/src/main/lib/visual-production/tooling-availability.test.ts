import { describe, expect, test } from 'bun:test'
import { assessVisualProductionTooling, buildVisualProductionToolingPrompt, VisualProductionToolingError } from './tooling-availability'

/** 执行模式必须具备影像作品、生成、审核和本地媒体导入工具。 */
const executeTools = [
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
]

describe('影像创作工具可用性', () => {
  test('Given 执行模式工具齐全 When 检查 Then 返回就绪并把真实工具写入提示', () => {
    const state = assessVisualProductionTooling(executeTools, 'execute')
    expect(state).toEqual({ status: 'ready', required: expect.any(Array), missing: [] })
    const prompt = buildVisualProductionToolingPrompt(state)
    expect(prompt).toContain('media_import_local_file')
    expect(prompt).toContain('禁止根据历史上下文判断工具缺失')
    expect(prompt).toContain('子 Agent 和委派会话')
    expect(prompt).toContain('projectId 是工作区 ID')
    expect(prompt).toContain('media_discover_workflows')
    expect(prompt).toContain('不要等待用户切换 Canvas')
    expect(prompt).toContain('连接已接入不等于工作流已验证')
    expect(prompt).toContain('visual_production_record_workflow_discovery')
    expect(prompt).toContain('visual_production_propose_script')
    expect(prompt).toContain('visual_production_update_shot_plan')
    expect(prompt).toContain('VIDEO_PLAN_REQUIRED')
    expect(prompt).toContain('continuityPlan')
    expect(prompt).toContain('自动创建')
    expect(prompt).toContain('普通操作在用户任务范围内直接执行')
    expect(prompt).toContain('锁定角色或资产的正式变更由宿主自动弹出项目原生权限卡')
    expect(prompt).toContain('Host 托管等待终态')
    expect(prompt).toContain('不要用 media_wait_run 高频刷新进度')
    expect(prompt).toContain('visual_production_create_rough_cut')
    expect(prompt).toContain('visual_production_adopt_timeline_edit')
    expect(prompt).toContain('visual_production_request_export')
    expect(prompt).toContain('不能宣称已经交付成片')
  })

  test('Given 执行模式缺少媒体导入或工作流工具 When 检查 Then 明确列出缺失项', () => {
    const missing = ['media_import_local_file', 'media_discover_workflows', 'media_prepare_run']
    const state = assessVisualProductionTooling(executeTools.filter(name => !missing.includes(name)), 'execute')
    expect(state).toMatchObject({ status: 'incomplete', missing })
    expect(() => assessVisualProductionTooling(executeTools.filter(name => !missing.includes(name)), 'execute', true)).toThrow(VisualProductionToolingError)
  })

  test('Given 计划模式 When 检查 Then 只要求读取与能力发现工具', () => {
    const state = assessVisualProductionTooling(['visual_production_read', 'visual_production_read_script', 'visual_production_read_shot', 'visual_production_read_timeline', 'visual_production_list_export_jobs', 'visual_production_media_catalog', 'media_list_models'], 'plan')
    expect(state).toMatchObject({ status: 'ready', missing: [] })
    expect(state.required).not.toContain('media_import_local_file')
    expect(state.required).not.toContain('visual_production_request_export')
  })
})
