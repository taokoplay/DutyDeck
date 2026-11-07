import { describe, expect, test } from 'bun:test'
import {
  createPluginRuntimeSession,
  definePlugin,
  type PluginRuntimeMessage,
} from '../src/index.js'

/** 创建有界消息记录器，模拟 utility parentPort。 */
function transport() {
  const messages: PluginRuntimeMessage[] = []
  return {
    messages,
    postMessage(message: PluginRuntimeMessage) {
      messages.push(message)
    },
  }
}

/** 构造最小 runtime session 输入。 */
function createInput(messages: ReturnType<typeof transport>) {
  let id = 0
  return {
    definition: definePlugin({
      activate(context) {
        context.tools.handle('echo', (input) => ({ echoed: (input as { message: string }).message }))
        context.surfaces.handle('workspace', 'load', () => ({ loaded: true }))
        context.services.handle('index', { start() {} })
      },
    }),
    transport: messages,
    plugin: {
      id: 'acme.echo',
      version: '1.0.0',
      packageHash: 'a'.repeat(64),
    },
    declaredModules: [{
      id: 'acme.echo.assistant',
      version: '1.0.0',
      activation: 'session-toggle' as const,
    }],
    settingsRevision: 1,
    settings: {},
    uuid: () => `request-${++id}`,
    invokeCapability: async () => null,
    state: {
      read: async () => null,
      readRecord: async () => null,
      write: async () => ({ revision: 1 }),
    },
  }
}

describe('Given plugin runtime session', () => {
  test('When 插件注册工具和服务 Then hello 输出精确贡献清单', async () => {
    const port = transport()
    const session = await createPluginRuntimeSession(createInput(port))
    expect(session.hello.tools).toEqual(['echo'])
    expect(session.hello.surfaces).toEqual(['workspace'])
    expect(session.hello.services).toEqual(['index'])
    expect(port.messages[0]?.kind).toBe('event')
  })

  test('When 宿主调用已注册工具 Then 使用 toolId 分发并返回结果', async () => {
    const port = transport()
    const session = await createPluginRuntimeSession(createInput(port))
    await session.handleCommand({
      protocolVersion: 2,
      kind: 'request',
      requestId: 'activate',
      method: 'runtime.activate',
      payload: { settingsRevision: 1, settings: {} },
    })
    await session.handleCommand({
      protocolVersion: 2,
      kind: 'request',
      requestId: 'tool-call',
      method: 'tool.invoke',
      payload: {
        invocationId: 'invocation-1',
        toolId: 'echo',
        moduleId: 'acme.echo.assistant',
        sessionId: 'session-1',
        projectId: null,
        runId: 'run-1',
        settingsRevision: 1,
        settings: {},
        input: { message: 'hello' },
        deadline: Date.now() + 1000,
      },
    })
    expect(port.messages.find(message => message.kind === 'response' && message.requestId === 'tool-call')).toEqual({
      protocolVersion: 2,
      kind: 'response',
      requestId: 'tool-call',
      ok: true,
      value: { echoed: 'hello' },
    })
  })

  test('When 宿主取消工具 requestId Then handler 收到 AbortSignal', async () => {
    const port = transport()
    const input = createInput(port)
    let aborted = false
    input.definition = definePlugin({
      activate(context) {
        context.tools.handle('echo', async (_value, call) => {
          await new Promise<void>(resolve => {
            call.signal.addEventListener('abort', () => {
              aborted = true
              resolve()
            }, { once: true })
          })
          return { aborted }
        })
      },
    })
    const session = await createPluginRuntimeSession(input)
    await session.handleCommand({
      protocolVersion: 2,
      kind: 'request',
      requestId: 'activate',
      method: 'runtime.activate',
      payload: { settingsRevision: 1, settings: {} },
    })
    const running = session.handleCommand({
      protocolVersion: 2,
      kind: 'request',
      requestId: 'tool-cancel',
      method: 'tool.invoke',
      payload: {
        invocationId: 'invocation-cancel',
        toolId: 'echo',
        moduleId: 'acme.echo.assistant',
        sessionId: 'session-1',
        projectId: null,
        runId: 'run-1',
        settingsRevision: 1,
        settings: {},
        input: { message: 'wait' },
        deadline: Date.now() + 1000,
      },
    })
    await session.handleCommand({
      protocolVersion: 2,
      kind: 'cancel',
      requestId: 'cancel',
      targetRequestId: 'tool-cancel',
      reason: 'abort',
    })
    await running
    expect(aborted).toBe(true)
  })

  test('When Surface 能力被宿主拒绝 Then 保留稳定错误码供界面提示', async () => {
    const port = transport()
    const input = createInput(port)
    input.definition = definePlugin({
      activate(context) {
        context.surfaces.handle('workspace', 'create', (_value, call) => (
          call.capabilities.request('artifact.write', {})
        ))
      },
    })
    input.invokeCapability = async () => {
      throw new Error('PLUGIN_CAPABILITY_READ_ONLY')
    }
    const session = await createPluginRuntimeSession(input)
    await session.handleCommand({
      protocolVersion: 2,
      kind: 'request',
      requestId: 'activate',
      method: 'runtime.activate',
      payload: { settingsRevision: 1, settings: {} },
    })
    await session.handleCommand({
      protocolVersion: 2,
      kind: 'request',
      requestId: 'surface-create',
      method: 'surface.invoke',
      payload: {
        invocationId: 'surface-invocation',
        surfaceId: 'workspace',
        method: 'create',
        moduleId: 'acme.echo.assistant',
        sessionId: 'session-1',
        projectId: null,
        runId: 'run-1',
        readOnly: true,
        settingsRevision: 1,
        settings: {},
        input: {},
        deadline: Date.now() + 1000,
      },
    })
    expect(port.messages.find(message => message.kind === 'response' && message.requestId === 'surface-create')).toEqual({
      protocolVersion: 2,
      kind: 'response',
      requestId: 'surface-create',
      ok: false,
      error: { code: 'PLUGIN_CAPABILITY_READ_ONLY', message: '插件调用失败', retryable: false },
    })
  })
})

describe('Given 冻结的设置快照', () => {
  test('When 外部参数变化和 runtime.configure Then 旧快照不变且新快照按 revision 更新', async () => {
    const port = transport()
    const settings = { mode: 'first' }
    let context!: import('../src/runtime-api.js').PluginRuntimeContext
    const session = await createPluginRuntimeSession({
      ...createInput(port), settings,
      definition: definePlugin({ activate(value) { context = value } }),
    })
    const original = context.settings
    settings.mode = 'mutated'
    expect(original.mode).toBe('first')
    expect(Object.isFrozen(original)).toBe(true)
    await session.handleCommand({ protocolVersion: 2, kind: 'request', requestId: 'configure', method: 'runtime.configure', payload: { settingsRevision: 2, settings: { mode: 'second' } } })
    expect(context.settings.mode).toBe('second')
    expect(original.mode).toBe('first')
    await session.handleCommand({ protocolVersion: 2, kind: 'request', requestId: 'stale', method: 'runtime.configure', payload: { settingsRevision: 1, settings: { mode: 'old' } } })
    expect(context.settings.mode).toBe('second')
    expect(port.messages.at(-1)).toMatchObject({ kind: 'response', requestId: 'stale', ok: false, error: { code: 'PLUGIN_SETTINGS_REVISION_CONFLICT' } })
  })
})

test('Given 实例状态只限激活阶段 When activate 完成后使用实例 state Then 明确要求调用级入口', async () => {
  const port = transport()
  let context!: import('../src/runtime-api.js').PluginRuntimeContext
  const session = await createPluginRuntimeSession({ ...createInput(port), definition: definePlugin({ async activate(value) { context = value; await value.state.read('boot') } }) })
  // @ts-expect-error 验证旧JS代码绕过类型时仍收到稳定拒绝。
  await expect(context.state.write('late', {}, { schemaVersion: 1 })).rejects.toThrow('PLUGIN_STATE_REQUIRES_INVOCATION')
  await session.handleCommand({ protocolVersion: 2, kind: 'request', requestId: 'dispose', method: 'runtime.dispose', payload: {} })
})

test('Given 并发调用状态入口 When 工具结束后保留 state Then 原 invocation 失效且不借用另一调用', async () => {
  const port = transport()
  const scopes: string[] = []
  let retained!: import('../src/runtime-api.js').PluginStateApi
  const session = await createPluginRuntimeSession({ ...createInput(port),
    invokeCapability: async (_capability, _input, invocationId) => { scopes.push(invocationId); return { schemaVersion: 1, revision: 1, value: invocationId } },
    definition: definePlugin({ activate(context) { context.tools.handle('echo', async (_input, call) => { retained = call.state; return await call.state.read('key') }) } }),
  })
  await session.handleCommand({ protocolVersion: 2, kind: 'request', requestId: 'activate', method: 'runtime.activate', payload: { settingsRevision: 1, settings: {} } })
  const tool = (id: string): import('../src/runtime-protocol.js').PluginRuntimeCommand => ({ protocolVersion: 2, kind: 'request', requestId: id, method: 'tool.invoke', payload: { invocationId: id, toolId: 'echo', moduleId: 'acme.echo.assistant', sessionId: id, projectId: null, runId: id, settingsRevision: 1, settings: {}, input: {}, deadline: Date.now() + 1000 } })
  await Promise.all([session.handleCommand(tool('one')), session.handleCommand(tool('two'))])
  expect(scopes).toEqual(['one', 'two'])
  await expect(retained.write('late', {}, { schemaVersion: 1 })).rejects.toThrow('PLUGIN_CAPABILITY_STALE')
  expect(scopes).toHaveLength(2)
})

test('Given contract2 session When JS调用方传入旧协议信封 Then 拒绝且不激活session', async () => {
  const port = transport()
  const session = await createPluginRuntimeSession(createInput(port))
  await expect(session.handleCommand({ protocolVersion: 1, kind: 'request', requestId: 'old', method: 'runtime.activate', payload: { settingsRevision: 1, settings: {} } } as unknown as import('../src/runtime-protocol.js').PluginRuntimeCommand)).rejects.toThrow('PLUGIN_RUNTIME_PROTOCOL_UNSUPPORTED')
  expect(port.messages).toHaveLength(1)
  expect(session.hello.protocolVersion).toBe(2)
})
