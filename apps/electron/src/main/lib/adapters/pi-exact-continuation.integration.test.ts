import { afterAll, describe, expect, mock, test } from 'bun:test'
import { mkdtempSync, mkdirSync, rmSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SessionManager } from '@earendil-works/pi-coding-agent'
import { createAssistantMessageEventStream, type AssistantMessage } from '@earendil-works/pi-ai'
import { readPiArtifactSnapshot } from '../pi-artifact-reconciliation'
import { assertPiExactContinuation, type PiResumeContinuation } from './pi-exact-continuation'
import type { PiAgentQueryOptions } from './pi-agent-adapter'

/** Electron 边界仅用于 Bun 加载；Pi SessionManager、Agent 与 adapter 均为真实实现。 */
mock.module('electron', () => ({ app: { isPackaged: false, getPath: () => '/tmp', getName: () => 'Test' }, BrowserWindow: { getAllWindows: () => [] }, WebContentsView: class {}, MessageChannelMain: class {}, utilityProcess: {}, ipcMain: {}, shell: {}, dialog: {}, clipboard: {}, nativeImage: {}, screen: {}, net: {}, session: {}, safeStorage: { isEncryptionAvailable: () => false }, default: {} }))
const { PiAgentAdapter } = await import('./pi-agent-adapter')
/** 每个测试只读写独立临时根。 */
const root = mkdtempSync(join(tmpdir(), 'pi-exact-continuation-'))
afterAll(() => rmSync(root, { recursive: true, force: true }))

/** 构造完整 Pi assistant 消息，供持久化和离线 stream 共用。 */
function assistant(content: AssistantMessage['content'], stopReason: AssistantMessage['stopReason'] = 'stop'): AssistantMessage {
  return { role: 'assistant', content, stopReason, api: 'openai-completions', provider: 'openai', model: 'gpt-4o', timestamp: Date.now(), usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } }
}

/** 用真实 SDK 写入中断点并关闭后重开，返回可验证快照。 */
function fixture(name: string, pending = false): { input: PiAgentQueryOptions; expected: PiResumeContinuation; file: string } {
  const dir = join(root, name)
  mkdirSync(dir, { recursive: true })
  const manager = SessionManager.create(root, dir)
  manager.appendThinkingLevelChange('off')
  manager.appendMessage({ role: 'user', content: '只执行一次副作用', timestamp: Date.now() })
  manager.appendMessage(assistant([{ type: 'toolCall', id: 'completed-call', name: 'write', arguments: { path: 'must-not-replay', content: 'x' } }], 'toolUse'))
  if (!pending) manager.appendMessage({ role: 'toolResult', toolCallId: 'completed-call', toolName: 'write', content: [{ type: 'text', text: '副作用已完成' }], isError: false, timestamp: Date.now() })
  const file = manager.getSessionFile()!
  const snapshot = readPiArtifactSnapshot(file)
  const expected = { expectedSessionFile: file, sessionId: snapshot.sessionId, branchTipId: snapshot.branchTipId!, artifactSha256: snapshot.artifactSha256 }
  return { file, expected, input: { sessionId: name, prompt: '不得重新发送此文本', cwd: root, model: 'gpt-4o', provider: 'openai', baseUrl: 'http://offline.invalid/v1', apiKey: 'offline', permissionMode: 'bypassPermissions', systemPrompt: '离线验证', piAgentDir: join(dir, 'agent'), piSessionDir: dir, resumeSessionId: snapshot.sessionId, resumeContinuation: expected } as PiAgentQueryOptions }
}

describe('精确 Pi continuation：真实持久化与离线 provider', () => {
  test('Given 已完成工具后崩溃 When 重开并 continue Then 不新增 user、不重放工具且绑定新 assistant', async () => {
    const data = fixture('completed')
    let calls = 0
    let permissions = 0
    const bindings: Record<string, string> = {}
    const adapter = new PiAgentAdapter({ streamFunction: (_model, context) => {
      calls += 1
      expect(context.messages.filter(message => message.role === 'user')).toHaveLength(1)
      expect(context.messages.at(-1)?.role).toBe('toolResult')
      const stream = createAssistantMessageEventStream()
      const message = assistant([{ type: 'text', text: '续接完成' }])
      stream.push({ type: 'start', partial: message })
      stream.push({ type: 'done', reason: 'stop', message })
      return stream
    } })
    const emitted: unknown[] = []
    for await (const message of adapter.query({ ...data.input, canUseTool: async () => { permissions += 1; return { behavior: 'deny', message: '不得重放' } }, onPiEntryBindings: value => Object.assign(bindings, value) }, 'exact-test')) emitted.push(message)
    expect(calls).toBe(1)
    expect(permissions).toBe(0)
    const reopened = SessionManager.open(data.file)
    expect(reopened.buildSessionContext().messages.filter(message => message.role === 'user')).toHaveLength(1)
    expect(reopened.buildSessionContext().messages.at(-1)?.role).toBe('assistant')
    expect(Object.values(bindings)).toContain(reopened.getLeafId()!)
    expect(emitted.some(message => (message as { type?: string }).type === 'result')).toBe(true)
  })

  test('Given 快照错配或未完成副作用 When 校验 Then 在模型调用之前拒绝且 artifact 不改写', () => {
    const data = fixture('invalid')
    const original = readFileSync(data.file, 'utf8')
    const reopened = SessionManager.open(data.file)
    for (const patch of [{ artifactSha256: 'wrong' }, { branchTipId: 'wrong' }, { sessionId: 'wrong' }]) {
      expect(() => assertPiExactContinuation(reopened, { ...data.expected, ...patch })).toThrow('PI_CONTINUATION_')
    }
    expect(readFileSync(data.file, 'utf8')).toBe(original)
    const pending = fixture('pending', true)
    expect(() => assertPiExactContinuation(SessionManager.open(pending.file), pending.expected)).toThrow('PI_CONTINUATION_PENDING_TOOL')
  })
  test('Given 不可信 hash 或未完成工具 When 生产 adapter 接到续接 Then 零 provider 调用且不追加 prompt', async () => {
    /** 模型调用次数必须在所有拒绝路径保持零。 */
    let calls = 0
    const adapter = new PiAgentAdapter({ streamFunction: () => { calls += 1; throw new Error('不得请求模型') } })
    for (const pending of [false, true]) {
      const data = fixture(`adapter-reject-${pending}`, pending)
      const before = readFileSync(data.file, 'utf8')
      const expected = pending ? data.expected : { ...data.expected, artifactSha256: 'wrong' }
      const consume = async (): Promise<void> => {
        for await (const _message of adapter.query({ ...data.input, resumeContinuation: expected }, `reject-${pending}`)) { /* 消费生产生成器直到校验拒绝。 */ }
      }
      await expect(consume()).rejects.toThrow('PI_CONTINUATION_')
      expect(readFileSync(data.file, 'utf8')).toBe(before)
    }
    expect(calls).toBe(0)
  })

  test('Given 首次快照通过 When 异步初始化后artifact被外部修改 Then continue前再次拒绝且零provider调用', async () => {
    const data = fixture('changed-during-init')
    let calls = 0
    const adapter = new PiAgentAdapter({ streamFunction: () => { calls += 1; throw new Error('不得请求模型') } })
    const consume = async (): Promise<void> => {
      for await (const _message of adapter.query({ ...data.input, onModelResolved: () => {
        // 此回调在 buildModel/resourceLoader/createAgentSession 的 await 完成后触发。
        SessionManager.open(data.file).appendMessage({ role: 'user', content: '外部并发写入', timestamp: Date.now() })
      } }, 'changed-during-init')) { /* 必须在模型调用前拒绝。 */ }
    }
    await expect(consume()).rejects.toThrow('PI_CONTINUATION_HASH_MISMATCH')
    expect(calls).toBe(0)
  })

})
