import { describe, expect, test } from 'bun:test'
import type { PluginRuntimeCommand, PluginRuntimeMessage } from '@dutydeck/plugin-sdk'
import {
  createPluginRuntimeSnapshot,
  PluginRuntimeSupervisor,
  type PluginRuntimeProcess,
  type PluginRuntimeSupervisorDependencies,
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
                protocolVersion: 2,
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

/** 为调用身份用例启动具有真实请求序列的测试实例。 */
async function startInvocationFixture(onCapabilityRequest: PluginRuntimeSupervisorDependencies['onCapabilityRequest'], invocationTimeoutGraceMs?: number) {
  const child = createFakeProcess()
  let nextId = 0
  const supervisor = new PluginRuntimeSupervisor({
    createProcess: () => child.process,
    uuid: () => `request-${++nextId}`,
    onCapabilityRequest,
    invocationTimeoutGraceMs,
  })
  const starting = supervisor.start(snapshot())
  child.emit({
    protocolVersion: 2,
    kind: 'event',
    requestId: 'hello',
    event: 'runtime.hello',
    payload: {
      pluginId: 'acme.echo', pluginVersion: '1.0.0', packageHash: 'a'.repeat(64),
      protocolVersion: 2, tools: ['echo'], surfaces: ['workspace'], services: ['index'],
    },
  })
  await starting
  const invoke = (sessionId: string, timeoutMs = 5000) => {
    const controller = new AbortController()
    const result = supervisor.invokeTool({
      toolId: 'echo', input: {}, signal: controller.signal,
      context: {
        moduleId: 'acme.echo.assistant', sessionId, projectId: `${sessionId}-project`,
        runId: `${sessionId}-run`, settingsRevision: 1, settings: {}, deadline: Date.now() + timeoutMs,
      },
    }).catch((error: unknown) => error)
    const command = child.sent.at(-1)
    if (command?.kind !== 'request' || command.method !== 'tool.invoke') throw new Error('missing test invocation')
    return { controller, result, command }
  }
  const capability = (invocationId: string, requestId: string, capability: 'session.read' | 'plugin.state.read' = 'session.read') => {
    child.emit({
      protocolVersion: 2, kind: 'request', requestId, method: 'capability.invoke',
      payload: { invocationId, capability, input: {} },
    })
  }
  return { child, supervisor, invoke, capability }
}

describe('Given plugin runtime supervisor', () => {
  test('When 握手贡献与签名清单一致 Then 激活并暴露唯一实例 epoch', async () => {
    const child = createFakeProcess()
    const supervisor = new PluginRuntimeSupervisor({ createProcess: () => child.process, uuid: () => 'request-1' })
    const starting = supervisor.start(snapshot())
    child.emit({
      protocolVersion: 2,
      kind: 'event',
      requestId: 'hello',
      event: 'runtime.hello',
      payload: {
        pluginId: 'acme.echo',
        pluginVersion: '1.0.0',
        packageHash: 'a'.repeat(64),
        protocolVersion: 2,
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
      protocolVersion: 2,
      kind: 'event',
      requestId: 'hello',
      event: 'runtime.hello',
      payload: {
        pluginId: 'acme.echo',
        pluginVersion: '1.0.0',
        packageHash: 'a'.repeat(64),
        protocolVersion: 2,
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
      protocolVersion: 2,
      kind: 'event',
      requestId: 'hello',
      event: 'runtime.hello',
      payload: {
        pluginId: 'acme.echo',
        pluginVersion: '1.0.0',
        packageHash: 'a'.repeat(64),
        protocolVersion: 2,
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

  test('When 两个会话逆序发起能力调用 Then 严格使用各自 invocation 的上下文', async () => {
    const observed: Array<{ sessionId: string | null; runId: string | null; moduleId: string | null }> = []
    const fixture = await startInvocationFixture(async (request) => {
      observed.push({ sessionId: request.sessionId, runId: request.runId, moduleId: request.moduleId })
      return { ok: true, value: {} }
    })
    const first = fixture.invoke('first')
    const second = fixture.invoke('second')
    fixture.capability(second.command.payload.invocationId, 'cap-second')
    fixture.capability(first.command.payload.invocationId, 'cap-first')
    await Promise.resolve()
    first.controller.abort()
    second.controller.abort()
    await Promise.all([first.result, second.result])
    fixture.supervisor.killCurrent()
    expect(observed).toEqual([
      { sessionId: 'second', runId: 'second-run', moduleId: 'acme.echo.assistant' },
      { sessionId: 'first', runId: 'first-run', moduleId: 'acme.echo.assistant' },
    ])
  })

  test('When invocation 伪造或已经取消 Then 不调用宿主能力', async () => {
    const observed: string[] = []
    const fixture = await startInvocationFixture(async (request) => {
      observed.push(request.invocationId ?? '')
      return { ok: true, value: {} }
    })
    const call = fixture.invoke('first')
    fixture.capability('forged', 'cap-forged')
    call.controller.abort()
    await call.result
    fixture.capability(call.command.payload.invocationId, 'cap-late')
    await Promise.resolve()
    fixture.supervisor.killCurrent()
    expect(observed).toEqual([])
  })

  test('When 实例状态调用与会话工具并行 Then 不借用会话身份且拒绝实例读取会话', async () => {
    const observed: Array<{ capability: string; sessionId: string | null; runId: string | null }> = []
    const fixture = await startInvocationFixture(async (request) => {
      observed.push({ capability: request.capability, sessionId: request.sessionId, runId: request.runId })
      return { ok: true, value: {} }
    })
    const call = fixture.invoke('first')
    fixture.capability('plugin-instance', 'state', 'plugin.state.read')
    fixture.capability('plugin-instance', 'session')
    await Promise.resolve()
    call.controller.abort()
    await call.result
    fixture.supervisor.killCurrent()
    expect(observed).toEqual([])
  })
})

describe('Given 宿主签发的能力租约', () => {
  for (const terminal of ['cancel', 'complete', 'kill', 'stop', 'exit'] as const) {
    test(`When 调用进入 ${terminal} Then 在途能力信号立即取消且提交检查失效`, async () => {
      let lease: Parameters<NonNullable<PluginRuntimeSupervisorDependencies['onCapabilityRequest']>>[0] | undefined
      const fixture = await startInvocationFixture(async (request) => {
        lease = request
        return { ok: true, value: {} }
      })
      const call = fixture.invoke('lease')
      fixture.capability(call.command.payload.invocationId, 'lease-cap')
      await Promise.resolve()
      let stopping: Promise<void> | undefined
      if (terminal === 'cancel') call.controller.abort()
      if (terminal === 'complete') fixture.child.emit({ protocolVersion: 2, kind: 'response', requestId: call.command.requestId, ok: true, value: {} })
      if (terminal === 'kill') fixture.supervisor.killCurrent()
      if (terminal === 'exit') fixture.child.exit(1)
      if (terminal === 'stop') stopping = fixture.supervisor.stop()
      // kill 的 exit 事件尚未到达；宿主必须已经使租约失效。
      const aborted = lease?.signal?.aborted
      let code = ''
      try { lease?.assertCurrent?.() } catch (error) { code = error instanceof Error ? error.message : '' }
      if (stopping) {
        const dispose = fixture.child.sent.at(-1)!
        fixture.child.emit({ protocolVersion: 2, kind: 'response', requestId: dispose.requestId, ok: true, value: {} })
        await stopping
      }
      call.controller.abort()
      await call.result
      fixture.supervisor.killCurrent()
      expect(aborted).toBe(true)
      expect(code).toBe('PLUGIN_CAPABILITY_STALE')
    })
  }

  test('When deadline 已到但 RPC 宽限仍在 Then 不能继续请求能力或提交副作用', async () => {
    const observed: Array<Parameters<NonNullable<PluginRuntimeSupervisorDependencies['onCapabilityRequest']>>[0]> = []
    const fixture = await startInvocationFixture(async (request) => {
      observed.push(request)
      return { ok: true, value: {} }
    })
    const call = fixture.invoke('deadline', 30)
    fixture.capability(call.command.payload.invocationId, 'before-deadline')
    await Bun.sleep(50)
    fixture.capability(call.command.payload.invocationId, 'after-deadline')
    const aborted = observed[0]?.signal?.aborted
    let code = ''
    try { observed[0]?.assertCurrent?.() } catch (error) { code = error instanceof Error ? error.message : '' }
    call.controller.abort()
    await call.result
    fixture.supervisor.killCurrent()
    expect(observed).toHaveLength(1)
    expect(aborted).toBe(true)
    expect(code).toBe('PLUGIN_CAPABILITY_STALE')
  })
})

describe('Given 不可信 RPC 与启动中终止', () => {
  test('When response 缺 error/ok 或有非法 JSON Then 不抛出消息回调且等待者稳定失败', async () => {
    for (const response of [{ ok: false }, { ok: false, error: null }, { ok: 'yes', value: {} }, { ok: true, value: 1n }]) {
      const f = await startInvocationFixture(undefined)
      const call = f.invoke('bad-response')
      let thrown: unknown
      try { f.child.emit({ protocolVersion: 2, kind: 'response', requestId: call.command.requestId, ...response } as PluginRuntimeMessage) } catch (error) { thrown = error }
      const outcome = await Promise.race([call.result, Bun.sleep(25).then(() => 'unsettled')])
      f.supervisor.killCurrent()
      expect(thrown).toBeUndefined()
      expect(outcome).toBeInstanceOf(Error)
      expect(f.supervisor.listHealth()[0]?.state).not.toBe('running')
    }
  })
  test('When hello 之前停止且 exit 异步到达 Then start Promise 有界拒绝', async () => {
    const child = createFakeProcess()
    const supervisor = new PluginRuntimeSupervisor({ createProcess: () => child.process, startupTimeoutMs: 30 })
    const start = supervisor.start(snapshot()).catch(error => error)
    const stop = supervisor.stop()
    const dispose = child.sent.at(-1)!
    child.emit({ protocolVersion: 2, kind: 'response', requestId: dispose.requestId, ok: true, value: {} })
    await stop
    const outcome = await Promise.race([start, Bun.sleep(50).then(() => 'unsettled')])
    expect(outcome).toBeInstanceOf(Error)
    expect(supervisor.listHealth()[0]?.state).toBe('stopped')
  })
  test('When 已运行实例使用 plugin-instance 写状态 Then 不因当前调用只读或取消而绕过', async () => {
    const observed: unknown[] = []
    const f = await startInvocationFixture(async request => { observed.push(request); return { ok: true, value: {} } })
    f.child.emit({ protocolVersion: 2, kind: 'request', requestId: 'write-state', method: 'capability.invoke', payload: { invocationId: 'plugin-instance', capability: 'plugin.state.write', input: { key: 'draft', value: {}, schemaVersion: 1 } } })
    await Promise.resolve()
    f.supervisor.killCurrent()
    expect(observed).toEqual([])
  })
})

test('Given 激活阶段实例状态 When hello 前读取且 hello 后复核 Then 不借用会话并只在激活期间有效', async () => {
  const child = createFakeProcess()
  let lease: Parameters<NonNullable<PluginRuntimeSupervisorDependencies['onCapabilityRequest']>>[0] | undefined
  const supervisor = new PluginRuntimeSupervisor({ createProcess: () => child.process, onCapabilityRequest: async request => { lease = request; return { ok: true, value: null } } })
  const starting = supervisor.start(snapshot())
  child.emit({ protocolVersion: 2, kind: 'request', requestId: 'state', method: 'capability.invoke', payload: { invocationId: 'plugin-instance', capability: 'plugin.state.read', input: { key: 'boot', schemaVersion: 1 } } })
  await Promise.resolve()
  expect(lease?.sessionId).toBeNull()
  expect(() => lease?.assertCurrent()).not.toThrow()
  child.emit({ protocolVersion: 2, kind: 'event', requestId: 'hello', event: 'runtime.hello', payload: { pluginId: 'acme.echo', pluginVersion: '1.0.0', packageHash: 'a'.repeat(64), protocolVersion: 2, tools: ['echo'], surfaces: ['workspace'], services: ['index'] } })
  await starting
  expect(() => lease?.assertCurrent()).toThrow('PLUGIN_CAPABILITY_STALE')
  supervisor.killCurrent()
})

test('Given 无调用身份的激活窗口 When 尝试写状态 Then 即使有包授权也不能绕过只读与取消上限', async () => {
  const child = createFakeProcess()
  let writes = 0
  const supervisor = new PluginRuntimeSupervisor({ createProcess: () => child.process, onCapabilityRequest: async () => { writes++; return { ok: true, value: null } } })
  const starting = supervisor.start(snapshot()).catch(() => undefined)
  child.emit({ protocolVersion: 2, kind: 'request', requestId: 'write', method: 'capability.invoke', payload: { invocationId: 'plugin-instance', capability: 'plugin.state.write', input: {} } })
  await Promise.resolve()
  expect(writes).toBe(0)
  supervisor.killCurrent()
  await starting
})

test('Given 取消端口已关闭 When 发送 cancel 抛错 Then 原请求仍结算并隔离失败实例', async () => {
  const fixture = await startInvocationFixture(async () => ({ ok: true, value: null }))
  const running = fixture.invoke('session')
  fixture.child.process.postMessage = () => { throw new Error('port closed') }
  // 捕获旧实现的异常，避免它作为全局未处理异常干扰其它用例。
  let thrown = false
  const listener = () => { thrown = true }
  process.on('uncaughtException', listener)
  try {
    running.controller.abort()
    const result = await Promise.race([running.result, new Promise(resolve => setTimeout(() => resolve('hung'), 50))])
    expect(result).toBeInstanceOf(Error)
    expect(thrown).toBe(false)
  } finally {
    process.removeListener('uncaughtException', listener)
    fixture.supervisor.killCurrent()
  }
})

describe('Given runtime 不响应截止时间或取消', () => {
  test('When RPC 超过截止与宽限 Then 终止实例并使其它在途调用失败', async () => {
    const fixture = await startInvocationFixture(undefined, 5)
    const timedOut = fixture.invoke('timeout', 20)
    const sibling = fixture.invoke('sibling')
    expect(String(await timedOut.result)).toContain('PLUGIN_RPC_TIMEOUT')
    expect(fixture.supervisor.listHealth()[0]?.state).toBe('failed')
    expect(fixture.supervisor.listInvocations()).toEqual([])
    expect(String(await sibling.result)).toContain('PLUGIN_RPC_TIMEOUT')
  })

  test('When 取消后未返回响应 Then 有界宽限后终止；收到迟到完成则保留健康实例', async () => {
    for (const responds of [false, true]) {
      const fixture = await startInvocationFixture(undefined, 15)
      const pending = fixture.invoke('cancel')
      pending.controller.abort()
      expect(String(await pending.result)).toContain('PLUGIN_TOOL_CANCELLED')
      if (responds) fixture.child.emit({ protocolVersion: 2, kind: 'response', requestId: pending.command.requestId, ok: true, value: { late: true } })
      await new Promise(resolve => setTimeout(resolve, 30))
      expect(fixture.supervisor.listHealth()[0]?.state).toBe(responds ? 'running' : 'failed')
      expect(fixture.supervisor.listInvocations()).toEqual([])
      fixture.supervisor.killCurrent()
    }
  })
})

test('Given 八个取消仍未确认的调用 When 新调用进入 Then 继续占用并发预算而不是无限积累计时器', async () => {
  const fixture = await startInvocationFixture(undefined, 1000)
  try {
    for (let index = 0; index < 8; index++) {
      const pending = fixture.invoke(`cancel-${index}`)
      pending.controller.abort()
      await pending.result
    }
    await expect(fixture.supervisor.invokeTool({
      toolId: 'echo', input: {}, signal: new AbortController().signal,
      context: { moduleId: 'acme.echo.assistant', sessionId: 'next', projectId: null, runId: 'next:1', settingsRevision: 0, settings: {}, deadline: Date.now() + 5000 },
    })).rejects.toThrow('PLUGIN_RUNTIME_BUSY')
  } finally { fixture.supervisor.killCurrent() }
})
