import { describe, expect, test } from 'bun:test'
import { getBuiltinAgentModule, listBuiltinAgentModules } from './module-registry'

describe('内置 Agent 模块注册表', () => {
  test('提供稳定的用户可见模块集合', () => {
    expect(listBuiltinAgentModules().map((module) => module.id)).toEqual([
      'canvas', 'visual-production', 'interaction-design', 'browser', 'terminal', 'server-ops', 'api-workbench', 'capability-factory',
    ])
  })

  test('Given 专业工作台 When 读取注册表 Then 提供对应入口与既有 Skill 并保留常用能力兼容', () => {
    expect(getBuiltinAgentModule('server-ops')).toMatchObject({ surfaceIds: ['server-ops'], skillRefs: [], promptRefs: ['server-ops.system.v1'] })
    expect(getBuiltinAgentModule('api-workbench')).toMatchObject({ surfaceIds: ['api-workbench'], skillRefs: [], promptRefs: ['api-workbench.system.v1'] })
    expect(getBuiltinAgentModule('capability-factory')).toMatchObject({ surfaceIds: ['capability-factory'], skillRefs: ['capability-factory-scene-design'], promptRefs: ['capability-factory.system.v1'] })
    expect(listBuiltinAgentModules()[4]?.id).toBe('terminal')
    expect(getBuiltinAgentModule('browser')?.skillRefs).toEqual(['in-app-browser'])
  })

  test('Given 影像单选 When 读取 Skill 引用 Then 不附带整套画布指令且画布可共享媒体能力', () => {
    expect(getBuiltinAgentModule('visual-production')?.skillRefs).toEqual(['media-models'])
    expect(getBuiltinAgentModule('visual-production')).toMatchObject({
      surfaceIds: ['visual-production'],
      promptRefs: ['visual-production.system.v1'],
      toolRefs: ['visual.projects', 'visual.script', 'visual.storyboard', 'visual.media', 'visual.review', 'visual.edit', 'visual.deliver'],
      artifactTypes: ['visual.production', 'visual.script', 'visual.storyboard', 'media.image', 'media.video', 'media.audio', 'visual.timeline', 'visual.final-master'],
    })
    expect(getBuiltinAgentModule('canvas')?.skillRefs).toEqual(['canvas-production', 'media-models'])
  })

  test('返回副本，调用方修改不会污染注册表', () => {
    const module = getBuiltinAgentModule('canvas')!
    module.skillRefs.push('unexpected')
    expect(getBuiltinAgentModule('canvas')?.skillRefs).toEqual(['canvas-production', 'media-models'])
  })
})
