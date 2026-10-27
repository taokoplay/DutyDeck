import { describe, expect, test } from 'bun:test'
import { getBuiltinAgentModulePrompt } from '@dutydeck/shared'
import { VISUAL_PRODUCTION_AGENT_TOOL_NAMES } from './agent-tools'
import { VISUAL_PRODUCTION_EXECUTION_CONTRACT } from './execution-contract'
import { VISUAL_PRODUCTION_QUALITY_CONTRACT } from './quality-contract'
import { assessVisualProductionTooling, buildVisualProductionToolingPrompt, VISUAL_PRODUCTION_EXECUTE_TOOLS } from './tooling-availability'

describe('合并后的影像执行合同', () => {
  test('Given 精简旧提示 When 核对模型收到的步骤 Then 保留独特安全边界并使用真实工具名', () => {
    /** 保护旧合同独有的引用、分页、取消与证据要求，避免精简时误删。 */
    for (const boundary of ['计划模式仅检查', '一次性原生权限卡', 'CAS', 'includeProductionText=true', 'textPage.nextOffset', 'referencePage.nextOffset', '显式空 entries 禁止生成', 'MediaAssetRef', 'descriptor/contentHash', 'VIDEO_PLAN_REQUIRED', 'Host 托管等待终态', '只取消影像 job 不代表外部生成停止', '本次 evidenceId', 'continue_delegation 不恢复审图授权', 'timeline 为空', 'insertAudioClip 是操作类型', 'AAC', 'completed', '.dutydeck/visual-production', '.proma/visual-production']) expect(VISUAL_PRODUCTION_EXECUTION_CONTRACT).toContain(boundary)
    /** 上下文委派工具独立装配，不能误判为普通作品工具或新造工具名。 */
    const registered = new Set<string>([...VISUAL_PRODUCTION_AGENT_TOOL_NAMES, 'visual_production_delegate_review', 'visual_production_read_review'])
    /** 标签是上下文边界，不是可调用工具。 */
    const mentioned = new Set(VISUAL_PRODUCTION_EXECUTION_CONTRACT.match(/\bvisual_production_[a-z_]+\b/g))
    mentioned.delete('visual_production_execution')
    for (const name of mentioned) expect(registered.has(name)).toBe(true)
  })

  test('Given 完整模块与工具提示 When 合并静态上下文 Then 创作指引不重复且总长度有界', () => {
    /** 以真实模块提示、执行合同、质量合同和动态工具事实计算上下文开销。 */
    const prompt = [getBuiltinAgentModulePrompt('visual-production.system.v1'), VISUAL_PRODUCTION_EXECUTION_CONTRACT, VISUAL_PRODUCTION_QUALITY_CONTRACT, buildVisualProductionToolingPrompt(assessVisualProductionTooling(VISUAL_PRODUCTION_EXECUTE_TOOLS, 'execute'))].join('\n')
    expect(prompt.split('<visual_creation>').length - 1).toBe(1)
    expect(prompt.split('<visual_production_execution>').length - 1).toBe(1)
    expect(prompt.length).toBeLessThan(12_000)
    expect(prompt).not.toContain('优先于上文')
    expect(prompt).not.toContain('候选默认由用户在面板手工采用')
  })
})
