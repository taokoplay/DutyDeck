import { describe, expect, test } from 'bun:test'
import type { AgentMessage } from '@earendil-works/pi-agent-core'
import {
  COMPACTION_KEEP_RECENT_MAX_TOKENS,
  COMPACTION_KEEP_RECENT_MIN_TOKENS,
  COMPACTION_REDUCED_TOOL_RESULT_CHARS,
  COMPACTION_SUMMARY_MAX_CHUNKS,
  compactionSummaryInputLimit,
  compactionSummaryOutputBudget,
  deriveKeepRecentTokens,
  estimateSerializedTokens,
  estimateSummaryPromptTokens,
  planSummaryChunks,
  reduceSummaryInput,
  truncateMessageText,
  type CompactionSummaryInput,
} from './pi-compaction-strategy'

/** 测试用最简单序列化：只关心长度与字符构成。 */
function serialize(messages: AgentMessage[]): string {
  return JSON.stringify(messages)
}

function userMessage(text: string): AgentMessage {
  return { role: 'user', content: [{ type: 'text', text }], timestamp: 1 } as unknown as AgentMessage
}

function toolResult(text: string, toolCallId = 'call-1'): AgentMessage {
  return {
    role: 'toolResult',
    toolCallId,
    toolName: 'Read',
    content: [{ type: 'text', text }],
    timestamp: 1,
  } as unknown as AgentMessage
}

function assistantMessage(content: unknown[]): AgentMessage {
  return { role: 'assistant', content, timestamp: 1 } as unknown as AgentMessage
}

function summaryInput(overrides: Partial<CompactionSummaryInput> = {}): CompactionSummaryInput {
  return {
    messagesToSummarize: [userMessage('hi')],
    turnPrefixMessages: [],
    isSplitTurn: false,
    ...overrides,
  }
}

describe('摘要输入估算', () => {
  test('Given 相同字符数的中英文 When 估算 Then 中文不被当英文低估', () => {
    const english = estimateSerializedTokens('a'.repeat(350))
    const chinese = estimateSerializedTokens('中'.repeat(350))
    expect(english).toBe(100)
    expect(chinese).toBe(350)
    expect(chinese).toBeGreaterThan(english)
  })

  test('Given 普通回合与 split 回合 When 估算 Then 取两个请求中较大的输入并计入上次摘要', () => {
    const plain = estimateSummaryPromptTokens(summaryInput(), serialize)
    const split = estimateSummaryPromptTokens(summaryInput({
      isSplitTurn: true,
      turnPrefixMessages: [userMessage('x'.repeat(2_000))],
    }), serialize)
    const withPrevious = estimateSummaryPromptTokens(summaryInput({ previousSummary: 'y'.repeat(4_000) }), serialize)
    expect(split).toBeGreaterThan(plain)
    expect(withPrevious).toBeGreaterThan(plain)
  })
})

describe('摘要输入降级', () => {
  test('Given 超长工具结果与 thinking When 降级 Then 只截断工具文本并移除思考', () => {
    const long = 'z'.repeat(COMPACTION_REDUCED_TOOL_RESULT_CHARS * 4)
    const input = summaryInput({
      messagesToSummarize: [toolResult(long), assistantMessage([
        { type: 'thinking', thinking: '内部推理' },
        { type: 'text', text: '结论' },
      ])],
    })
    const reduced = reduceSummaryInput(input)
    expect(reduced).toBeDefined()
    const [tool, assistant] = reduced!.messagesToSummarize
    const toolText = (tool as { content: Array<{ text: string }> }).content[0]!.text
    expect(toolText.length).toBeLessThan(long.length)
    expect(toolText.startsWith('z'.repeat(COMPACTION_REDUCED_TOOL_RESULT_CHARS))).toBe(true)
    const assistantBlocks = (assistant as { content: Array<{ type: string }> }).content
    expect(assistantBlocks.map((block) => block.type)).toEqual(['text'])
  })

  test('Given 短文本与普通文本消息 When 降级 Then 没有可降级内容时返回 undefined', () => {
    expect(reduceSummaryInput(summaryInput({
      messagesToSummarize: [userMessage('短文本'), assistantMessage([{ type: 'text', text: '回复' }])],
    }))).toBeUndefined()
  })

  test('Given 单条消息超预算 When 截断 Then 只改文本块并保留其它块与角色', () => {
    const message = assistantMessage([
      { type: 'toolCall', id: 'call-1', name: 'Read' },
      { type: 'text', text: 'a'.repeat(1_000) },
    ])
    const truncated = truncateMessageText(message, 100)
    const blocks = (truncated as { content: Array<{ type: string; text?: string }> }).content
    expect(blocks[0]).toMatchObject({ type: 'toolCall', id: 'call-1' })
    expect(blocks[1]!.text!.length).toBeLessThan(200)
  })
})

describe('摘要分块规划', () => {
  /** 每条消息按固定成本估算，便于构造边界。 */
  const estimate = (): number => 1_000

  test('Given 预算只能容纳两条 When 规划 Then 按连续区间切块且覆盖全部消息', () => {
    const messages = Array.from({ length: 5 }, (_, index) => userMessage(`m${index}`))
    const chunks = planSummaryChunks(summaryInput({ messagesToSummarize: messages }), {
      summaryInputLimit: 2_500,
      reserveTokens: 0,
      estimate,
    })
    expect(chunks?.length).toBe(3)
    expect(chunks?.flat().length).toBe(5)
  })

  test('Given 需要超过上限的块数 When 规划 Then 返回 undefined 交由调用方失败', () => {
    const messages = Array.from({ length: COMPACTION_SUMMARY_MAX_CHUNKS + 2 }, (_, index) => userMessage(`m${index}`))
    const chunks = planSummaryChunks(summaryInput({ messagesToSummarize: messages }), {
      summaryInputLimit: 1_000,
      reserveTokens: 0,
      estimate,
    })
    expect(chunks).toBeUndefined()
  })

  test('Given 单条消息超过单块预算 When 规划 Then 截断而不是丢弃', () => {
    const huge = userMessage('h'.repeat(10_000))
    const chunks = planSummaryChunks(summaryInput({ messagesToSummarize: [huge] }), {
      summaryInputLimit: 1_000,
      reserveTokens: 0,
      estimate,
    })
    expect(chunks?.length).toBe(1)
    expect(chunks![0]!.length).toBe(1)
  })

  test('Given 空范围 When 规划 Then 返回 undefined', () => {
    expect(planSummaryChunks(summaryInput({ messagesToSummarize: [] }), {
      summaryInputLimit: 1_000,
      reserveTokens: 0,
      estimate,
    })).toBeUndefined()
  })
})

describe('预算与保留窗口', () => {
  test('Given 模型窗口与请求余量 When 计算 Then 输入上限扣除输出预算与提示预留', () => {
    const output = compactionSummaryOutputBudget({ requestHeadroom: 40_000, modelMaxTokens: 8_192 })
    const limit = compactionSummaryInputLimit({ hardLimit: 160_000, requestHeadroom: 40_000, modelMaxTokens: 8_192 })
    expect(output).toBe(8_192)
    expect(limit).toBe(160_000 + 40_000 - 8_192 - 2_048)
  })

  test('Given 大窗口与小窗口 When 派生保留窗口 Then 钳在上下限内', () => {
    expect(deriveKeepRecentTokens({ contextWindow: 200_000, reserveTokens: 40_000 })).toBe(32_000)
    expect(deriveKeepRecentTokens({ contextWindow: 32_000, reserveTokens: 8_000 })).toBe(COMPACTION_KEEP_RECENT_MIN_TOKENS)
    expect(deriveKeepRecentTokens({ contextWindow: 1_000_000, reserveTokens: 100_000 })).toBe(COMPACTION_KEEP_RECENT_MAX_TOKENS)
  })
})
