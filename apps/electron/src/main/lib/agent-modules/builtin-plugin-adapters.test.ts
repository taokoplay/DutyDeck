import { describe, expect, test } from 'bun:test'
import { createBuiltinAgentPluginRegistrations } from './builtin-plugin-adapters'
import type { AgentModuleManifest } from '@dutydeck/shared'

const moduleManifest: AgentModuleManifest = {
  id: 'canvas', version: '1.0.0', apiVersion: 1, displayName: '画布', description: '画布', icon: 'layout',
  scope: 'project', contributions: ['tool'], skillRefs: [], promptRefs: [], toolRefs: ['canvas.inspect'], artifactTypes: [], surfaceIds: ['canvas'], requiredPermissions: [],
}

describe('内置 Agent 插件适配器', () => {
  test('每个内置模块获得稳定的 builtin plugin manifest', () => {
    const registrations = createBuiltinAgentPluginRegistrations([moduleManifest])
    expect(registrations).toHaveLength(1)
    expect(registrations[0]?.manifest.id).toBe('builtin.canvas')
    expect(registrations[0]?.manifest.modules[0]?.id).toBe('canvas')
  })

  test('只转发注入的服务生命周期，不复制模块业务', async () => {
    const calls: string[] = []
    const [registration] = createBuiltinAgentPluginRegistrations([moduleManifest], {
      canvas: {
        start: () => { calls.push('start') },
        stop: () => { calls.push('stop') },
        dispose: () => { calls.push('dispose') },
      },
    })
    await registration?.lifecycle.start?.({ pluginId: 'builtin.canvas', manifest: registration.manifest })
    await registration?.lifecycle.stop?.({ pluginId: 'builtin.canvas', manifest: registration.manifest })
    await registration?.lifecycle.dispose?.({ pluginId: 'builtin.canvas', manifest: registration.manifest })
    expect(calls).toEqual(['start', 'stop', 'dispose'])
  })
})
