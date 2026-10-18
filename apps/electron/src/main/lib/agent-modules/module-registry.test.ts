import { describe, expect, test } from 'bun:test'
import { getBuiltinAgentModule, listBuiltinAgentModules } from './module-registry'

describe('内置 Agent 模块注册表', () => {
  test('提供稳定的用户可见模块集合', () => {
    expect(listBuiltinAgentModules().map((module) => module.id)).toEqual([
      'canvas', 'visual-production', 'interaction-design', 'browser', 'terminal',
    ])
  })

  test('返回副本，调用方修改不会污染注册表', () => {
    const module = getBuiltinAgentModule('canvas')!
    module.skillRefs.push('unexpected')
    expect(getBuiltinAgentModule('canvas')?.skillRefs).toEqual(['canvas-production'])
  })
})
