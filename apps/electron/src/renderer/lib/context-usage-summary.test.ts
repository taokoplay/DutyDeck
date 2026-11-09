import { describe, expect, test } from 'bun:test'
import type { SDKMessage } from '@dutydeck/shared'
import {
  aggregateToolUsage,
  buildContextUsageSummary,
  formatCompactTokens,
  formatElapsedDuration,
  formatUsd,
  sumReportedCost,
} from './context-usage-summary'

/** 构造一条 assistant 工具调用消息。 */
function toolCall(id: string, name: string, input: unknown = {}): SDKMessage {
  return {
    type: 'assistant',
    uuid: `a-${id}`,
    message: { role: 'assistant', content: [{ type: 'tool_use', id, name, input }] },
  } as unknown as SDKMessage
}

/** 构造一条工具结果消息。 */
function toolResult(id: string, text: string): SDKMessage {
  return {
    type: 'user',
    uuid: `r-${id}`,
    message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: text }] },
  } as unknown as SDKMessage
}

/** 构造一条带费用的 result 消息。 */
function result(cost: number): SDKMessage {
  return { type: 'result', total_cost_usd: cost } as unknown as SDKMessage
}

/** 构造一次压缩边界。 */
function compactBoundary(): SDKMessage {
  return { type: 'system', subtype: 'compact_boundary' } as unknown as SDKMessage
}

describe('上下文用量汇总', () => {
  test('Given 有窗口与占用 When 汇总 Then 同时给出剩余与占用百分比', () => {
    const summary = buildContextUsageSummary({ usedTokens: 425_000, contextWindow: 1_050_000 })
    expect(summary.remainingTokens).toBe(625_000)
    expect(summary.usedPercent).toBe(40)
    expect(summary.remainingPercent).toBe(60)
  })

  test('Given 占用超过窗口 When 汇总 Then 剩余不为负且占用封顶 100%', () => {
    const summary = buildContextUsageSummary({ usedTokens: 1_200_000, contextWindow: 1_000_000 })
    expect(summary.remainingTokens).toBe(0)
    expect(summary.usedPercent).toBe(100)
  })

  test('Given 缺失窗口 When 汇总 Then 百分比保持未知而不是零', () => {
    const summary = buildContextUsageSummary({ usedTokens: 1_000 })
    expect(summary.usedPercent).toBeUndefined()
    expect(summary.remainingTokens).toBeUndefined()
  })

  test('Given 缓存读取与总输入 When 汇总 Then 命中率按 input 口径计算且不超过 100', () => {
    expect(buildContextUsageSummary({ usedTokens: 424_200, cacheReadTokens: 424_200 }).cacheHitRate).toBe(100)
    expect(buildContextUsageSummary({ usedTokens: 0, cacheReadTokens: 10 }).cacheHitRate).toBeUndefined()
    expect(buildContextUsageSummary({ usedTokens: 100, cacheReadTokens: 200 }).cacheHitRate).toBeUndefined()
  })

  test('Given 工具调用与结果 When 汇总 Then 按工具名聚合次数与近似 token', () => {
    const messages = [
      toolCall('1', 'Read', { path: '/a.ts' }),
      toolResult('1', 'x'.repeat(400)),
      toolCall('2', 'Read', { path: '/b.ts' }),
      toolResult('2', 'y'.repeat(400)),
      toolCall('3', 'Bash', { command: 'ls' }),
    ]
    const tools = aggregateToolUsage(messages)
    expect(tools.map((tool) => tool.name)).toEqual(['Read', 'Bash'])
    expect(tools[0]!.calls).toBe(2)
    expect(tools[0]!.tokens).toBeGreaterThan(200)
    expect(tools[1]!.calls).toBe(1)
  })

  test('Given 结果先于调用出现 When 聚合 Then 不会因缺失调用而丢 token', () => {
    const tools = aggregateToolUsage([toolResult('orphan', 'z'.repeat(400))])
    expect(tools).toHaveLength(1)
    expect(tools[0]!.name).toBe('unknown')
    expect(tools[0]!.tokens).toBeGreaterThan(0)
  })

  test('Given 多条 result 报告费用 When 汇总 Then 累加会话费用并统计压缩次数', () => {
    const messages = [result(1.25), result(2.5), compactBoundary(), compactBoundary()]
    expect(sumReportedCost(messages)).toBe(3.75)
    const summary = buildContextUsageSummary({ messages })
    expect(summary.sessionCostUsd).toBe(3.75)
    expect(summary.compactionCount).toBe(2)
  })

  test('Given 没有费用报告 When 汇总 Then 返回 undefined 而不是零', () => {
    expect(sumReportedCost([compactBoundary()])).toBeUndefined()
  })

  test('Given 会话创建时间 When 汇总 Then 计算墙钟持续时间', () => {
    const summary = buildContextUsageSummary({ sessionCreatedAt: 1_000, now: 62_000 })
    expect(summary.sessionElapsedMs).toBe(61_000)
  })
})

describe('用量格式化', () => {
  test('Given token 数 When 格式化 Then 使用紧凑单位', () => {
    expect(formatCompactTokens(470)).toBe('470')
    expect(formatCompactTokens(1_234)).toBe('1.2K')
    expect(formatCompactTokens(26_500)).toBe('27K')
    expect(formatCompactTokens(1_050_000)).toBe('1.05M')
  })

  test('Given 时长 When 格式化 Then 保留小时分钟秒', () => {
    expect(formatElapsedDuration(0)).toBe('0s')
    expect(formatElapsedDuration(61_000)).toBe('1m 1s')
    expect(formatElapsedDuration((22 * 3600 + 31 * 60 + 49) * 1000)).toBe('22h 31m 49s')
    expect(formatElapsedDuration(undefined)).toBe('暂不可用')
  })

  test('Given 费用 When 格式化 Then 保留两位小数并标注约值', () => {
    expect(formatUsd(9.59)).toBe('≈$9.59')
    expect(formatUsd(undefined)).toBeUndefined()
  })
})
