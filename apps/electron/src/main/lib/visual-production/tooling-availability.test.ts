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
    expect(prompt).toContain('visual_production_record_workflow_discovery')
    expect(prompt).toContain('visual_production_propose_script')
    expect(prompt).toContain('visual_production_update_shot_plan')
    expect(prompt).toContain('当前为执行模式')
    expect(prompt).toContain('visual_production_create_rough_cut')
    expect(prompt).toContain('visual_production_adopt_timeline_edit')
    expect(prompt).toContain('visual_production_request_export')
    expect(prompt).not.toContain('当前为计划模式')
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
    /** 计划模式提示不能再携带执行任务和调用缺失写工具的步骤。 */
    const prompt = buildVisualProductionToolingPrompt(state)
    expect(prompt).toContain('当前为计划模式')
    expect(prompt).toContain('不创建任务、提交候选、采用、生成媒体或导出')
    expect(prompt).not.toContain('visual_production_begin_job')
    expect(prompt).not.toContain('visual_production_request_export')
  })

  test('Given 没有相关工具 When 组装提示 Then 不添加无用上下文', () => {
    expect(buildVisualProductionToolingPrompt({ status: 'incomplete', required: [], missing: [] })).toBe('')
  })
})
