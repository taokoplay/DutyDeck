import { describe, expect, test } from 'bun:test'
import { createAgentModuleToolPolicy } from './module-tool-policy'
import { denyToolOutsideAgentMode, denyToolOutsideRunAllowlist } from '../agent-run-tool-policy'

describe('基础能力自动调用与专业模块显式准入', () => {
  test('Given 普通消息未选择模块 When 检查工具 Then 浏览器终端文件可用而六类专业工具拒绝', () => {
    /** 普通会话无隐式模块授权。 */
    const policy = createAgentModuleToolPolicy({ activeModuleIds: [], toolMode: 'standard' })
    for (const name of ['Bash', 'Read', 'Write', 'Edit', 'BrowserNavigate', 'TerminalExecute', 'proma_memory_record', 'mcp__search']) {
      expect(policy.denyTool(name)).toBeUndefined()
    }
    for (const name of ['prototype_list', 'visual_production_list', 'canvas_get_context', 'media_list_models', 'ops_resources', 'server_exec', 'api_list', 'factory_list_scenes']) {
      expect(policy.denyTool(name)?.behavior).toBe('deny')
    }
  })

  test('Given 选择影像 When 使用共享媒体 Then 允许影像及媒体但不能操作画布或其它模块', () => {
    /** 影像选择不隐式选择画布。 */
    const policy = createAgentModuleToolPolicy({ activeModuleIds: ['visual-production'], toolMode: 'standard' })
    expect(policy.denyTool('visual_production_begin_job')).toBeUndefined()
    expect(policy.denyTool('media_execute_generation')).toBeUndefined()
    expect(policy.denyTool('canvas_create_artifact')?.behavior).toBe('deny')
    expect(policy.denyTool('prototype_propose')?.behavior).toBe('deny')
  })

  test('Given 多选画布和交互设计 When UI选择稍后变化 Then 当前运行保留快照且不开放工厂', () => {
    /** 模拟 UI 持有的选择数组。 */
    const selected = ['canvas', 'interaction-design']
    const policy = createAgentModuleToolPolicy({ activeModuleIds: selected, toolMode: 'standard' })
    selected.push('capability-factory')
    expect(policy.denyTool('canvas_create_artifact')).toBeUndefined()
    expect(policy.denyTool('media_list_models')).toBeUndefined()
    expect(policy.denyTool('prototype_list')).toBeUndefined()
    expect(policy.denyTool('factory_list_scenes')?.behavior).toBe('deny')
    expect(createAgentModuleToolPolicy({ activeModuleIds: [], toolMode: 'standard' }).denyTool('canvas_read')?.behavior).toBe('deny')
  })

  test('Given 宿主受限审图工具 When 无模块选择 Then 只保留精确工具并继续受原白名单约束', () => {
    /** 内部扩展只授权一项只读能力，不能开启完整影像模块。 */
    const trusted = ['visual_production_inspect_media']
    const policy = createAgentModuleToolPolicy({ activeModuleIds: [], toolMode: 'standard', trustedToolNames: trusted })
    expect(policy.denyTool(trusted[0]!)).toBeUndefined()
    expect(policy.hasModule('visual-production')).toBe(false)
    expect(policy.denyTool('visual_production_begin_job')?.behavior).toBe('deny')
    expect(denyToolOutsideRunAllowlist('Bash', trusted)?.behavior).toBe('deny')
  })

  test('Given 已授权运维只读会话 When 无模块选择 Then 保留运维范围但不绕过只读限制', () => {
    /** 运维专用运行是独立的宿主授权入口。 */
    const policy = createAgentModuleToolPolicy({ activeModuleIds: [], toolMode: 'server-ops-read' })
    expect(policy.hasModule('server-ops')).toBe(true)
    expect(policy.denyTool('ops_resources')).toBeUndefined()
    expect(denyToolOutsideAgentMode('server_exec', 'server-ops-read')?.behavior).toBe('deny')
    expect(policy.denyTool('api_send_request')?.behavior).toBe('deny')
  })

  test('Given 插件声明类似能力 When 未选择宿主模块 Then 不借插件ID开放专业工具', () => {
    const policy = createAgentModuleToolPolicy({ activeModuleIds: ['third-party'], toolMode: 'standard' })
    expect(policy.denyTool('server_exec')?.behavior).toBe('deny')
  })
})
