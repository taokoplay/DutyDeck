import { describe, expect, test } from 'bun:test'
import { buildNextSessionModulePolicy } from './module-policy'

describe('Agent Session 模块策略存储', () => {
  test('Given 旧 Session 没有策略 When 计算更新 Then 从 auto revision 0 开始', () => {
    expect(buildNextSessionModulePolicy(undefined, { mode: 'pinned', enabledModuleIds: ['canvas'], pinnedModuleIds: ['canvas'] }, { now: 100 })).toEqual({
      mode: 'pinned', enabledModuleIds: ['canvas'], disabledModuleIds: [], pinnedModuleIds: ['canvas'], revision: 1, updatedAt: 100,
    })
  })

  test('Given revision 不匹配 When 更新 Then 拒绝覆盖新策略', () => {
    expect(() => buildNextSessionModulePolicy({ mode: 'auto', enabledModuleIds: [], disabledModuleIds: [], pinnedModuleIds: [], revision: 2, updatedAt: 1 }, { mode: 'pinned' }, { expectedRevision: 1, now: 100 })).toThrow('AGENT_MODULE_POLICY_REVISION_CONFLICT')
  })

  test('Given 请求列表有重复和禁用冲突 When 更新 Then 输出可持久化的规范策略', () => {
    expect(buildNextSessionModulePolicy({ mode: 'auto', enabledModuleIds: [], disabledModuleIds: [], pinnedModuleIds: [], revision: 4, updatedAt: 1 }, {
      mode: 'pinned', enabledModuleIds: ['canvas', 'canvas', 'media'], disabledModuleIds: ['media'], pinnedModuleIds: ['canvas', 'media'],
    }, { expectedRevision: 4, now: 100 })).toEqual({
      mode: 'pinned', enabledModuleIds: ['canvas'], disabledModuleIds: ['media'], pinnedModuleIds: ['canvas'], revision: 5, updatedAt: 100,
    })
  })
})
