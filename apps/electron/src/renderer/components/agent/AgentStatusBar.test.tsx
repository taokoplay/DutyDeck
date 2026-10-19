import { describe, expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import type { AgentRunStatusInput } from '@/lib/agent-run-status'
import { AgentStatusBar } from './AgentStatusBar'

/** 已加载且可输入的空闲会话，不代表任务已经验收完成。 */
const idle: AgentRunStatusInput = {
  messagesLoaded: true, messagesRefreshing: false, streaming: false, backgroundWaiting: false,
  queuedCount: 0, waitingPermission: false, waitingAnswer: false, stopping: false,
  hasError: false, hasChannel: true, hasModel: true,
}

describe('输入区按需状态提示', () => {
  test('Given 空闲会话 When 渲染 Then 不显示完成文案且不占据额外一行', () => {
    expect(renderToStaticMarkup(<AgentStatusBar {...idle} />)).toBe('')
  })

  test('Given 已有消息或专属卡片反馈 When 渲染 Then 不重复显示状态条', () => {
    /** 这些状态分别由实时消息、队列、授权、问答、错误卡片或模型选择引导负责。 */
    const existingFeedback: Partial<AgentRunStatusInput>[] = [
      { streaming: true }, { queuedCount: 1 }, { waitingPermission: true },
      { waitingAnswer: true }, { hasError: true }, { hasChannel: false }, { hasModel: false },
    ]
    for (const state of existingFeedback) {
      expect(renderToStaticMarkup(<AgentStatusBar {...idle} {...state} />)).toBe('')
    }
  })

  test('Given 恢复、停止或后台等待 When 渲染 Then 保留必要的过渡反馈', () => {
    expect(renderToStaticMarkup(<AgentStatusBar {...idle} messagesLoaded={false} />)).toContain('正在恢复会话历史')
    expect(renderToStaticMarkup(<AgentStatusBar {...idle} stopping />)).toContain('正在停止')
    expect(renderToStaticMarkup(<AgentStatusBar {...idle} backgroundWaiting />)).toContain('后台任务等待中')
  })
})
