import { describe, expect, test } from 'bun:test'
import {
  PLUGIN_MANIFEST_V3_SCHEMA,
  parsePluginManifestV3,
} from '../src/index.js'

/** 返回一份覆盖 runtime、工具、Surface、服务、产物和设置的最小 V3 清单。 */
function v3Fixture(): Record<string, unknown> {
  return {
    formatVersion: 3,
    apiVersion: '1.0.0',
    id: 'acme.design-tools',
    publisherId: 'acme',
    version: '1.0.0',
    displayName: '设计工具',
    description: '运行模块',
    license: 'MIT',
    profile: 'module-runtime',
    compatibility: {
      hostApi: '^1.0.0',
      runtimeProtocol: 1,
      platforms: ['darwin'],
      architectures: ['arm64'],
    },
    runtime: { entry: 'runtime/main.mjs', format: 'module-esm' },
    modules: [{
      id: 'inspector',
      displayName: '检查',
      description: '检查项目',
      icon: 'search',
      activation: 'session-toggle',
      skillRefs: [],
      promptRefs: ['workflow'],
      tools: ['inspect'],
      surfaces: ['workspace'],
      services: ['index'],
      artifacts: ['report'],
    }],
    tools: [{
      id: 'inspect',
      ownerModuleId: 'inspector',
      title: '检查',
      description: '检查项目',
      inputSchema: {
        type: 'object',
        properties: {},
        required: [],
        additionalProperties: false,
      },
      annotations: {
        readOnly: true,
        destructive: false,
        idempotent: true,
        openWorld: false,
      },
      approval: 'none',
      timeoutMs: 30000,
    }],
    surfaces: [{
      id: 'workspace',
      ownerModuleId: 'inspector',
      title: '检查',
      entry: 'surfaces/workspace/index.html',
      apiVersion: 1,
      defaultPlacement: 'right-panel',
      methods: ['load'],
    }],
    services: [{
      id: 'index',
      title: '索引',
      start: 'lazy',
      idleStopMs: 300000,
    }],
    artifacts: [{
      id: 'report',
      ownerModuleId: 'inspector',
      title: '报告',
      schemaVersion: 1,
      mimeTypes: ['application/json'],
      retention: 'project',
    }],
    prompts: [{
      id: 'workflow',
      version: '1.0.0',
      kind: 'workflow',
      path: 'prompts/workflow.md',
    }],
    settings: [{
      key: 'limit',
      type: 'integer',
      label: '上限',
      defaultValue: 10,
      minimum: 1,
      maximum: 100,
      apply: 'next-run',
    }],
    capabilities: ['session.read', 'project.files.read'],
    dependencies: [],
    exports: [],
  }
}

describe('Given V3 module-runtime manifest', () => {
  test('When 完整合同 Then 规范化模块 ID 与默认工具名', () => {
    const parsed = parsePluginManifestV3(v3Fixture())
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return
    expect(parsed.value.modules[0]?.id).toBe('acme.design-tools.inspector')
    expect(parsed.value.tools[0]?.agentName).toBe('plugin_acme_design_tools_inspect')
    expect(parsed.value.compatibility.runtimeProtocol).toBe(1)
  })

  test('When 工具 owner 不存在 Then 返回字段定位', () => {
    const input = v3Fixture()
    const tools = input.tools as Record<string, unknown>[]
    tools[0] = { ...tools[0], ownerModuleId: 'missing' }
    const parsed = parsePluginManifestV3(input)
    expect(parsed.ok).toBe(false)
    if (!parsed.ok) {
      expect(parsed.issues.some(issue => issue.field.includes('ownerModuleId'))).toBe(true)
    }
  })

  test('When profile 不是 module-runtime Then 拒绝', () => {
    expect(parsePluginManifestV3({ ...v3Fixture(), profile: 'content' }).ok).toBe(false)
  })

  test('When runtime 入口或 Surface 入口越界 Then 拒绝', () => {
    const runtime = v3Fixture()
    runtime.runtime = { entry: '../runtime/main.mjs', format: 'module-esm' }
    expect(parsePluginManifestV3(runtime).ok).toBe(false)

    const surface = v3Fixture()
    const surfaces = surface.surfaces as Record<string, unknown>[]
    surfaces[0] = { ...surfaces[0], entry: 'https://example.com/surface.html' }
    expect(parsePluginManifestV3(surface).ok).toBe(false)
  })

  test('When 模块引用不存在的贡献 Then 返回 reference 错误', () => {
    const input = v3Fixture()
    const modules = input.modules as Record<string, unknown>[]
    modules[0] = { ...modules[0], tools: ['missing'] }
    const parsed = parsePluginManifestV3(input)
    expect(parsed.ok).toBe(false)
    if (!parsed.ok) expect(parsed.issues.some(issue => issue.code === 'reference')).toBe(true)
  })

  test('When 工具可见名冲突 Then 拒绝', () => {
    const input = v3Fixture()
    const tools = input.tools as Record<string, unknown>[]
    tools.push({
      ...tools[0],
      id: 'inspect-2',
      agentName: 'plugin_acme_design_tools_inspect',
    })
    expect(parsePluginManifestV3(input).ok).toBe(false)
  })

  test('When 导出 Schema Then 与解析器使用同一 V3 版本', () => {
    expect(PLUGIN_MANIFEST_V3_SCHEMA.properties?.formatVersion).toEqual({ const: 3 })
    expect(PLUGIN_MANIFEST_V3_SCHEMA.additionalProperties).toBe(false)
  })
})
