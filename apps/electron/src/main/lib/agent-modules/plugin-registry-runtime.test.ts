import { describe, expect, test } from 'bun:test'
import type { AgentModuleManifest } from '@dutydeck/shared'
import { AgentPluginRegistry } from './plugin-registry'

/** 构造 V3 投影后的模块。 */
function runtimeModule(): AgentModuleManifest {
  return {
    id: 'acme.echo.assistant',
    version: '1.0.0',
    apiVersion: 1,
    displayName: 'Echo',
    description: 'echo',
    icon: 'package',
    scope: 'project',
    contributions: ['tool', 'surface', 'prompt'],
    skillRefs: [],
    promptRefs: ['acme.echo/prompts/workflow'],
    toolRefs: ['inspect'],
    artifactTypes: [],
    surfaceIds: ['workspace'],
    requiredPermissions: ['session.read'],
    activation: 'session-toggle',
    source: 'installed',
    pluginId: 'acme.echo',
    packageHash: 'a'.repeat(64),
  }
}

describe('Given runtime plugin registry projection', () => {
  test('When 发布 V3 模块 Then 保留来源和插件提示', () => {
    const registry = new AgentPluginRegistry()
    registry.setRuntimeModules([runtimeModule()], {
      'acme.echo/prompts/workflow': '运行时提示',
    })
    expect(registry.getModule('acme.echo.assistant')).toEqual(expect.objectContaining({
      pluginId: 'acme.echo',
      packageHash: 'a'.repeat(64),
    }))
    expect(registry.getPromptCatalog()).toEqual({
      'acme.echo/prompts/workflow': '运行时提示',
    })
  })

  test('When V3 模块与内置模块冲突 Then 不覆盖旧目录', () => {
    const registry = new AgentPluginRegistry()
    registry.registerBuiltinModules([runtimeModule()])
    expect(() => registry.setRuntimeModules([runtimeModule()], {})).toThrow('AGENT_PLUGIN_MODULE_ID_CONFLICT')
  })

  test('When 同一插件声明多个模块 Then 允许共享插件身份', () => {
    const registry = new AgentPluginRegistry()
    registry.setRuntimeModules([
      runtimeModule(),
      { ...runtimeModule(), id: 'acme.echo.second' },
    ], {
      'acme.echo/prompts/workflow': '运行时提示',
    })
    expect(registry.listModules().filter(module => module.pluginId === 'acme.echo')).toHaveLength(2)
  })
})
