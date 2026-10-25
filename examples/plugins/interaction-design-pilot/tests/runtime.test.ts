import { describe, expect, test } from 'bun:test'
import {
  createPluginRuntimeSession,
  type PluginCapabilityId,
  type PluginRuntimeMessage,
} from '@dutydeck/plugin-sdk'
import runtime from '../src/runtime'

/** 记录插件发出到宿主的 RPC 消息。 */
function createTransport(): {
  messages: PluginRuntimeMessage[]
  postMessage(message: PluginRuntimeMessage): void
} {
  const messages: PluginRuntimeMessage[] = []
  return { messages, postMessage: message => { messages.push(message) } }
}

describe('Given 交互设计试点插件 runtime', () => {
  test('When 激活 Then 同时发布 Agent 工具和右侧 Surface', async () => {
    const transport = createTransport()
    let requestId = 0
    const session = await createPluginRuntimeSession({
      definition: runtime,
      transport,
      plugin: {
        id: 'dutydeck.interaction-design-pilot',
        version: '1.0.8',
        packageHash: 'a'.repeat(64),
      },
      declaredModules: [{
        id: 'dutydeck.interaction-design-pilot.workspace',
        version: '1.0.8',
        activation: 'session-toggle',
      }],
      settingsRevision: 1,
      settings: {},
      uuid: () => `request-${++requestId}`,
      invokeCapability: async () => null,
      state: {
        read: async () => null,
        write: async () => ({ revision: 1 }),
      },
    })
    expect(session.hello.tools).toEqual([
      'adopt',
      'create',
      'list',
      'propose',
      'read',
      'read-source',
    ])
    expect(session.hello.surfaces).toEqual(['workspace'])
  })

  test('When Agent 调用 create Then artifact 能力使用当前 invocation 身份', async () => {
    const transport = createTransport()
    let requestId = 0
    const requestedCapabilities: PluginCapabilityId[] = []
    const artifacts = new Map<string, unknown>()
    let revision = 0
    const session = await createPluginRuntimeSession({
      definition: runtime,
      transport,
      plugin: {
        id: 'dutydeck.interaction-design-pilot',
        version: '1.0.8',
        packageHash: 'a'.repeat(64),
      },
      declaredModules: [{
        id: 'dutydeck.interaction-design-pilot.workspace',
        version: '1.0.8',
        activation: 'session-toggle',
      }],
      settingsRevision: 1,
      settings: {},
      uuid: () => `request-${++requestId}`,
      invokeCapability: async (id, input) => {
        requestedCapabilities.push(id)
        if (id === 'artifact.read') return artifacts.get('workspace') ?? null
        if (id === 'artifact.write') {
          const request = input as { value: unknown }
          revision += 1
          const record = { schemaVersion: 1, revision, updatedAt: 1, value: structuredClone(request.value) }
          artifacts.set('workspace', record)
          return { revision, updatedAt: 1 }
        }
        throw new Error('unexpected capability')
      },
      state: {
        read: async () => null,
        write: async () => ({ revision: 1 }),
      },
    })
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
      requestId: 'tool-create',
      method: 'tool.invoke',
      payload: {
        invocationId: 'invoke-create',
        toolId: 'create',
        moduleId: 'dutydeck.interaction-design-pilot.workspace',
        sessionId: 'session-1',
        projectId: 'workspace-1',
        runId: 'run-1',
        settingsRevision: 1,
        settings: {},
        input: {
          name: '登录流程',
          platform: 'mobile',
          html: '<main>首页</main>',
        },
        deadline: Date.now() + 5_000,
      },
    })
    expect(requestedCapabilities.at(-1)).toBe('artifact.write')
    expect(portResponse(transport.messages, 'tool-create')).toMatchObject({
      ok: true,
      value: { artifactRevision: 1 },
    })
  })
})

/** 找到指定请求的响应，避免依赖固定消息序号。 */
function portResponse(messages: PluginRuntimeMessage[], requestId: string): unknown {
  return messages.find(message => message.kind === 'response' && message.requestId === requestId)
}
