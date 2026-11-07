import { describe, expect, test } from 'bun:test'
import {
  CapabilityBroker,
  type TrustedPluginCaller,
} from './capability-broker'

/** 构造只由宿主签发的调用身份。 */
function caller(overrides: Partial<TrustedPluginCaller> = {}): TrustedPluginCaller {
  return {
    pluginId: 'acme.echo',
    pluginVersion: '1.0.0',
    packageHash: 'a'.repeat(64),
    moduleId: 'acme.echo.assistant',
    sessionId: 'session-1',
    projectId: 'project-1',
    runId: 'run-1',
    invocationId: 'invocation-1',
    grants: ['project.files.read'],
    signal: new AbortController().signal, assertCurrent: () => undefined,
    ...overrides,
  }
}

describe('Given capability broker', () => {
  test('When 未授权 project.write Then provider 不会被调用', async () => {
    let calls = 0
    const broker = new CapabilityBroker({
      providers: new Map([['project.files.write', async () => {
        calls += 1
        return { written: true }
      }]]),
    })
    await expect(broker.invoke(caller(), {
      capability: 'project.files.write',
      input: { relativePath: 'a.md', content: 'x' },
    })).rejects.toThrow('PLUGIN_CAPABILITY_NOT_GRANTED')
    expect(calls).toBe(0)
  })

  test('When provider 执行前租约失效 Then 拒绝且不返回结果', async () => {
    const broker = new CapabilityBroker({
      providers: new Map([['project.files.read', async () => ({ content: 'secret' })]]),
    })
    await expect(broker.invoke(caller({ assertCurrent: () => { throw new Error('stale') } }), {
      capability: 'project.files.read',
      input: { relativePath: 'a.md' },
    })).rejects.toThrow('PLUGIN_CAPABILITY_STALE')
  })

  test('When provider 返回非 JSON 或超预算 Then 统一失败', async () => {
    const broker = new CapabilityBroker({
      providers: new Map([
        ['project.files.read', async () => ({ content: 'x'.repeat(1024 * 1024 + 1) })],
      ]),
    })
    await expect(broker.invoke(caller(), {
      capability: 'project.files.read',
      input: { relativePath: 'a.md' },
    })).rejects.toThrow('PLUGIN_CAPABILITY_RESULT_TOO_LARGE')
  })

  test('When provider 抛出稳定插件错误码 Then 原样保留且不泄露任意异常正文', async () => {
    const broker = new CapabilityBroker({
      providers: new Map([['project.files.read', async ({ caller: pluginCaller }) => {
        if (pluginCaller.invocationId === 'read-only') throw new Error('PLUGIN_CAPABILITY_READ_ONLY')
        throw new Error('/private/secret/path')
      }]]),
    })
    await expect(broker.invoke(caller({ invocationId: 'read-only' }), {
      capability: 'project.files.read',
      input: {},
    })).rejects.toThrow('PLUGIN_CAPABILITY_READ_ONLY')
    await expect(broker.invoke(caller({ invocationId: 'path-leak' }), {
      capability: 'project.files.read',
      input: {},
    })).rejects.toThrow('PLUGIN_CAPABILITY_FAILED')
  })

  test('When 已授权 Then 使用宿主注入 caller 并返回结果', async () => {
    let observed = ''
    const broker = new CapabilityBroker({
      providers: new Map([['project.files.read', async (input) => {
        observed = input.caller.invocationId
        return { content: 'ok' }
      }]]),
    })
    await expect(broker.invoke(caller(), {
      capability: 'project.files.read',
      input: { relativePath: 'a.md' },
    })).resolves.toEqual({ content: 'ok' })
    expect(observed).toBe('invocation-1')
  })
})

describe('Given 真实调用的取消信号', () => {
  test('When 能力调用前已取消 Then 不进入 provider', async () => {
    let calls = 0
    const broker = new CapabilityBroker({ providers: new Map([['project.files.read', async () => { calls++; return {} }]]) })
    const controller = new AbortController()
    controller.abort()
    await expect(broker.invoke(caller({ signal: controller.signal }), { capability: 'project.files.read', input: {} })).rejects.toThrow('PLUGIN_CAPABILITY_STALE')
    expect(calls).toBe(0)
  })

  test('When provider 等待期间取消 Then 收到同一信号且迟到结果不返回', async () => {
    const controller = new AbortController()
    let observed: AbortSignal | undefined
    let finish!: () => void
    const gate = new Promise<void>(resolve => { finish = resolve })
    const broker = new CapabilityBroker({ providers: new Map([['project.files.read', async ({ signal }) => {
      observed = signal
      await gate
      return { content: 'late' }
    }]]) })
    const result = broker.invoke(caller({ signal: controller.signal }), { capability: 'project.files.read', input: {} }).catch((error: unknown) => error)
    controller.abort()
    finish()
    expect(observed).toBe(controller.signal)
    expect(await result).toMatchObject({ code: 'PLUGIN_CAPABILITY_STALE' })
  })
})
