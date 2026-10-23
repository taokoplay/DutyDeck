import { describe, expect, test } from 'bun:test'
import { parsePluginManifestV3 } from '@dutydeck/plugin-sdk'
import { ContributionRegistry } from './contribution-registry'
import { buildPluginToolProxies } from './tool-proxy'

describe('Given plugin tool proxy', () => {
  test('When Agent 调用插件工具 Then 宿主身份进入 runtime 且结果转成 Pi 内容', async () => {
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
        skillRefs: [], promptRefs: [], tools: ['inspect'], surfaces: [], services: [], artifacts: [],
      }],
      tools: [{
        id: 'inspect', ownerModuleId: 'assistant', title: 'Inspect', description: 'inspect',
        inputSchema: { type: 'object', properties: { value: { type: 'string' } }, additionalProperties: false },
        annotations: { readOnly: true, destructive: false, idempotent: true, openWorld: false },
        approval: 'none', timeoutMs: 1000,
      }],
      surfaces: [], services: [], artifacts: [], prompts: [], settings: [],
      capabilities: ['session.read'], dependencies: [], exports: [],
    })
    if (!parsed.ok) throw new Error('fixture')
    const registry = new ContributionRegistry()
    registry.register({ manifest: parsed.value, packageHash: 'a'.repeat(64) })
    let observedModule = ''
    const tools = buildPluginToolProxies({
      sdk: { defineTool: tool => tool },
      contributions: registry.toolsForModules(['acme.echo.assistant']),
      invokeTool: async (input) => {
        observedModule = input.context.moduleId
        return { echoed: input.input }
      },
      context: {
        sessionId: 'session-1',
        projectId: 'project-1',
        runId: 'run-1',
        settingsRevision: 1,
        settings: {},
        deadline: Date.now() + 5000,
      },
    })
    const result = await tools[0]!.execute('call-1', { value: 'hello' }, undefined, undefined, {} as never)
    expect(observedModule).toBe('acme.echo.assistant')
    expect(result.details).toEqual({ echoed: { value: 'hello' } })
    expect(result.content[0]).toEqual({ type: 'text', text: JSON.stringify({ echoed: { value: 'hello' } }) })
  })
})
