import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import type { AgentSessionModulePolicy } from '@dutydeck/shared'
import { resolveActiveModuleContext } from '../agent-modules/module-skill-resolver'
import { listBuiltinAgentModules } from '../agent-modules/module-registry'

/** 模拟真实模块选择；不启动模型、不读取真实工作区配置。 */
function modulePrompt(moduleId: string): string {
  /** 未附着模块时仅测试当前消息显式选择的边界。 */
  const policy: AgentSessionModulePolicy = { mode: 'auto', enabledModuleIds: [], disabledModuleIds: [], pinnedModuleIds: [], revision: 1, updatedAt: 1 }
  return resolveActiveModuleContext({ workspaceSlug: 'project', sessionId: 'session', policy, explicitModuleIds: [moduleId] }, {
    listModules: listBuiltinAgentModules,
    getSkills: () => ['media-models', 'canvas-production'].map(slug => ({ slug, name: slug, enabled: true })),
  }).promptFragments.join('\n')
}

describe('影像创作指引的真实注入', () => {
  test('Given 影像模块已选择 When 解析当前提示 Then 包含需求追踪、规则、节奏与证据评审', () => {
    /** 检查运行解析结果，防止只写出未被加载的提示文件。 */
    const prompt = modulePrompt('visual-production')
    for (const requirement of ['需求→字段→镜头→验收', '角色知情范围', '伏笔', '回收', '总时长', '台词', '生成时长', '剪辑时长', 'productionNotes', '未经验证']) expect(prompt).toContain(requirement)
    expect(prompt).not.toContain('《妖巷》')
    expect(prompt).not.toContain('国风电影感，仿真人')
  })

  test('Given 仅选择画布 When 解析当前提示 Then 不注入影像创作规则', () => {
    expect(modulePrompt('canvas')).not.toContain('需求→字段→镜头→验收')
  })

  test('Given 主进程组装提示 When 装配影像合同 Then 只引用一份执行合同并删除旧覆盖指令', () => {
    /** 源码接线检查防止绕过模块测试又追加旧合同。 */
    const source = readFileSync(new URL('../agent-orchestrator.ts', import.meta.url), 'utf8')
    expect(source.includes('visualProductionAccess ? VISUAL_PRODUCTION_EXECUTION_CONTRACT : undefined')).toBe(true)
    expect(source.includes('影像 Agent 最新执行合同（优先于上文')).toBe(false)
    expect(source.includes('剧情、资产和时间线候选默认由用户在面板手工采用')).toBe(false)
    expect(source.includes('候选采用只在用户明确要求 Agent 直接采用或直接优化时')).toBe(false)
  })
})
