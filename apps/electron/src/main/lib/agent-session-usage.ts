/**
 * 读取一个 Agent session 当前的上下文占用率。
 *
 * 用途：automation 调度器在 daily 模式下决定是否要切到新会话——
 * 同一自然日内即便上次运行成功，如果上下文已经接近窗口上限，
 * 继续往里塞会导致本次运行刚开始就触发 SDK 自动压缩，得不偿失。
 *
 * 数据来源：中央路径解析器确定的会话 JSONL 里最后一条带 usage 的消息。
 * 优先级：
 * 1. SDK result 消息（subtype=success/error_*）：usage + modelUsage[?].contextWindow
 * 2. SDK assistant 消息：message.usage + 按 message.model 推断 contextWindow
 * 3. 都拿不到：返回 undefined（占用率未知），调度器按"保守复用"处理
 *
 * 已用 token 口径与渲染层（useGlobalAgentListeners / SDKMessageRenderer）保持一致：
 * input_tokens + cache_read_input_tokens + cache_creation_input_tokens。
 * 开启 prompt caching 后上下文绝大部分落在 cache_read 上，只取 input_tokens 会把
 * 真实占用率严重低估、令 daily 安全阀几乎无法触发。
 *
 * 性能：至多倒读 512 KiB / 2048 条，版本快照命中时不读正文；
 * 超预算返回未知，不跨无法确认的范围使用旧值。
 */

import { calculateContextUsageRatio, inferContextWindow } from '@dutydeck/shared'
import type { SDKAssistantMessage, SDKResultMessage } from '@dutydeck/shared'
import { statSync } from 'node:fs'
import { scanJsonlRecords } from './agent-jsonl-reader'
import { readJsonlTail } from './agent-jsonl-tail-reader'
import { agentHistoryPerformance } from './agent-history-performance'
import { getAgentSessionMessagesPath } from './config-paths'

interface UsageTokens {
  input_tokens: number
  cache_read_input_tokens?: number
  cache_creation_input_tokens?: number
}

/**
 * 与渲染层一致的"已用上下文 token"口径：base input + 两类 cache token。
 */
function sumUsedTokens(usage: UsageTokens): number {
  return (
    usage.input_tokens +
    (usage.cache_read_input_tokens ?? 0) +
    (usage.cache_creation_input_tokens ?? 0)
  )
}

interface UsageSnapshot { stamp: string; ratio: number | undefined; resolved: boolean }
const usageSnapshots = new Map<string, UsageSnapshot>()
const usageBackfills = new Map<string, Promise<void>>()

/** 老会话的可信值可能位于大段工具日志之前；异步回填且最多并发两份。 */
function warmSessionUsage(filePath: string, stamp: string): void {
  if (usageBackfills.has(filePath) || usageBackfills.size >= 2) return
  const work = (async () => {
    let ratio: number | undefined
    try {
      for await (const record of scanJsonlRecords(filePath)) {
        if (record.text === undefined) { ratio = undefined; continue }
        try {
          const value = usageFromMessage(JSON.parse(record.text))
          if (value !== undefined) ratio = value ?? undefined
        } catch { /* 损坏行跳过。 */ }
      }
      if (fileStamp(filePath) === stamp) saveSnapshot(filePath, { stamp, ratio, resolved: true })
    } catch { /* 删除或替换不产生新缓存。 */ }
    finally { usageBackfills.delete(filePath) }
  })()
  usageBackfills.set(filePath, work)
}

function fileStamp(filePath: string): string {
  const stat = statSync(filePath, { bigint: true })
  if (!stat.isFile()) throw new Error('会话不是普通文件')
  return `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}`
}

/** undefined 表示继续查找，null 表示边界重置；不能将未知值当作零。 */
function usageFromMessage(parsed: unknown): number | null | undefined {
  if (!parsed || typeof parsed !== 'object') return undefined
  const msg = parsed as { type?: string; subtype?: string }
  if (msg.type === 'system' && msg.subtype === 'compact_boundary') return null
  if (msg.type === 'result') {
    const result = parsed as SDKResultMessage
    if (result.isSyntheticCompactionResult || result.usageStatus !== undefined || !result.usage) return undefined
    return calculateContextUsageRatio(sumUsedTokens(result.usage), pickResultContextWindow(result))
  }
  if (msg.type === 'assistant') {
    const asst = parsed as SDKAssistantMessage
    if (asst.message?.usageStatus === 'unknown' || asst.message?.usageStatus === 'partial' || !asst.message?.usage) return undefined
    return calculateContextUsageRatio(sumUsedTokens(asst.message.usage), inferContextWindow(asst._channelModelId ?? asst.message.model))
  }
  return undefined
}

function saveSnapshot(filePath: string, snapshot: UsageSnapshot): void {
  usageSnapshots.delete(filePath)
  usageSnapshots.set(filePath, snapshot)
  while (usageSnapshots.size > 128) usageSnapshots.delete(usageSnapshots.keys().next().value!)
}

/** 与实际文件版本绑定；同步调用者永远不会触发全文读取。 */
export function getSessionContextUsageRatio(sessionId: string): number | undefined {
  const filePath = getAgentSessionMessagesPath(sessionId)
  try {
    const stamp = fileStamp(filePath)
    const cached = usageSnapshots.get(filePath)
    if (cached?.stamp === stamp) {
      if (!cached.resolved) warmSessionUsage(filePath, stamp)
      return cached.ratio
    }
    const start = agentHistoryPerformance.enabled ? performance.now() : 0
    const tail = readJsonlTail(filePath)
    let ratio: number | undefined
    let parsedRecords = 0
    let resolved = tail.reachedStart
    for (const { text } of tail.lines) {
      try {
        const value = usageFromMessage(JSON.parse(text))
        parsedRecords++
        if (value !== undefined) { ratio = value ?? undefined; resolved = true; break }
      } catch { /* 不完整/损坏行与原合同一致，跳过。 */ }
    }
    if (fileStamp(filePath) !== stamp) return undefined
    saveSnapshot(filePath, { stamp, ratio, resolved })
    if (!resolved) warmSessionUsage(filePath, stamp)
    if (agentHistoryPerformance.enabled) {
      const durationMs = performance.now() - start
      agentHistoryPerformance.record({ operation: 'usage', durationMs, readMs: durationMs,
        projectionMs: 0, ioBytes: tail.bytesRead, parsedRecords, returnedBytes: 0 })
    }
    return ratio
  } catch {
    usageSnapshots.delete(filePath)
    return undefined
  }
}

/** append 前捕获已验证快照；不能在追加之后用旧文件大小猜测版本连续性。 */
export function captureSessionUsageSnapshot(filePath: string): UsageSnapshot | undefined {
  try {
    const snapshot = usageSnapshots.get(filePath)
    return snapshot?.resolved && snapshot.stamp === fileStamp(filePath) ? snapshot : undefined
  } catch { return undefined }
}

/** 只在正文追写成功后更新；压缩边界会立即清除旧值。 */
export function observeSessionUsageAppend(filePath: string, messages: readonly unknown[], previous?: UsageSnapshot): void {
  let ratio = previous?.ratio
  let authoritative = previous !== undefined
  for (const message of messages) {
    const value = usageFromMessage(message)
    if (value !== undefined) { ratio = value ?? undefined; authoritative = true }
  }
  if (!authoritative) { usageSnapshots.delete(filePath); return }
  try { saveSnapshot(filePath, { stamp: fileStamp(filePath), ratio, resolved: true }) } catch { usageSnapshots.delete(filePath) }
}

/**
 * 从 SDK result.modelUsage 多 entry 中选择代表性的 contextWindow。
 *
 * SDK 0.3.142+ Task 工具默认启用后，单次 result 可能包含多个模型（主对话 + 子 agent），
 * modelUsage 会有多个 entry。result.usage 是聚合值，其中大头通常属于主模型，
 * 所以用**最大** contextWindow 作为分母最接近"主模型视角的占用率"——这样：
 *   - 单 entry（常态）：行为与从前一致
 *   - 多 entry：避免被子 agent 的小窗口拉低、过早误触发 daily 切换阈值
 *
 * 每个 entry 优先用 SDK 实测的 contextWindow，缺失或非法时按本次 Agent provider 的运行窗口推断。
 */
function pickResultContextWindow(result: SDKResultMessage): number | undefined {
  if (!result.modelUsage) return undefined
  let best: number | undefined
  for (const [modelId, info] of Object.entries(result.modelUsage)) {
    const fallbackModelId = result._channelModelId ?? modelId
    /** SDK 返回的正数窗口是本次真实运行值，不能被静态 fallback 抬高。 */
    const reportedWindow = info?.contextWindow
    const win = typeof reportedWindow === 'number' && Number.isFinite(reportedWindow) && reportedWindow > 0
      ? reportedWindow
      : inferContextWindow(fallbackModelId, result._channelProvider)
    if (win === undefined) continue
    if (best === undefined || win > best) best = win
  }
  return best
}
