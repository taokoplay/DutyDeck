import { describe, expect, test } from 'bun:test'
import * as React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { AgentRunRecoveryNotice } from './AgentRunRecoveryNotice'

describe('未完成运行核验提示', () => {
  test('运行中隐藏旧恢复提示', () => {
    const html = renderToStaticMarkup(<AgentRunRecoveryNotice sessionId="active" running />)
    expect(html).toBe('')
  })

  test('首次显示检查中，不冒充已完成核验或精确恢复', () => {
    const html = renderToStaticMarkup(<AgentRunRecoveryNotice sessionId="idle" />)
    expect(html).toContain('正在检查未完成运行')
    expect(html).not.toContain('重新发送上一条消息')
  })
})
