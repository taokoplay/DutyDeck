import { describe, expect, test } from 'bun:test'
import { parsePluginManifestV3 } from '@dutydeck/plugin-sdk'
import { AgentPluginRegistry } from '../agent-modules/plugin-registry'
import { ModuleRuntimeManager } from './module-runtime-manager'

/** 构造 V3 清单和对应提示。 */
function fixture() {
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
      skillRefs: [], promptRefs: ['workflow'], tools: ['inspect'], surfaces: ['workspace'], services: [], artifacts: [],
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

describe('Given module runtime manager', () => {
  test('When 注册插件 Then 模块、提示、贡献和 Surface 同时发布', () => {
    const modules = new AgentPluginRegistry()
    const manager = new ModuleRuntimeManager({
      moduleRegistry: modules,
      createSupervisor: () => ({
        start: async () => ({ pluginId: 'acme.echo', state: 'running', epoch: 1 }),
        invokeTool: async () => ({}),
        stop: async () => undefined,
      }),
    })
    manager.register({
      manifest: fixture(),
      packageHash: 'a'.repeat(64),
      packageRoot: '/private/tmp/acme.echo/1.0.0',
      prompts: { 'acme.echo/prompts/workflow': '只执行声明工具。' },
    })
    expect(modules.getModule('acme.echo.assistant')?.pluginId).toBe('acme.echo')
    expect(modules.getPromptCatalog()['acme.echo/prompts/workflow']).toBe('只执行声明工具。')
    expect(manager.getSurface('workspace', 'acme.echo.assistant')?.pluginId).toBe('acme.echo')
  })

  test('When 激活模块 Then 启动一次 runtime 并返回该项工具', async () => {
    let starts = 0
    const manager = new ModuleRuntimeManager({
      moduleRegistry: new AgentPluginRegistry(),
      createSupervisor: () => ({
        start: async () => {
          starts += 1
          return { pluginId: 'acme.echo', state: 'running', epoch: 1 }
        },
        invokeTool: async () => ({ echoed: true }),
        stop: async () => undefined,
      }),
    })
    manager.register({
      manifest: fixture(),
      packageHash: 'a'.repeat(64),
      packageRoot: '/private/tmp/acme.echo/1.0.0',
      prompts: { 'acme.echo/prompts/workflow': '只执行声明工具。' },
    })
    const tools = await manager.buildToolsForModules({
      sdk: { defineTool: tool => tool },
      moduleIds: ['acme.echo.assistant', 'acme.echo.assistant'],
      context: {
        sessionId: 'session-1', projectId: 'project-1', runId: 'run-1', settingsRevision: 1, settings: {}, deadline: Date.now() + 5000,
      },
    })
    expect(starts).toBe(1)
    expect(tools.map(tool => tool.name)).toEqual(['plugin_acme_echo_inspect'])
    expect(await manager.buildToolsForModules({
      sdk: { defineTool: tool => tool },
      moduleIds: ['acme.echo.assistant'],
      context: {
        sessionId: 'session-1', projectId: 'project-1', runId: 'run-2', settingsRevision: 1, settings: {}, deadline: Date.now() + 5000,
      },
    })).toHaveLength(1)
    expect(starts).toBe(1)
  })

  test('When Surface bridge 调用 Then 校验 token 并转发到所属 runtime', async () => {
    let observedMethod = ''
    const manager = new ModuleRuntimeManager({
      moduleRegistry: new AgentPluginRegistry(),
      createSupervisor: () => ({
        start: async () => ({ pluginId: 'acme.echo', state: 'running', epoch: 1 }),
        invokeTool: async () => ({}),
        invokeSurface: async (input) => {
          observedMethod = input.method
          return { loaded: true }
        },
        stop: async () => undefined,
      }),
    })
    manager.register({
      manifest: fixture(),
      packageHash: 'a'.repeat(64),
      packageRoot: '/private/tmp/acme.echo/1.0.0',
      prompts: { 'acme.echo/prompts/workflow': '只执行声明工具。' },
    })
    const surface = manager.openSurface({
      surfaceId: 'workspace', moduleId: 'acme.echo.assistant', sessionId: 'session-1', projectId: null, readOnly: true,
    })
    await expect(manager.invokeSurface({
      sessionId: 'session-1', token: surface.token, method: 'load', input: {},
    })).resolves.toEqual({ loaded: true })
    expect(observedMethod).toBe('load')
  })
})
