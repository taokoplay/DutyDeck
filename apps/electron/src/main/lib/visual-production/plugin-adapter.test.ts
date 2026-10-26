import { describe, expect, test } from 'bun:test'
import { VISUAL_PRODUCTION_CHANNELS, VISUAL_PRODUCTION_HOST_CAPABILITIES, VISUAL_PRODUCTION_IPC_CHANNEL_PREFIX, VISUAL_PRODUCTION_STORAGE_NAMESPACE, visualProductionModuleManifest } from '@dutydeck/shared'
import { assertVisualProductionPluginContract, createVisualProductionBuiltinPluginAdapter } from './plugin-adapter'

describe('影像模块插件边界', () => {
  test('Given 模块 manifest When 复制或修改 Then 不污染共享合同', () => {
    const first = visualProductionModuleManifest()
    first.toolRefs.push('forged.tool')
    expect(visualProductionModuleManifest().toolRefs).not.toContain('forged.tool')
    expect(VISUAL_PRODUCTION_HOST_CAPABILITIES).toContain('media-execution-context')
    expect(VISUAL_PRODUCTION_STORAGE_NAMESPACE).toBe('.dutydeck/visual-production')
    expect(VISUAL_PRODUCTION_IPC_CHANNEL_PREFIX).toBe('visual-production:')
    expect(VISUAL_PRODUCTION_CHANNELS).toEqual({ INVOKE: 'visual-production:invoke', CHANGED: 'visual-production:changed' })
  })

  test('Given 宿主生命周期 When 启停释放 Then 只调用注入端口并验证稳定合同', async () => {
    const calls: string[] = []
    const adapter = createVisualProductionBuiltinPluginAdapter({
      initialize: () => { calls.push('initialize') },
      shutdown: () => { calls.push('shutdown') },
      dispose: () => { calls.push('dispose') },
    })
    expect(() => assertVisualProductionPluginContract()).not.toThrow()
    await adapter.start?.({} as never)
    await adapter.stop?.({} as never)
    await adapter.dispose?.({} as never)
    expect(calls).toEqual(['initialize', 'shutdown', 'dispose'])
  })
})
