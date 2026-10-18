import { describe, expect, test } from 'bun:test'
import type { AgentSessionModulePolicy, SkillMeta } from '@dutydeck/shared'
import { resolveActiveModuleContext } from './module-skill-resolver'
import { listBuiltinAgentModules } from './module-registry'

const policy = (override: Partial<AgentSessionModulePolicy> = {}): AgentSessionModulePolicy => ({
  mode: 'pinned',
  enabledModuleIds: ['canvas', 'browser'],
  disabledModuleIds: [],
  pinnedModuleIds: ['canvas'],
  revision: 3,
  updatedAt: 1,
  ...override,
})

const skills = (slugs: string[]): SkillMeta[] => slugs.map((slug) => ({ slug, name: slug, enabled: true }))

describe('Agent 模块 Skill 解析', () => {
  test('Given pinned Canvas When 解析 Then 返回 Skill、提示摘要和工具绑定', () => {
    const result = resolveActiveModuleContext(
      { workspaceSlug: 'project', sessionId: 'session', policy: policy(), now: 10 },
      { listModules: listBuiltinAgentModules, getSkills: () => skills(['canvas-production']) },
    )
    expect(result.modules[0]).toMatchObject({ moduleId: 'canvas', mode: 'pinned', policyRevision: 3 })
    expect(result.skillMentions).toEqual(['canvas-production'])
    expect(result.allowedToolNames).toContain('canvas.create_node')
    expect(result.promptFragments[0]).toContain('当前模块是画布')
    expect(result.unavailable).toEqual([])
  })

  test('Given auto 模式 When 没有显式模块 Then 不注入额外模块上下文', () => {
    const result = resolveActiveModuleContext(
      { workspaceSlug: 'project', sessionId: 'session', policy: policy({ mode: 'auto' }), now: 10 },
      { listModules: listBuiltinAgentModules, getSkills: () => skills(['canvas-production', 'in-app-browser']) },
    )
    expect(result.modules).toEqual([])
    expect(result.skillMentions).toEqual([])
    expect(result.promptFragments).toEqual([])
  })

  test('Given 模块绑定 Skill 未启用 When 解析 Then 返回缺失原因且不允许降级调用', () => {
    const result = resolveActiveModuleContext(
      { workspaceSlug: 'project', sessionId: 'session', policy: policy(), now: 10 },
      { listModules: listBuiltinAgentModules, getSkills: () => skills([]) },
    )
    expect(result.modules).toEqual([])
    expect(result.unavailable).toEqual([{ moduleId: 'canvas', reason: 'AGENT_MODULE_SKILL_UNAVAILABLE:canvas-production' }])
  })

  test('Given 显式模块调用 When 解析 Then 记录 invoke 模式', () => {
    const result = resolveActiveModuleContext(
      { workspaceSlug: 'project', sessionId: 'session', policy: policy({ mode: 'auto' }), explicitModuleIds: ['browser'], invocationMode: 'invoke', now: 10 },
      { listModules: listBuiltinAgentModules, getSkills: () => skills(['in-app-browser']) },
    )
    expect(result.modules[0]).toMatchObject({ moduleId: 'browser', invocationMode: 'invoke', mode: 'auto' })
  })
})
