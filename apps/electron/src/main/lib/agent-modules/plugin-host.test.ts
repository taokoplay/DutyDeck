import { describe, expect, test } from 'bun:test'
import type { AgentPluginManifest } from '@dutydeck/shared'
import { AgentPluginHost } from './plugin-host'

const manifest: AgentPluginManifest = {
  id: 'builtin.canvas',
  version: '1.0.0',
  apiVersion: 1,
  displayName: '画布',
  description: '画布模块',
  modules: [],
  entry: { kind: 'manifest-only' },
}

describe('Agent Plugin Host', () => {
  test('完整生命周期按注册顺序启动、逆序停止并释放', async () => {
    const calls: string[] = []
    const host = new AgentPluginHost()
    await host.register({
      manifest,
      lifecycle: {
        register: () => { calls.push('register') },
        start: () => { calls.push('start') },
        stop: () => { calls.push('stop') },
        dispose: () => { calls.push('dispose') },
      },
    })

    await host.start()
    await host.stop()
    await host.dispose()

    expect(calls).toEqual(['register', 'start', 'stop', 'dispose'])
    expect(host.listHealth()[0]?.state).toBe('stopped')
  })

  test('重复 stop 不会重复调用适配器', async () => {
    let stopCount = 0
    const host = new AgentPluginHost()
    await host.register({ manifest, lifecycle: { stop: () => { stopCount += 1 } } })
    await host.start()
    await host.stop()
    await host.stop()
    expect(stopCount).toBe(1)
  })

  test('启动失败只标记自身并继续启动其它插件', async () => {
    const host = new AgentPluginHost()
    const secondManifest = { ...manifest, id: 'builtin.browser' }
    await host.register({ manifest, lifecycle: { start: () => { throw new Error('boom') } } })
    await host.register({ manifest: secondManifest, lifecycle: { start: () => undefined } })

    const health = await host.start()
    expect(health.map((entry) => [entry.pluginId, entry.state])).toEqual([
      ['builtin.canvas', 'failed'],
      ['builtin.browser', 'running'],
    ])
    expect(health[0]?.errorCode).toBe('AGENT_PLUGIN_HOST_LIFECYCLE_FAILED')
  })

  test('健康事件可订阅和取消订阅', async () => {
    const host = new AgentPluginHost()
    const events: string[] = []
    const unsubscribe = host.subscribe((event) => events.push(`${event.health.pluginId}:${event.health.state}`))
    await host.register({ manifest, lifecycle: {} })
    unsubscribe()
    await host.start()
    expect(events).toContain('builtin.canvas:registered')
    expect(events).not.toContain('builtin.canvas:starting')
  })

  test('重复 plugin ID 被拒绝，dispose 会先停止运行中插件', async () => {
    const host = new AgentPluginHost()
    let stopCount = 0
    await host.register({ manifest, lifecycle: { stop: () => { stopCount += 1 } } })
    await expect(host.register({ manifest, lifecycle: {} })).rejects.toThrow('AGENT_PLUGIN_HOST_DUPLICATE:builtin.canvas')
    await host.start()
    await host.dispose()
    expect(stopCount).toBe(1)
  })
})
