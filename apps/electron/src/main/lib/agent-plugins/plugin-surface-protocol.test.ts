import { describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parsePluginManifestV3 } from '@dutydeck/plugin-sdk'
import { AgentPluginRegistry } from '../agent-modules/plugin-registry'
import { ModuleRuntimeManager } from './module-runtime-manager'
import { setModuleRuntimeManager } from './module-runtime-bridge'
import { handlePluginSurfaceRequest, PLUGIN_SURFACE_SCHEME_PRIVILEGES } from './plugin-surface-protocol'

describe('Given plugin Surface protocol', () => {
  test('When token 请求 Surface HTML Then 返回 CSP 响应且拒绝 runtime 资源', () => {
    const root = mkdtempSync(join(tmpdir(), 'dutydeck-surface-protocol-'))
    try {
      mkdirSync(join(root, 'surfaces/workspace'), { recursive: true })
      writeFileSync(join(root, 'surfaces/workspace/index.html'), '<!doctype html><html></html>')
      const parsed = parsePluginManifestV3({
        formatVersion: 3, apiVersion: '1.0.0', id: 'acme.echo', publisherId: 'acme', version: '1.0.0',
        displayName: 'Echo', description: 'echo', license: 'MIT', profile: 'module-runtime',
        compatibility: { hostApi: '^1.0.0', runtimeProtocol: 1, platforms: ['darwin'], architectures: ['arm64'] },
        runtime: { entry: 'runtime/main.mjs', format: 'module-esm' },
        modules: [{
          id: 'assistant', displayName: 'Echo', description: 'echo', icon: 'package', activation: 'session-toggle',
          skillRefs: [], promptRefs: [], tools: [], surfaces: ['workspace'], services: [], artifacts: [],
        }],
        tools: [], services: [], artifacts: [], prompts: [], settings: [], capabilities: [], dependencies: [], exports: [],
        surfaces: [{
          id: 'workspace', ownerModuleId: 'assistant', title: 'Echo', entry: 'surfaces/workspace/index.html',
          apiVersion: 1, defaultPlacement: 'right-panel', methods: ['load'],
        }],
      })
      if (!parsed.ok) throw new Error('fixture')
      const manager = new ModuleRuntimeManager({
        moduleRegistry: new AgentPluginRegistry(),
        createSupervisor: () => ({
          start: async () => ({ pluginId: 'acme.echo', state: 'running', epoch: 1 }),
          invokeTool: async () => ({}),
          stop: async () => undefined,
        }),
      })
      manager.register({ manifest: parsed.value, packageHash: 'a'.repeat(64), packageRoot: root, prompts: {} })
      setModuleRuntimeManager(manager)
      const opened = manager.openSurface({
        surfaceId: 'workspace', moduleId: 'acme.echo.assistant', sessionId: 'session-1', projectId: null, readOnly: true,
      })
      const response = handlePluginSurfaceRequest(new Request(`dutydeck-plugin://${opened.token}/surfaces/workspace/index.html`))
      expect(response.status).toBe(200)
      expect(response.headers.get('content-security-policy')).toContain("connect-src 'none'")
      expect(response.headers.get('access-control-allow-origin')).toBe('*')
      expect(PLUGIN_SURFACE_SCHEME_PRIVILEGES.privileges.corsEnabled).toBe(true)
      expect(handlePluginSurfaceRequest(new Request(`dutydeck-plugin://${opened.token}/runtime/main.mjs`)).status).toBe(404)
    } finally {
      setModuleRuntimeManager(undefined)
      rmSync(root, { recursive: true, force: true })
    }
  })
})
