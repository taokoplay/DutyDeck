import { afterAll, beforeAll, describe, expect, mock, test } from 'bun:test'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import * as os from 'node:os'
import { join } from 'node:path'
import type { AgentSessionMeta, SDKMessage } from '@dutydeck/shared'

/** 全链路测试使用独立数据根，不修改 HOME 或读取用户真实会话。 */
const testHome = mkdtempSync(join(os.tmpdir(), 'dutydeck-pi-rewind-'))
mock.module('node:os', () => ({ ...os, homedir: () => testHome }))
mock.module('electron', () => ({
  default: {}, app: { isPackaged: true, getPath: () => join(testHome, 'app') },
  BrowserWindow: class {}, WebContentsView: class {}, utilityProcess: {}, MessageChannelMain: class {},
  ipcMain: {}, session: {}, net: {}, webContents: {}, clipboard: {}, dialog: {},
  nativeImage: { createFromPath: () => ({}) }, nativeTheme: {}, powerMonitor: {}, powerSaveBlocker: {}, screen: {}, shell: {},
  safeStorage: { isEncryptionAvailable: () => false, encryptString: (value: string) => Buffer.from(value), decryptString: (value: Buffer) => value.toString('utf8') },
}))

/** 动态加载确保真实 manager 与 Pi SDK 均使用已隔离的配置路径。 */
let manager: typeof import('./agent-session-manager')
let sdk: typeof import('@earendil-works/pi-coding-agent')
let root: string
beforeAll(async () => {
  manager = await import('./agent-session-manager')
  sdk = await import('@earendil-works/pi-coding-agent')
  root = (await import('./config-paths')).getConfigDir()
})
afterAll(() => rmSync(testHome, { recursive: true, force: true }))

/** 创建真实 Pi JSONL 与展示 JSONL，返回测试会话及原文件字节。 */
function createFixture(id: string): { meta: AgentSessionMeta; piBytes: string; displayBytes: string; displayPath: string } {
  /** 按分支顺序定义旧错误、后续成功回复和带显式来源的新错误。 */
  const rawMessages = [
    { role: 'user', content: '开始' },
    { role: 'assistant', content: [{ type: 'toolCall', id: 'call-1', name: 'read', arguments: {} }], stopReason: 'toolUse' },
    { role: 'toolResult', toolCallId: 'call-1', toolName: 'read', content: [{ type: 'text', text: '完成' }], isError: false },
    { role: 'assistant', content: [], stopReason: 'error', errorMessage: 'Request timed out.' },
    { role: 'user', content: '下一轮' },
    { role: 'assistant', content: [{ type: 'text', text: '后续成功' }], stopReason: 'stop' },
    { role: 'user', content: '再次请求' },
    { role: 'assistant', content: [], stopReason: 'error', errorMessage: '413 Request Entity Too Large' },
  ]
  /** 真实 SDK 会读取并重建父子链，避免用 fake branch 掩盖 artifact 不一致。 */
  const piBytes = [
    { type: 'session', version: 3, id: `pi-${id}`, timestamp: new Date(0).toISOString(), cwd: testHome },
    ...rawMessages.map((message, index) => ({
      type: 'message', id: `entry-${index}`, parentId: index ? `entry-${index - 1}` : null,
      timestamp: new Date((index + 1) * 1000).toISOString(), message: { ...message, timestamp: (index + 1) * 1000 },
    })),
  ].map((record) => JSON.stringify(record)).join('\n') + '\n'
  const piSessionFile = join(root, 'sdk-config', 'sessions', `${id}.jsonl`)
  mkdirSync(join(root, 'sdk-config', 'sessions'), { recursive: true })
  writeFileSync(piSessionFile, piBytes)
  /** 展示错误保留原有独立 UUID，旧错误故意不带显式来源。 */
  const messages: SDKMessage[] = [
    { type: 'user', uuid: 'input', message: { content: [{ type: 'text', text: '开始' }] } },
    { type: 'assistant', uuid: 'anchor', message: { content: [{ type: 'text', text: '执行工具' }] } },
    { type: 'user', uuid: 'result', message: { content: [{ type: 'tool_result', tool_use_id: 'call-1', content: '完成' }] } },
    { type: 'assistant', uuid: 'old-notice', message: { content: [] }, error: { message: 'Request timed out.' }, _createdAt: 4500 },
    { type: 'user', uuid: 'next-input', message: { content: [{ type: 'text', text: '下一轮' }] } },
    { type: 'assistant', uuid: 'later', message: { content: [{ type: 'text', text: '后续成功' }] } },
    { type: 'user', uuid: 'last-input', message: { content: [{ type: 'text', text: '再次请求' }] } },
    { type: 'assistant', uuid: 'new-notice', _piSourceUuid: 'original-new-error', message: { content: [] }, error: { message: '请求过大' } },
  ]
  const displayBytes = messages.map((message) => JSON.stringify(message)).join('\n') + '\n'
  const displayPath = join(root, 'agent-sessions', `${id}.jsonl`)
  mkdirSync(join(root, 'agent-sessions'), { recursive: true })
  writeFileSync(displayPath, displayBytes)
  const meta: AgentSessionMeta = { id, title: '失败回合测试', createdAt: 1, updatedAt: 1, sdkSessionId: `pi-${id}`, piSessionFile,
    piEntryBindings: { anchor: 'entry-1', 'original-old-error': 'entry-3', later: 'entry-5', 'original-new-error': 'entry-7' } }
  writeFileSync(join(root, 'agent-sessions.json'), JSON.stringify({ version: 2, sessions: [meta] }))
  return { meta, piBytes, displayBytes, displayPath }
}

describe('Pi 真实 artifact 回退与分叉', () => {
  test('Given 旧错误后有成功回复 When 先回退较晚回复再回退旧错误 Then 不丢失更早错误的恢复身份', async () => {
    /** 第一轮回退应保留历史兼容仍需要的原始错误映射。 */
    const fixture = createFixture('repeat-rewind')
    expect(await manager.rewindPiAgentSession(fixture.meta.id, 'later')).toBe(6)
    expect(manager.getAgentSessionMeta(fixture.meta.id)?.piEntryBindings?.['original-old-error']).toBe('entry-3')
    expect(await manager.rewindPiAgentSession(fixture.meta.id, 'old-notice')).toBe(4)
    /** 新 artifact 的叶节点及展示尾部必须对应同一个失败回合。 */
    const updated = manager.getAgentSessionMeta(fixture.meta.id)!
    const branch = sdk.SessionManager.open(updated.piSessionFile!).getBranch()
    expect(branch.at(-1)?.id).toBe('entry-3')
    expect(branch.some((entry) => entry.id === 'entry-5')).toBe(false)
    expect(manager.getAgentSessionSDKMessages(fixture.meta.id).at(-1)).toMatchObject({ uuid: 'old-notice' })
    expect(readFileSync(fixture.meta.piSessionFile!, 'utf8')).toBe(fixture.piBytes)
  })

  test('Given 带来源的新错误 When 分叉后回退旧错误 Then 源会话原字节保持不变且新分支可继续回退', async () => {
    /** 分叉使用真实 SDK 导出，包含旧兼容和新身份两种错误提示。 */
    const fixture = createFixture('fork-errors')
    const forked = await manager.forkAgentSession({ sessionId: fixture.meta.id, upToMessageUuid: 'new-notice' })
    expect(forked.piEntryBindings?.['new-notice']).toBe('entry-7')
    expect(sdk.SessionManager.open(forked.piSessionFile!).getBranch().at(-1)?.id).toBe('entry-7')
    expect(await manager.rewindPiAgentSession(forked.id, 'old-notice')).toBe(4)
    expect(readFileSync(fixture.meta.piSessionFile!, 'utf8')).toBe(fixture.piBytes)
    expect(readFileSync(fixture.displayPath, 'utf8')).toBe(fixture.displayBytes)
  })

  test('Given 工具回执无法证明一致 When 回退 Then 原 Pi 与展示文件均不改写', async () => {
    /** 模拟展示回执被替换，必须在创建/切换分支前拒绝。 */
    const fixture = createFixture('reject-mismatch')
    const modified = fixture.displayBytes.replace('call-1', 'other-call')
    writeFileSync(fixture.displayPath, modified)
    await expect(manager.rewindPiAgentSession(fixture.meta.id, 'old-notice')).rejects.toThrow('无法安全')
    expect(manager.getAgentSessionMeta(fixture.meta.id)?.piSessionFile).toBe(fixture.meta.piSessionFile)
    expect(readFileSync(fixture.meta.piSessionFile!, 'utf8')).toBe(fixture.piBytes)
    expect(readFileSync(fixture.displayPath, 'utf8')).toBe(modified)
  })
})
