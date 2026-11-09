/**
 * 上下文用量面板的汇总计算。
 *
 * 面板要回答的不只是“占了多少”，还包括：还剩多少、本轮与本次会话花了多少、
 * 工具上下文占了多少。这里把可推导的数字集中成纯函数，UI 只负责排版；
 * 运行时没有提供的指标（网络请求耗时、纯工具耗时）保持 undefined，
 * 由 UI 显示“暂不可用”，不虚构零值。
 */

import type { SDKMessage } from '@dutydeck/shared'

/** 汇总输入：来自流状态、消息历史与会话元数据。 */
export interface ContextUsageSummaryInput {
  /** 当前上下文占用（Pi 口径已含缓存读写）。 */
  usedTokens?: number
  outputTokens?: number
  cacheReadTokens?: number
  cacheCreationTokens?: number
  contextWindow?: number
  /** 本轮模型费用（美元）。 */
  turnCostUsd?: number
  /** 实时估算的思考 token，非计费值。 */
  thinkingEstimatedTokens?: number
  messages?: readonly SDKMessage[]
  sessionCreatedAt?: number
  /** 观察时刻；用于计算会话已持续时长。 */
  now?: number
}

/** 单个工具的上下文占用。 */
export interface ContextToolUsage {
  name: string
  calls: number
  /** 参数与结果文本的近似 token，按 4 字符 1 token 估算。 */
  tokens: number
}

/** 面板展示所需的全部派生值。 */
export interface ContextUsageSummary {
  usedTokens?: number
  remainingTokens?: number
  usedPercent?: number
  remainingPercent?: number
  /** 本轮合计：当前请求携带的上下文与输出。 */
  turnTotal?: number
  /** 缓存读取占本次提示 token 的比例。 */
  cacheHitRate?: number
  /** 会话内所有 result 消息报告的费用合计。 */
  sessionCostUsd?: number
  /** 会话从创建到现在的墙钟时长。 */
  sessionElapsedMs?: number
  /** 最近一次 assistant 报告的生成速度（tokens/s）。 */
  generationTokensPerSecond?: number
  tools: ContextToolUsage[]
  toolCallCount: number
  toolTotalTokens: number
  /** 已发生的压缩次数。 */
  compactionCount: number
  reasoningTokens?: number
}

/** 仅接受有限非负数，缺失或异常值一律视为未知。 */
function amount(value: number | undefined): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined
}

/** 读取消息内容块数组。 */
function blocks(message: SDKMessage): Array<Record<string, unknown>> {
  const content = (message as { message?: { content?: unknown } }).message?.content
  return Array.isArray(content) ? (content as Array<Record<string, unknown>>) : []
}

/** 粗略 token 估算：ASCII 4 字符 1 token，非 ASCII 1 字符 1 token。 */
export function estimateTextTokens(text: string): number {
  if (!text) return 0
  let ascii = 0
  let nonAscii = 0
  for (let index = 0; index < text.length; index += 1) {
    if (text.charCodeAt(index) <= 0x7f) ascii += 1
    else nonAscii += 1
  }
  return Math.ceil(ascii / 4 + nonAscii)
}

/** 把一个内容块折算成 token 估算值。 */
function blockTokens(block: Record<string, unknown>): number {
  const type = block.type
  if (type === 'text' && typeof block.text === 'string') return estimateTextTokens(block.text)
  if (type === 'tool_result') {
    const content = block.content
    if (typeof content === 'string') return estimateTextTokens(content)
    if (Array.isArray(content)) {
      return content.reduce((total, item) => (
        item && typeof item === 'object' && (item as { type?: unknown }).type === 'text'
          ? total + estimateTextTokens(String((item as { text?: unknown }).text ?? ''))
          : total
      ), 0)
    }
    return 0
  }
  if (type === 'tool_use') {
    // 参数不进入模型上下文，但参与本次请求；按序列化长度保守估算。
    try {
      return estimateTextTokens(JSON.stringify(block.input ?? {}))
    } catch {
      return 0
    }
  }
  return 0
}

/** 汇总工具调用：按工具名累计次数与参数/结果 token。 */
export function aggregateToolUsage(messages: readonly SDKMessage[]): ContextToolUsage[] {
  const calls = new Map<string, { name: string; calls: number; tokens: number }>()
  /** tool_use_id → 工具名，用于把结果 token 归到正确的工具。 */
  const callNames = new Map<string, string>()
  for (const message of messages) {
    for (const block of blocks(message)) {
      if (block.type === 'tool_use' && typeof block.id === 'string') {
        const name = typeof block.name === 'string' && block.name.trim() ? block.name.trim() : 'unknown'
        callNames.set(block.id, name)
        const entry = calls.get(name) ?? { name, calls: 0, tokens: 0 }
        entry.calls += 1
        entry.tokens += blockTokens(block)
        calls.set(name, entry)
        continue
      }
      if (block.type === 'tool_result' && typeof block.tool_use_id === 'string') {
        const name = callNames.get(block.tool_use_id) ?? 'unknown'
        const entry = calls.get(name) ?? { name, calls: 0, tokens: 0 }
        entry.tokens += blockTokens(block)
        calls.set(name, entry)
      }
    }
  }
  return [...calls.values()].sort((left, right) => right.tokens - left.tokens || left.name.localeCompare(right.name))
}

/** 会话累计费用：只累加 result 消息报告的金额。 */
export function sumReportedCost(messages: readonly SDKMessage[]): number | undefined {
  let total = 0
  let reported = false
  for (const message of messages) {
    const value = (message as { total_cost_usd?: unknown }).total_cost_usd
    if (typeof value === 'number' && Number.isFinite(value) && value >= 0) {
      total += value
      reported = true
    }
  }
  return reported ? total : undefined
}

/** 统计压缩边界数量。 */
export function countCompactions(messages: readonly SDKMessage[]): number {
  let count = 0
  for (const message of messages) {
    const record = message as { type?: string; subtype?: string }
    if (record.type === 'system' && record.subtype === 'compact_boundary') count += 1
  }
  return count
}

/**
 * 生成面板汇总。
 *
 * 所有未知项保持 undefined；UI 负责把它们显示为“—/暂不可用”，
 * 不把“没有报告”伪装成 0。
 */
export function buildContextUsageSummary(input: ContextUsageSummaryInput): ContextUsageSummary {
  const usedTokens = amount(input.usedTokens)
  const contextWindow = amount(input.contextWindow)
  const cacheReadTokens = amount(input.cacheReadTokens)

  const hasWindow = contextWindow !== undefined && contextWindow > 0
  const remainingTokens = usedTokens !== undefined && hasWindow
    ? Math.max(0, contextWindow - usedTokens)
    : undefined
  const usedPercent = usedTokens !== undefined && hasWindow
    ? Math.min(100, Math.round((usedTokens / contextWindow) * 100))
    : undefined
  const remainingPercent = usedPercent === undefined ? undefined : Math.max(0, 100 - usedPercent)

  // Pi 的 input 已包含缓存读写，因此“本轮合计”直接使用当前占用。
  const turnTotal = usedTokens
  const cacheHitRate = usedTokens !== undefined && cacheReadTokens !== undefined && usedTokens > 0 && cacheReadTokens <= usedTokens
    ? Math.round((cacheReadTokens / usedTokens) * 100)
    : undefined

  const messages = input.messages ?? []
  const tools = aggregateToolUsage(messages)
  const toolCallCount = tools.reduce((total, tool) => total + tool.calls, 0)
  const toolTotalTokens = tools.reduce((total, tool) => total + tool.tokens, 0)
  const sessionCostUsd = sumReportedCost(messages)
  const sessionElapsedMs = input.sessionCreatedAt !== undefined && input.now !== undefined
    ? Math.max(0, input.now - input.sessionCreatedAt)
    : undefined

  return {
    ...(usedTokens !== undefined ? { usedTokens } : {}),
    ...(remainingTokens !== undefined ? { remainingTokens } : {}),
    ...(usedPercent !== undefined ? { usedPercent } : {}),
    ...(remainingPercent !== undefined ? { remainingPercent } : {}),
    ...(turnTotal !== undefined ? { turnTotal } : {}),
    ...(cacheHitRate !== undefined ? { cacheHitRate } : {}),
    ...(sessionCostUsd !== undefined ? { sessionCostUsd } : {}),
    ...(sessionElapsedMs !== undefined ? { sessionElapsedMs } : {}),
    ...(amount(input.thinkingEstimatedTokens) !== undefined
      ? { reasoningTokens: amount(input.thinkingEstimatedTokens) }
      : {}),
    tools,
    toolCallCount,
    toolTotalTokens,
    compactionCount: countCompactions(messages),
  }
}

/** 紧凑 token 数：1234 → 1.2K，1_050_000 → 1.05M。 */
export function formatCompactTokens(tokens: number): string {
  if (!Number.isFinite(tokens)) return '—'
  if (tokens >= 1_000_000) {
    const value = tokens / 1_000_000
    return `${value >= 10 ? Math.round(value) : Number(value.toFixed(2))}M`
  }
  if (tokens >= 1_000) {
    const value = tokens / 1_000
    return `${value >= 10 ? Math.round(value) : Number(value.toFixed(1))}K`
  }
  return String(Math.round(tokens))
}

/** 时长：22h 31m 49s；不足一分钟只显示秒。 */
export function formatElapsedDuration(durationMs: number | undefined): string {
  if (durationMs === undefined || !Number.isFinite(durationMs) || durationMs < 0) return '暂不可用'
  const totalSeconds = Math.floor(durationMs / 1000)
  const hours = Math.floor(totalSeconds / 3600)
  const minutes = Math.floor((totalSeconds % 3600) / 60)
  const seconds = totalSeconds % 60
  if (hours > 0) return `${hours}h ${minutes}m ${seconds}s`
  if (minutes > 0) return `${minutes}m ${seconds}s`
  return `${seconds}s`
}

/** 费用：≈$9.59，未报告时返回 undefined 由 UI 显示占位。 */
export function formatUsd(value: number | undefined): string | undefined {
  if (value === undefined || !Number.isFinite(value)) return undefined
  return `≈$${value.toFixed(2)}`
}
