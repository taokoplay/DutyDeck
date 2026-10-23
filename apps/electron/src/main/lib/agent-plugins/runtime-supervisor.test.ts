import { describe, expect, test } from 'bun:test'
import type { PluginRuntimeCommand, PluginRuntimeMessage } from '@dutydeck/plugin-sdk'
import {
  createPluginRuntimeSnapshot,
  PluginRuntimeSupervisor,
  type PluginRuntimeProcess,
} from './runtime-supervisor'

/** 创建测试用 child，允许用例主动发送 hello、响应和退出。 */
function createFakeProcess(): {
  process: PluginRuntimeProcess
  emit(message: PluginRuntimeMessage): void
  exit(code: number): void
  sent: PluginRuntimeCommand[]
} {
  const messageListeners: Array<(message: unknown) => void> = []
  const exitListeners: Array<(code: number) => void> = []
  const sent: PluginRuntimeCommand[] = []
  return {
    process: {
      postMessage(message) {
        const command = message as PluginRuntimeCommand
        sent.push(command)
        if (command.kind === 'request' && command.method === 'runtime.activate') {
          queueMicrotask(() => {
            for (const listener of messageListeners) {
              listener({
                protocolVersion: 1,
                kind: 'response',
                requestId: command.requestId,
                ok: true,
                value: { ready: true },
              } satisfies PluginRuntimeMessage)
            }
          })
        }
      },
      kill() {
        queueMicrotask(() => {
          for (const listener of exitListeners) listener(0)
        })
      },
      on(event, listener) {
        if (event === 'message') messageListeners.push(listener)
        else if (event === 'exit') exitListeners.push(listener as (code: number) => void)
      },
    },
    emit(message) {
      for (const listener of messageListeners) listener(message)
    },
    exit(code) {
      for (const listener of exitListeners) listener(code)
    },
    sent,
  }
}

/** 返回可核验的插件快照。 */
function snapshot() {
  return createPluginRuntimeSnapshot({
    pluginId: 'acme.echo',
    pluginVersion: '1.0.0',
    packageHash: 'a'.repeat(64),
    packageRoot: '/private/tmp/plugin',
    runtimeEntry: 'runtime/main.mjs',
    tools: ['echo'],
    surfaces: ['workspace'],
    services: ['index'],
    declaredModules: [{
      id: 'acme.echo.assistant',
      version: '1.0.0',
      activation: 'session-toggle',
    }],
    settingsRevision: 1,
    settings: {},
  })
}

describe('Given plugin runtime supervisor', () => {
  test('When 握手贡献与签名清单一致 Then 激活并暴露唯一实例 epoch', async () => {
    const child = createFakeProcess()
    const supervisor = new PluginRuntimeSupervisor({ createProcess: () => child.process, uuid: () => 'request-1' })
    const starting = supervisor.start(snapshot())
    child.emit({
      protocolVersion: 1,
      kind: 'event',
      requestId: 'hello',
      event: 'runtime.hello',
      payload: {
        pluginId: 'acme.echo',
        pluginVersion: '1.0.0',
        packageHash: 'a'.repeat(64),
        protocolVersion: 1,
        tools: ['echo'],
        surfaces: ['workspace'],
        services: ['index'],
      },
    })
    const state = await starting
    expect(state.state).toBe('running')
    expect(state.epoch).toBe(1)
    expect(child.sent.some(command => command.kind === 'request' && command.method === 'runtime.activate')).toBe(true)
  })

  test('When runtime 握手多报工具 Then 启动失败且不进入 running', async () => {
    const child = createFakeProcess()
    const supervisor = new PluginRuntimeSupervisor({ createProcess: () => child.process, uuid: () => 'request-1' })
    const starting = supervisor.start(snapshot())
    child.emit({
      protocolVersion: 1,
      kind: 'event',
      requestId: 'hello',
      event: 'runtime.hello',
      payload: {
        pluginId: 'acme.echo',
        pluginVersion: '1.0.0',
        packageHash: 'a'.repeat(64),
        protocolVersion: 1,
        tools: ['echo', 'forged'],
        surfaces: ['workspace'],
        services: ['index'],
      },
    })
    await expect(starting).rejects.toThrow('PLUGIN_RUNTIME_CONTRIBUTION_MISMATCH')
    expect(supervisor.listHealth()[0]?.state).toBe('failed')
  })

  test('When 工具挂起时进程退出 Then 返回稳定错误并清理在途调用', async () => {
    const child = createFakeProcess()
    const supervisor = new PluginRuntimeSupervisor({ createProcess: () => child.process, uuid: () => 'request-1' })
    const starting = supervisor.start(snapshot())
    child.emit({
      protocolVersion: 1,
      kind: 'event',
      requestId: 'hello',
      event: 'runtime.hello',
      payload: {
        pluginId: 'acme.echo',
        pluginVersion: '1.0.0',
        packageHash: 'a'.repeat(64),
        protocolVersion: 1,
        tools: ['echo'],
        surfaces: ['workspace'],
        services: ['index'],
      },
    })
    await starting
    const call = supervisor.invokeTool({
      toolId: 'echo',
      input: { message: 'hello' },
      context: {
        moduleId: 'acme.echo.assistant',
        sessionId: 'session-1',
        projectId: null,
        runId: 'run-1',
        settingsRevision: 1,
        settings: {},
        deadline: Date.now() + 5000,
      },
      signal: new AbortController().signal,
    })
    child.exit(1)
    await expect(call).rejects.toThrow('PLUGIN_RUNTIME_EXITED')
    expect(supervisor.listInvocations()).toEqual([])
  })
})
