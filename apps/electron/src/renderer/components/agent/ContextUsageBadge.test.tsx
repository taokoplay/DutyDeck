import { describe, expect, test } from 'bun:test'
import { Provider } from 'jotai'
import { createStore } from 'jotai/vanilla'
import { renderToStaticMarkup } from 'react-dom/server'
import {
  agentSDKMessagesCacheAtom,
  agentSessionsAtom,
  agentSessionStreamingStateAtomFamily,
  type AgentStreamState,
} from '@/atoms/agent-atoms'
import { ContextUsageBadge, ContextUsageStats } from './ContextUsageBadge'

/** 使用真实 Jotai 状态和组件渲染，验证未知统计不会伪装为零占用。 */
function renderUsage(state: AgentStreamState): string {
  const store = createStore()
  store.set(agentSessionStreamingStateAtomFamily('usage-badge'), state)
  return renderToStaticMarkup(
    <Provider store={store}>
      <ContextUsageBadge sessionId="usage-badge" isProcessing={false} onCompact={() => {}} />
    </Provider>,
  )
}

describe('上下文用量指示器', () => {
  test('Given 从未有统计 When 本次未知 Then 明确显示未知入口', () => {
    expect(renderUsage({ running: false, usageStatus: 'unknown' })).toContain('aria-label="用量未知"')
  })
  test('Given 已有统计 When 最新未知 Then 标注最近已知值', () => {
    expect(renderUsage({ running: false, usageStatus: 'unknown', inputTokens: 12_000, contextWindow: 200_000 }))
      .toContain('aria-label="用量未知，显示最近已知值"')
  })
  test('Given 明确报告零 When 渲染 Then 保留真实零', () => {
    expect(renderUsage({ running: false, usageStatus: 'known', inputTokens: 0, contextWindow: 200_000 }))
      .toContain('aria-label="上下文用量 0%"')
  })
})

describe('上下文用量面板', () => {
  /** 渲染统计区，验证面板把可推导指标与“暂不可用”分开。 */
  function renderStats(input: {
    messages?: unknown[]
    createdAt?: number
    usedTokens?: number
    outputTokens?: number
    cacheReadTokens?: number
    contextWindow?: number
    turnCostUsd?: number
  }): string {
    const store = createStore()
    store.set(agentSDKMessagesCacheAtom, new Map([['usage-panel', (input.messages ?? []) as never]]))
    if (input.createdAt !== undefined) {
      store.set(agentSessionsAtom, [{
        id: 'usage-panel',
        title: 'test',
        createdAt: input.createdAt,
        updatedAt: input.createdAt,
      } as never])
    }
    return renderToStaticMarkup(
      <Provider store={store}>
        <ContextUsageStats
          sessionId="usage-panel"
          usedTokens={input.usedTokens}
          outputTokens={input.outputTokens}
          cacheReadTokens={input.cacheReadTokens}
          contextWindow={input.contextWindow}
          turnCostUsd={input.turnCostUsd}
          isUsageUnavailable={false}
          usageLabel=""
        />
      </Provider>,
    )
  }

  test('Given 剩余空间与窗口 When 渲染面板 Then 同时显示剩余 token 与占用百分比', () => {
    const html = renderStats({ usedTokens: 425_000, contextWindow: 1_050_000 })
    expect(html).toContain('剩余 625K tokens')
    expect(html).toContain('60%')
    expect(html).toContain('425K / 1.05M tokens')
    expect(html).toContain('40%')
  })

  test('Given 缓存读取与输出 When 渲染面板 Then 显示命中率与模型用量', () => {
    const html = renderStats({
      usedTokens: 424_200,
      cacheReadTokens: 424_200,
      outputTokens: 315,
      contextWindow: 1_050_000,
    })
    expect(html).toContain('缓存命中率 100%')
    expect(html).toContain('输出 315')
  })

  test('Given 会话消息含工具与费用 When 渲染面板 Then 汇总工具上下文与会话累计', () => {
    const messages = [
      { type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id: '1', name: 'Read', input: { path: '/a' } }] } },
      { type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: '1', content: 'x'.repeat(400) }] } },
      { type: 'result', total_cost_usd: 9.59 },
    ]
    const html = renderStats({ messages, usedTokens: 1_000, contextWindow: 100_000, createdAt: Date.now() - 61_000 })
    expect(html).toContain('1 种工具 · 1 次调用')
    expect(html).toContain('≈$9.59')
    expect(html).toContain('会话总耗时')
  })

  test('Given 运行时未提供耗时分解 When 渲染面板 Then 明确显示暂不可用而不是零', () => {
    const html = renderStats({ usedTokens: 1_000, contextWindow: 100_000 })
    expect(html).toContain('网络请求耗时')
    expect(html).toContain('暂不可用')
  })
})
