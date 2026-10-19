import { describe, expect, test } from 'bun:test'
import { AgentPluginRegistry } from './plugin-registry'
import type { AgentModuleManifest } from '@dutydeck/shared'

const moduleManifest: AgentModuleManifest = {
  id: 'canvas', version: '1.0.0', apiVersion: 1, displayName: '画布', description: '画布', icon: 'layout', scope: 'project',
  contributions: ['tool'], skillRefs: [], promptRefs: [], toolRefs: ['canvas.create_node'], artifactTypes: [], surfaceIds: ['canvas'], requiredPermissions: [],
}

describe('Agent 插件注册表', () => {
  test('内置模块优先，第三方重复模块被拒绝并保留诊断', () => {
    const registry = new AgentPluginRegistry()
    registry.registerBuiltinModules([moduleManifest])
    const diagnostics = registry.loadInstalledPlugins('/path/that/does/not/exist')
    expect(registry.getModule('canvas')?.displayName).toBe('画布')
    expect(diagnostics).toEqual([])
  })
})

import { mkdtempSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { writeJsonFileAtomic } from '../safe-file'

test('Given 自有提示冲突或未知引用 When 注册 Then 拒绝插件不发布模块及提示', () => {
  /** 独立目录覆盖嵌套命名空间可能声明同一提示 ID 的冲突。 */
  const root = mkdtempSync(join(tmpdir(), 'plugin-prompt-registry-'))
  try {
    for (const [id, moduleId, ref] of [['x', 'first', 'x.y.route'], ['x.y', 'second', 'x.y.route'], ['missing', 'third', 'missing.unknown']]) {
      mkdirSync(join(root, id!))
      writeJsonFileAtomic(join(root, id!, 'plugin.json'), {
        id, version: '1.0.0', apiVersion: 1, displayName: '提示', description: '提示', entry: { kind: 'manifest-only' },
        prompts: id === 'missing' ? {} : { 'x.y.route': id },
        modules: [{ ...moduleManifest, id: moduleId, promptRefs: [ref] }],
      })
    }
    const registry = new AgentPluginRegistry()
    const diagnostics = registry.loadInstalledPlugins(root)
    expect(registry.listModules().map((module) => module.id)).toEqual(['first'])
    expect(registry.getPromptCatalog()).toEqual({ 'x.y.route': 'x' })
    expect(diagnostics.some((item) => item.errorCode === 'AGENT_PLUGIN_PROMPT_REFERENCE_UNAVAILABLE')).toBe(true)
    expect(diagnostics.some((item) => item.errorCode === 'AGENT_PLUGIN_PROMPT_ID_CONFLICT')).toBe(true)
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('Given 多个合法插件累计提示超预算 When 注册 Then 保留已接纳插件并明确拒绝超限项', () => {
  // 每个清单都满足单插件上限，但第九个会超过全局 512Ki 字符预算。
  const root = mkdtempSync(join(tmpdir(), 'plugin-total-budget-'))
  try {
    for (let index = 0; index < 9; index += 1) {
      const id = `plugin-${index}`
      const prompts = Object.fromEntries(Array.from({ length: 4 }, (_, promptIndex) => [`${id}.prompt-${promptIndex}`, 'x'.repeat(16 * 1024)]))
      mkdirSync(join(root, id))
      writeJsonFileAtomic(join(root, id, 'plugin.json'), {
        id, version: '1.0.0', apiVersion: 1, displayName: '提示', description: '提示', entry: { kind: 'manifest-only' }, prompts,
        modules: [{ ...moduleManifest, id: `module-${index}`, promptRefs: Object.keys(prompts) }],
      })
    }
    const registry = new AgentPluginRegistry()
    registry.registerBuiltinModules([moduleManifest])
    const diagnostics = registry.loadInstalledPlugins(root)
    expect(registry.listModules()).toHaveLength(9)
    expect(Object.keys(registry.getPromptCatalog())).toHaveLength(32)
    expect(diagnostics.filter((entry) => entry.pluginId === 'plugin-8')).toMatchObject([{ status: 'rejected', errorCode: 'AGENT_PLUGIN_CATALOG_LIMIT_EXCEEDED' }])
  } finally { rmSync(root, { recursive: true, force: true }) }
})
