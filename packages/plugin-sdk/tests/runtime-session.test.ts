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
      protocolVersion: 1,
      kind: 'request',
      requestId: 'activate',
      method: 'runtime.activate',
      payload: { settingsRevision: 1, settings: {} },
    })
    await session.handleCommand({
      protocolVersion: 1,
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
      protocolVersion: 1,
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
      protocolVersion: 1,
      kind: 'request',
      requestId: 'activate',
      method: 'runtime.activate',
      payload: { settingsRevision: 1, settings: {} },
    })
    const running = session.handleCommand({
      protocolVersion: 1,
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
      protocolVersion: 1,
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
      protocolVersion: 1,
      kind: 'request',
      requestId: 'activate',
      method: 'runtime.activate',
      payload: { settingsRevision: 1, settings: {} },
    })
    await session.handleCommand({
      protocolVersion: 1,
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
      protocolVersion: 1,
      kind: 'response',
      requestId: 'surface-create',
      ok: false,
      error: { code: 'PLUGIN_CAPABILITY_READ_ONLY', message: '插件调用失败', retryable: false },
    })
  })
})
