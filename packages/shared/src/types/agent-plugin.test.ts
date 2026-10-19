import { describe, expect, test } from 'bun:test'
import { parseAgentPluginManifest } from './agent-plugin'

const moduleManifest = {
  id: 'example', version: '1.0.0', apiVersion: 1, displayName: '示例', description: '示例模块', icon: 'box', scope: 'project',
  contributions: ['skill'], skillRefs: ['example-skill'], promptRefs: [], toolRefs: [], artifactTypes: [], surfaceIds: [], requiredPermissions: [],
}

describe('Agent 插件 Manifest', () => {
  test('有效 manifest-only 插件可规范化模块清单', () => {
    const result = parseAgentPluginManifest({ id: 'example.plugin', version: '1.0.0', apiVersion: 1, displayName: 'Example', description: '示例', modules: [moduleManifest], entry: { kind: 'manifest-only' } })
    expect(result.manifest.id).toBe('example.plugin')
    expect(result.manifest.modules[0]?.id).toBe('example')
  })

  test('缺失模块或可执行入口会被拒绝', () => {
    expect(() => parseAgentPluginManifest({ id: 'broken', version: '1.0.0', apiVersion: 1, displayName: 'Broken', description: '坏插件', modules: [], entry: { kind: 'native' } })).toThrow('AGENT_PLUGIN_ENTRY_UNSUPPORTED')
  })
})

/** 用于验证提示边界的完整插件声明。 */
function promptPlugin(prompts: unknown, refs = ['example.plugin.route']): Record<string, unknown> {
  return { id: 'example.plugin', version: '1.0.0', apiVersion: 1, displayName: 'Example', description: '示例', modules: [{ ...moduleManifest, promptRefs: refs }], entry: { kind: 'manifest-only' }, prompts }
}

describe('插件自有纯文本提示', () => {
  test('Given 自有命名空间提示 When 解析 Then 保留正文和引用', () => {
    const parsed = parseAgentPluginManifest(promptPlugin({ 'example.plugin.route': '先检查当前任务，再执行。' }))
    expect(parsed.manifest.prompts).toEqual({ 'example.plugin.route': '先检查当前任务，再执行。' })
  })

  test('Given 缺失引用或跨插件引用 When 解析 Then 拒绝整个插件', () => {
    expect(() => parseAgentPluginManifest(promptPlugin({}))).toThrow('AGENT_PLUGIN_PROMPT_REFERENCE_UNAVAILABLE')
    expect(() => parseAgentPluginManifest(promptPlugin({ 'example.plugin.route': '文本' }, ['other.route']))).toThrow('AGENT_PLUGIN_PROMPT_REFERENCE_UNAVAILABLE')
  })

  test('Given 越界命名空间、路径或宿主覆盖 When 解析 Then 拒绝', () => {
    for (const key of ['other.route', '../prompt', 'example.plugin./file']) {
      expect(() => parseAgentPluginManifest(promptPlugin({ [key]: '文本' }))).toThrow('AGENT_PLUGIN_PROMPT_ID_INVALID')
    }
    expect(() => parseAgentPluginManifest({ ...promptPlugin({ 'canvas.system.v1': '覆盖' }), id: 'canvas' })).toThrow('AGENT_PLUGIN_PROMPT_ID_INVALID')
  })

  test('Given 空、非文本、控制字符、过大提示 When 解析 Then 拒绝且不截断', () => {
    for (const content of ['', '  ', 42, 'bad\u0000text']) {
      expect(() => parseAgentPluginManifest(promptPlugin({ 'example.plugin.route': content }))).toThrow('AGENT_PLUGIN_PROMPT_CONTENT_INVALID')
    }
    expect(() => parseAgentPluginManifest(promptPlugin({ 'example.plugin.route': 'x'.repeat(16385) }))).toThrow('AGENT_PLUGIN_PROMPTS_TOO_LARGE')
    const total = Object.fromEntries(Array.from({ length: 5 }, (_, index) => [`example.plugin.p${index}`, 'x'.repeat(16384)]))
    expect(() => parseAgentPluginManifest(promptPlugin(total))).toThrow('AGENT_PLUGIN_PROMPTS_TOO_LARGE')
    const count = Object.fromEntries(Array.from({ length: 33 }, (_, index) => [`example.plugin.p${index}`, 'x']))
    expect(() => parseAgentPluginManifest(promptPlugin(count))).toThrow('AGENT_PLUGIN_PROMPTS_TOO_LARGE')
  })
})
