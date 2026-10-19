import { describe, expect, test } from 'bun:test'
import { deriveAgentRunStatus } from './agent-run-status'

const base = { messagesLoaded: true, messagesRefreshing: false, streaming: true, backgroundWaiting: false, queuedCount: 0, waitingPermission: false, waitingAnswer: false, stopping: false, hasError: false, hasChannel: true, hasModel: true }

describe('Agent 会话状态派生', () => {
  test('空闲只表示可继续输入，不冒充任务完成', () => expect(deriveAgentRunStatus({ ...base, streaming: false })).toBe('idle'))
  test('等待授权优先于运行中', () => expect(deriveAgentRunStatus({ ...base, waitingPermission: true })).toBe('waiting_permission'))
  test('恢复优先于历史完成', () => expect(deriveAgentRunStatus({ ...base, streaming: false, messagesLoaded: false })).toBe('recovering'))
  test('停止和排队分别给出唯一动作状态', () => {
    expect(deriveAgentRunStatus({ ...base, stopping: true })).toBe('stopping')
    expect(deriveAgentRunStatus({ ...base, streaming: false, queuedCount: 1 })).toBe('queued')
  })
})
