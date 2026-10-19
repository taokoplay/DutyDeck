import { describe, expect, test } from 'bun:test'
import {
  isIdempotentReplay,
  normalizeAgentSessionModulePolicy,
  parseAgentModuleManifest,
} from './agent-modules'

const validManifest = {
  id: 'dutydeck.canvas',
  version: '1.0.0',
  apiVersion: 1,
  displayName: '画布',
  description: '创建和编辑项目画布',
  icon: 'layout-dashboard',
  scope: 'project',
  contributions: ['surface', 'skill', 'tool', 'artifact'],
  skillRefs: ['canvas.storyboard', 'canvas.edit', 'canvas.storyboard'],
  promptRefs: ['canvas.system.v1'],
  toolRefs: ['canvas.inspect'],
  artifactTypes: ['canvas.document'],
  surfaceIds: ['canvas'],
  requiredPermissions: ['project.files.read'],
}

describe('Agent 模块合同', () => {
  test('Given 有效 manifest When 解析 Then 规范化列表并返回非阻断警告', () => {
    const result = parseAgentModuleManifest(validManifest)
    expect(result.manifest.id).toBe('dutydeck.canvas')
    expect(result.manifest.skillRefs).toEqual(['canvas.storyboard', 'canvas.edit'])
    expect(result.warnings).toEqual([])
  })

  test('Given 缺少 API 版本 When 解析 Then fail closed', () => {
    expect(() => parseAgentModuleManifest({ ...validManifest, apiVersion: 2 })).toThrow('AGENT_MODULE_MANIFEST_API_VERSION_UNSUPPORTED')
  })

  test('Given Skill 贡献没有 Skill 引用 When 解析 Then 保留模块但返回明确警告', () => {
    const result = parseAgentModuleManifest({ ...validManifest, skillRefs: [] })
    expect(result.manifest.skillRefs).toEqual([])
    expect(result.warnings).toEqual(['AGENT_MODULE_SKILL_CONTRIBUTION_EMPTY'])
  })

  test('Given 旧 Session 没有策略 When 规范化 Then 使用 auto 安全默认值', () => {
    expect(normalizeAgentSessionModulePolicy(undefined, 123)).toEqual({
      mode: 'auto', enabledModuleIds: [], disabledModuleIds: [], pinnedModuleIds: [], revision: 0, updatedAt: 123,
    })
  })

  test('Given 禁用和固定列表冲突 When 规范化 Then 禁用优先且固定只保留已启用模块', () => {
    const policy = normalizeAgentSessionModulePolicy({
      mode: 'pinned', enabledModuleIds: ['canvas', 'media', 'canvas'], disabledModuleIds: ['media'], pinnedModuleIds: ['canvas', 'media', 'missing'], revision: 4, updatedAt: 10,
    })
    expect(policy).toEqual({
      mode: 'pinned', enabledModuleIds: ['canvas'], disabledModuleIds: ['media'], pinnedModuleIds: ['canvas'], revision: 4, updatedAt: 10,
    })
  })

  test('Given 已提交幂等键 When 检查恢复命令 Then 阻止重复副作用', () => {
    expect(isIdempotentReplay(new Set(['run:1:tool:1']), 'run:1:tool:1')).toBe(true)
    expect(isIdempotentReplay(new Set(['run:1:tool:1']), 'run:1:tool:2')).toBe(false)
  })
  test('Given 引用数组数量或单项长度超过预算 When 解析 Then 所有声明字段均拒绝而不截断', () => {
    for (const field of ['contributions', 'skillRefs', 'promptRefs', 'toolRefs', 'artifactTypes', 'surfaceIds', 'requiredPermissions']) {
      expect(() => parseAgentModuleManifest({ ...validManifest, [field]: Array.from({ length: 257 }, () => 'short') })).toThrow(`AGENT_MODULE_MANIFEST_${field.toUpperCase()}_TOO_LARGE`)
      expect(() => parseAgentModuleManifest({ ...validManifest, [field]: ['x'.repeat(257)] })).toThrow(`AGENT_MODULE_MANIFEST_${field.toUpperCase()}_TOO_LARGE`)
    }
    expect(parseAgentModuleManifest({ ...validManifest, toolRefs: Array.from({ length: 256 }, (_, index) => `tool${index}`) }).manifest.toolRefs).toHaveLength(256)
  })

})
