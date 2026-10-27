import { expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager } from '@earendil-works/pi-coding-agent'
import { createAssistantMessageEventStream, fauxAssistantMessage, fauxProvider, fauxToolCall } from '@earendil-works/pi-ai'
import { Type } from 'typebox'
import type { NetworkRecoveryNotice } from '@dutydeck/shared'
import { createRecoveringPiStream } from './pi-network-recovery'

test('Given 已执行副作用后模型因换网停滞 When Pi原生重试 Then 不重发用户消息、不重放工具且只返回一次成功', async () => {
  /** 所有会话与资源均位于隔离临时目录。 */
  const root = mkdtempSync(join(tmpdir(), 'dutydeck-network-native-retry-'))
  const modelRuntime = await ModelRuntime.create({ authPath: join(root, 'auth.json'), modelsPath: null, refreshOnCreate: false })
  const provider = fauxProvider()
  modelRuntime.registerNativeProvider(provider.provider)
  const settingsManager = SettingsManager.inMemory({ cacheWarming: 'off', retry: { enabled: true, maxRetries: 1, baseDelayMs: 1 } })
  const resourceLoader = new DefaultResourceLoader({ cwd: root, agentDir: root, settingsManager, systemPromptOverride: () => '离线验证' })
  await resourceLoader.reload()
  /** 工具计数与网络代次都由测试控制，无外网访问。 */
  let writes = 0
  let calls = 0
  let snapshot: NetworkRecoveryNotice = { epoch: 1 }
  const listeners = new Set<(notice: NetworkRecoveryNotice) => void>()
  const { session } = await createAgentSession({ cwd: root, agentDir: root, modelRuntime, settingsManager, resourceLoader,
    sessionManager: SessionManager.create(root, root), model: provider.models[0], thinkingLevel: 'off', noTools: 'builtin',
    customTools: [{ name: 'write_once', label: '写入一次', description: '计数副作用', parameters: Type.Object({}),
      execute: async () => { writes++; return { content: [{ type: 'text', text: '已写入' }], details: {} } } }] })
  /** 观察真实native retry，而非在测试中重放prompt。 */
  let retries = 0
  session.subscribe((event) => { if (event.type === 'auto_retry_start') retries++ })
  session.agent.streamFunction = createRecoveringPiStream((_model, context) => {
    calls++
    expect(context.messages.filter(message => message.role === 'user')).toHaveLength(1)
    const stream = createAssistantMessageEventStream()
    if (calls === 1) {
      stream.push({ type: 'done', reason: 'toolUse', message: fauxAssistantMessage(fauxToolCall('write_once', {}, { id: 'once' }), { stopReason: 'toolUse' }) })
    } else if (calls === 2) {
      snapshot = { epoch: 2 }
      for (const listener of listeners) listener(snapshot)
      // 故意保持静默且无视abort，外层仍须及时结束。
    } else {
      expect(context.messages.filter(message => message.role === 'toolResult')).toHaveLength(1)
      stream.push({ type: 'done', reason: 'stop', message: fauxAssistantMessage('网络恢复后完成') })
    }
    return stream
  }, { stallTimeoutMs: 15, source: { getSnapshot: () => snapshot,
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener) } } })
  try {
    await session.prompt('执行一次工具并汇报')
    expect(calls).toBe(3)
    expect(writes).toBe(1)
    expect(retries).toBe(1)
    expect(listeners.size).toBe(0)
    expect(session.agent.state.messages.at(-1)).toMatchObject({ role: 'assistant', stopReason: 'stop' })
    expect(session.agent.state.messages.filter(message => message.role === 'user')).toHaveLength(1)
  } finally {
    session.dispose()
    rmSync(root, { recursive: true, force: true })
  }
}, 15_000)
