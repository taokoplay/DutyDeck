import { describe, expect, test } from 'bun:test'
import { parsePluginManifestV3 } from '@dutydeck/plugin-sdk'
import { projectRuntimePluginModules } from './runtime-module-projection'

/** 构造带一个模块和提示的 V3 清单。 */
function manifest() {
  const parsed = parsePluginManifestV3({
    formatVersion: 3,
    apiVersion: '1.0.0',
    id: 'acme.echo',
    publisherId: 'acme',
    version: '1.0.0',
    displayName: 'Echo',
    description: 'echo',
    license: 'MIT',
    profile: 'module-runtime',
    compatibility: { hostApi: '^1.0.0', runtimeProtocol: 1, platforms: ['darwin'], architectures: ['arm64'] },
    runtime: { entry: 'runtime/main.mjs', format: 'module-esm' },
    modules: [{
      id: 'assistant', displayName: 'Echo', description: 'echo', icon: 'package', activation: 'session-toggle',
      skillRefs: [{ id: 'interaction-design', scope: 'project', required: false }],
      promptRefs: ['workflow'], tools: ['inspect'], surfaces: ['workspace'], services: [], artifacts: [],
    }],
    tools: [{
      id: 'inspect', ownerModuleId: 'assistant', title: 'Inspect', description: 'inspect',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      annotations: { readOnly: true, destructive: false, idempotent: true, openWorld: false },
      approval: 'none', timeoutMs: 1000,
    }],
    surfaces: [{
      id: 'workspace', ownerModuleId: 'assistant', title: 'Echo', entry: 'surfaces/workspace/index.html',
      apiVersion: 1, defaultPlacement: 'right-panel', methods: ['load'],
    }],
    services: [], artifacts: [],
    prompts: [{ id: 'workflow', version: '1.0.0', kind: 'workflow', path: 'prompts/workflow.md' }],
    settings: [], capabilities: ['session.read'], dependencies: [], exports: [],
  })
  if (!parsed.ok) throw new Error(JSON.stringify(parsed.issues))
  return parsed.value
}

describe('Given runtime plugin projection', () => {
  test('When 投影 V3 模块 Then 保留来源、hash、Skill 和 Surface', () => {
    const projected = projectRuntimePluginModules({
      manifest: manifest(),
      packageHash: 'a'.repeat(64),
      prompts: {
        'acme.echo/prompts/workflow': '只执行已声明的回显工具。',
      },
    })
    expect(projected.modules[0]).toEqual(expect.objectContaining({
      id: 'acme.echo.assistant',
      pluginId: 'acme.echo',
      source: 'installed',
      packageHash: 'a'.repeat(64),
      skillRefs: ['interaction-design'],
      promptRefs: ['acme.echo/prompts/workflow'],
      toolRefs: ['inspect'],
      surfaceIds: ['plugin:acme.echo:workspace'],
      activation: 'session-toggle',
    }))
    expect(projected.prompts).toEqual({
      'acme.echo/prompts/workflow': '只执行已声明的回显工具。',
    })
  })
})
