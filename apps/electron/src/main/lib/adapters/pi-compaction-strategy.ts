/**
 * 手动压缩的摘要预算策略。
 *
 * Pi 的 `compact()` 只发一次摘要请求：输入超过模型窗口时整次压缩失败，
 * 长会话因此只能反复重试或放弃。这里提供三件事，供 adapter 在调用 Pi 前使用：
 *
 * 1. 按 Pi 真正发送的序列化形态估算摘要输入，而不是把原始消息的 token 相加；
 * 2. 超预算时做一次有界降级（截断工具结果、丢弃 thinking）；
 * 3. 仍超预算时切成连续分块，逐块摘要并链式携带上一份摘要。
 *
 * 全部是纯函数，不读文件、不调模型，便于单测。
 */

import type { AgentMessage } from '@earendil-works/pi-agent-core'

/** 摘要提示模板自身占用的预留 token。 */
export const COMPACTION_SUMMARY_PROMPT_SAFETY_TOKENS = 2_048
/** 一次 checkpoint 最多发出的摘要请求数；超过说明范围已不适合压缩。 */
export const COMPACTION_SUMMARY_MAX_CHUNKS = 16
/** 分块预算留出的余量：计划基于估算，请求体还包含角色标签与分隔符。 */
export const COMPACTION_SUMMARY_CHUNK_MARGIN = 0.9
/** 降级时工具结果保留的字符数（Pi 序列化时默认保留 2000）。 */
export const COMPACTION_REDUCED_TOOL_RESULT_CHARS = 500
/** 摘要请求的最大重试次数（Pi 只对瞬时错误重试）。 */
export const COMPACTION_SUMMARY_MAX_RETRIES = 3
/** 摘要重试的初始退避时间，后续翻倍。 */
export const COMPACTION_SUMMARY_RETRY_BASE_MS = 2_000
/** 保留窗口的下限、上限与占安全预算的比例。 */
export const COMPACTION_KEEP_RECENT_MIN_TOKENS = 8_000
export const COMPACTION_KEEP_RECENT_MAX_TOKENS = 64_000
export const COMPACTION_KEEP_RECENT_RATIO = 0.2

/** Pi 估算 ASCII 文本时的字符/token 比；非 ASCII 按 1 字符 1 token 保守计数。 */
const ASCII_CHARS_PER_TOKEN = 3.5

/** 摘要输入所需的最小消息形状。 */
export interface CompactionSummaryInput {
  messagesToSummarize: AgentMessage[]
  turnPrefixMessages: AgentMessage[]
  isSplitTurn: boolean
  previousSummary?: string
}

/** 内容块的最小结构，避免依赖具体角色联合类型。 */
interface ContentBlock {
  type?: unknown
  text?: unknown
  [key: string]: unknown
}

/** 读取消息的内容块数组。 */
function contentBlocks(message: AgentMessage): ContentBlock[] {
  const content = (message as { content?: unknown }).content
  return Array.isArray(content) ? (content as ContentBlock[]) : []
}

/**
 * 估算一段已序列化文本的 token 数。
 *
 * 与 Pi 的口径一致：ASCII 按 3.5 字符/token，其它字符按 1 字符 1 token，
 * 避免中文摘要输入被当成英文而低估。
 */
export function estimateSerializedTokens(text: string): number {
  let asciiChars = 0
  let nonAsciiChars = 0
  for (let index = 0; index < text.length; index += 1) {
    if (text.charCodeAt(index) <= 0x7f) asciiChars += 1
    else nonAsciiChars += 1
  }
  return Math.ceil(asciiChars / ASCII_CHARS_PER_TOKEN + nonAsciiChars)
}

/**
 * 估算本次摘要请求的输入 token。
 *
 * split turn 会发两个请求（历史与回合前缀），取较大的那个；`previousSummary`
 * 会作为更新提示的一部分再次发送，必须计入。
 */
export function estimateSummaryPromptTokens(
  input: CompactionSummaryInput,
  serialize: (messages: AgentMessage[]) => string,
): number {
  const historyTokens = estimateSerializedTokens(
    serialize(input.messagesToSummarize) + (input.previousSummary ?? ''),
  )
  const turnPrefixTokens = input.isSplitTurn && input.turnPrefixMessages.length > 0
    ? estimateSerializedTokens(serialize(input.turnPrefixMessages))
    : 0
  return Math.max(historyTokens, turnPrefixTokens)
}

/**
 * 保留窗口：沿用 Pi 的 20% 安全预算比例，并钳在 8K–64K。
 *
 * 调大保留窗口会减少待摘要内容，从而缩短摘要请求；上限避免压缩后上下文
 * 仍然过大，下限保证小窗口模型也能留下可用上下文。
 */
export function deriveKeepRecentTokens(input: {
  contextWindow: number
  reserveTokens: number
}): number {
  const contextWindow = Math.max(1, Math.floor(input.contextWindow))
  const hardLimit = Math.max(1, contextWindow - Math.max(0, Math.floor(input.reserveTokens)))
  return Math.min(
    COMPACTION_KEEP_RECENT_MAX_TOKENS,
    Math.max(
      COMPACTION_KEEP_RECENT_MIN_TOKENS,
      Math.floor(hardLimit * COMPACTION_KEEP_RECENT_RATIO),
    ),
  )
}

/**
 * 一次摘要请求的输出预算：请求余量的 80% 与模型自身输出上限取较小值。
 */
export function compactionSummaryOutputBudget(input: {
  requestHeadroom: number
  modelMaxTokens?: number
}): number {
  return Math.min(
    Math.floor(Math.max(0, input.requestHeadroom) * 0.8),
    Math.max(1, Math.round(input.modelMaxTokens || 8_192)),
  )
}

/**
 * 摘要输入允许的最大 token：安全边界 + 请求余量 − 输出预算 − 提示预留。
 */
export function compactionSummaryInputLimit(input: {
  hardLimit: number
  requestHeadroom: number
  modelMaxTokens?: number
}): number {
  return Math.max(
    1,
    input.hardLimit
      + input.requestHeadroom
      - compactionSummaryOutputBudget(input)
      - COMPACTION_SUMMARY_PROMPT_SAFETY_TOKENS,
  )
}

/** 截断单个文本块，保留可读前缀。 */
function boundText(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text
  return `${text.slice(0, maxChars)}\n\n[... 工具输出已在摘要请求中截断]`
}

/**
 * 把一条消息的文本块限制在给定字符预算内。
 *
 * 只处理文本块；工具调用、工具结果身份与图片结构保持不变，截断后的消息
 * 仍是 provider 可接受的形态。
 */
export function truncateMessageText(message: AgentMessage, maxChars: number): AgentMessage {
  const blocks = contentBlocks(message)
  if (blocks.length === 0) return message
  let changed = false
  const content = blocks.map((block) => {
    if (block.type !== 'text' || typeof block.text !== 'string') return block
    const text = boundText(block.text, maxChars)
    if (text === block.text) return block
    changed = true
    return { ...block, text }
  })
  return changed ? ({ ...message, content } as AgentMessage) : message
}

/**
 * 一次有界降级：工具结果保留短前缀，assistant thinking 整块丢弃。
 *
 * user 文本、assistant 文本与工具调用参数全部保留，保证摘要仍覆盖边界内
 * 每条消息；没有可降级内容时返回 undefined，避免无意义的第二次请求。
 */
export function reduceSummaryInput<T extends CompactionSummaryInput>(input: T): T | undefined {
  let changed = false
  const reduce = (messages: AgentMessage[]): AgentMessage[] => messages.map((message) => {
    const reduced = reduceMessage(message)
    if (reduced !== message) changed = true
    return reduced
  })
  const messagesToSummarize = reduce(input.messagesToSummarize)
  const turnPrefixMessages = reduce(input.turnPrefixMessages)
  if (!changed) return undefined
  return { ...input, messagesToSummarize, turnPrefixMessages }
}

/** 单条消息的降级规则。 */
function reduceMessage(message: AgentMessage): AgentMessage {
  if (message.role === 'toolResult') {
    const blocks = contentBlocks(message)
    if (blocks.length === 0) return message
    let changed = false
    const content = blocks.map((block) => {
      if (block.type !== 'text' || typeof block.text !== 'string') return block
      const text = boundText(block.text, COMPACTION_REDUCED_TOOL_RESULT_CHARS)
      if (text === block.text) return block
      changed = true
      return { ...block, text }
    })
    return changed ? ({ ...message, content } as AgentMessage) : message
  }
  if (message.role === 'assistant') {
    const blocks = contentBlocks(message)
    if (!blocks.some((block) => block.type === 'thinking')) return message
    return {
      ...message,
      content: blocks.filter((block) => block.type !== 'thinking'),
    } as AgentMessage
  }
  return message
}

/**
 * 把摘要输入切成连续的块，每块都能放进一次请求预算。
 *
 * 每块由一次独立请求摘要，并把上一块的摘要作为 `previousSummary` 传入，
 * 最终收敛为一份覆盖全范围的摘要。范围为空或需要超过 16 次请求时返回
 * undefined，由调用方决定是否失败。
 */
export function planSummaryChunks(
  input: CompactionSummaryInput,
  options: {
    summaryInputLimit: number
    reserveTokens: number
    estimate: (message: AgentMessage) => number
  },
): AgentMessage[][] | undefined {
  const range = [
    ...input.messagesToSummarize,
    ...(input.isSplitTurn ? input.turnPrefixMessages : []),
  ]
  if (range.length === 0) return undefined
  const budget = Math.max(
    1,
    Math.floor(
      (options.summaryInputLimit - Math.max(0, options.reserveTokens))
        * COMPACTION_SUMMARY_CHUNK_MARGIN,
    ),
  )
  const chunks: AgentMessage[][] = []
  let current: AgentMessage[] = []
  let tokens = 0
  for (const message of range) {
    const cost = Math.max(1, Math.ceil(options.estimate(message)))
    if (current.length > 0 && tokens + cost > budget) {
      chunks.push(current)
      if (chunks.length >= COMPACTION_SUMMARY_MAX_CHUNKS) return undefined
      current = []
      tokens = 0
    }
    current.push(cost > budget ? truncateMessageText(message, Math.floor(budget * 4)) : message)
    tokens += Math.min(cost, budget)
  }
  if (current.length > 0) chunks.push(current)
  return chunks.length > 0 ? chunks : undefined
}
