import { describe, expect, test } from 'bun:test'
import { parsePluginManifestV3 } from '@dutydeck/plugin-sdk'
import { ContributionRegistry } from './contribution-registry'

/** 构造仅用于贡献注册的 V3 runtime 清单。 */
function manifest(pluginId: string, agentName = 'plugin_acme_echo_inspect') {
  const parsed = parsePluginManifestV3({
    formatVersion: 3,
    apiVersion: '1.0.0',
    id: pluginId,
    publisherId: pluginId.split('.')[0],
    version: '1.0.0',
    displayName: 'Echo',
    description: 'echo',
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
      id: 'assistant',
      displayName: 'Echo',
      description: 'echo',
      icon: 'package',
      activation: 'session-toggle',
      skillRefs: [],
      promptRefs: [],
      tools: ['inspect'],
      surfaces: [],
      services: [],
      artifacts: [],
    }],
    tools: [{
      id: 'inspect',
      ownerModuleId: 'assistant',
      agentName,
      title: 'Inspect',
      description: 'inspect',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      annotations: { readOnly: true, destructive: false, idempotent: true, openWorld: false },
      approval: 'none',
      timeoutMs: 1000,
    }],
    surfaces: [],
    services: [],
    artifacts: [],
    prompts: [],
    settings: [],
    capabilities: ['session.read'],
    dependencies: [],
    exports: [],
  })
  if (!parsed.ok) throw new Error(JSON.stringify(parsed.issues))
  return parsed.value
}

describe('Given plugin contribution registry', () => {
  test('When 两个插件生成相同 Agent 工具名 Then 第二个注册失败', () => {
    const registry = new ContributionRegistry()
    registry.register({ manifest: manifest('acme.echo'), packageHash: 'a'.repeat(64) })
    expect(() => registry.register({
      manifest: manifest('other.echo', 'plugin_acme_echo_inspect'),
      packageHash: 'b'.repeat(64),
    })).toThrow('PLUGIN_TOOL_NAME_CONFLICT')
  })

  test('When 查询激活模块 Then 只返回该模块声明的工具', () => {
    const registry = new ContributionRegistry()
    registry.register({ manifest: manifest('acme.echo'), packageHash: 'a'.repeat(64) })
    expect(registry.toolsForModules(['acme.echo.assistant']).map(tool => tool.agentName))
      .toEqual(['plugin_acme_echo_inspect'])
    expect(registry.toolsForModules([])).toEqual([])
    expect(registry.getToolOwner('plugin_acme_echo_inspect')).toBe('acme.echo')
  })

  test('When 插件卸载 Then 工具与模块映射同时移除', () => {
    const registry = new ContributionRegistry()
    registry.register({ manifest: manifest('acme.echo'), packageHash: 'a'.repeat(64) })
    registry.unregister('acme.echo')
    expect(registry.toolsForModules(['acme.echo.assistant'])).toEqual([])
    expect(registry.getToolOwner('plugin_acme_echo_inspect')).toBeUndefined()
  })
})
