import type { SDKAssistantMessage, SDKMessage, SDKUserMessage } from '@dutydeck/shared'
import { extractMeta, isUserInputMessage } from '@dutydeck/session-core'

/** 历史定位只读取 Pi 分支的身份与消息字段，不依赖 SDK 运行时。 */
export interface PiHistoryEntry {
  type: string
  id: string
  timestamp: string
  message?: {
    role: string
    stopReason?: string
    errorMessage?: string
    toolCallId?: string
  }
}

/** 回退或分叉的只读输入；branch 必须来自当前会话的 SessionManager.getBranch()。 */
interface PiHistoryTargetInput {
  messages: readonly SDKMessage[]
  bindings: Readonly<Record<string, string>>
  branch: readonly PiHistoryEntry[]
  targetUuid: string
}

/** 无身份凭据时统一拒绝操作，提示用户改选已有的完整回复。 */
function unavailable(): never {
  throw new Error('该回复缺少可验证的 Pi 历史节点，无法安全回退或分叉；请选择此前正常完成的回复')
}

/**
 * 根据展示 UUID 返回当前 Pi 分支节点，不写入任何会话文件。
 * 新提示使用显式来源；旧提示仅在同一回合的已知节点、工具回执和唯一错误终态同时吻合时恢复。
 */
export function resolvePiHistoryTarget(input: PiHistoryTargetInput): string {
  /** 重复 UUID 无法证明展示截断点，不能只选第一条。 */
  const matches = input.messages.flatMap((message, index) => 'uuid' in message && message.uuid === input.targetUuid ? [index] : [])
  if (matches.length !== 1) return unavailable()
  /** 所选目标必须是主线 assistant，用户消息或子代理不能借用映射。 */
  const targetIndex = matches[0]!
  const targetMessage = input.messages[targetIndex]!
  if (targetMessage.type !== 'assistant' || targetMessage.parent_tool_use_id) return unavailable()
  /** SDKMessage 包含可扩展类型，确认 type 后显式收窄主线消息。 */
  const target = targetMessage as SDKAssistantMessage
  /** 只使用当前分支，避免 metadata 中另一棵树的残留映射被重新采用。 */
  const entries = new Map(input.branch.map((entry, index) => [entry.id, { entry, index }]))
  /** 直接映射优先；显式来源丢失时不能退回旧版猜测路径。 */
  const mappedId = input.bindings[input.targetUuid] ?? (target.error && target._piSourceUuid ? input.bindings[target._piSourceUuid] : undefined)
  if (mappedId) {
    /** 绑定对象必须仍是当前分支的 assistant 消息。 */
    const mapped = entries.get(mappedId)?.entry
    if (mapped?.type !== 'message' || mapped.message?.role !== 'assistant') return unavailable()
    return mappedId
  }
  if (!target.error || target._piSourceUuid) return unavailable()

  /** 从旧提示向前寻找同一用户回合内最近的已验证 assistant。 */
  let anchorIndex = targetIndex - 1
  for (; anchorIndex >= 0; anchorIndex--) {
    /** 下一用户请求与未知 system 边界都不能跨越。 */
    const message = input.messages[anchorIndex]!
    if (message.type === 'user' && !message.parent_tool_use_id && !isUserInputMessage(message as SDKUserMessage)) continue
    if (message.type === 'assistant' && !message.parent_tool_use_id && typeof message.uuid === 'string' && input.bindings[message.uuid]) break
    return unavailable()
  }
  if (anchorIndex < 0) return unavailable()
  /** 展示锚点到 Pi 树的映射已存在，不依赖文本内容推断位置。 */
  const anchor = input.messages[anchorIndex]!
  const anchorId = 'uuid' in anchor && typeof anchor.uuid === 'string' ? input.bindings[anchor.uuid] : undefined
  const anchorPosition = anchorId ? entries.get(anchorId) : undefined
  if (!anchorPosition || anchorPosition.entry.message?.role !== 'assistant') return unavailable()

  /** 当前原始回合以接下来的用户输入或系统上下文替换为边界。 */
  let endIndex = anchorPosition.index + 1
  while (endIndex < input.branch.length) {
    /** 仅 native retry 的 context_edit 可以出现在恢复区间内。 */
    const entry = input.branch[endIndex]!
    if (entry.type === 'message' && (entry.message?.role === 'user' || entry.message?.role === 'system')) break
    if (entry.type !== 'message' && entry.type !== 'context_edit') return unavailable()
    endIndex++
  }
  /** 时间仅辅助确认提示未跨回合，不能独立用于寻找节点。 */
  const noticeTime = extractMeta(target).createdAt
  const boundaryTime = input.branch[endIndex]?.timestamp
  if (noticeTime === undefined || !Number.isFinite(noticeTime)
    || (boundaryTime !== undefined && (!Number.isFinite(Date.parse(boundaryTime)) || noticeTime >= Date.parse(boundaryTime)))) return unavailable()

  /** 展示中的工具回执必须完整按序对应 Pi 回执，确保回退不丢已执行工具结果。 */
  const displayedToolIds: string[] = []
  for (const message of input.messages.slice(anchorIndex + 1, targetIndex)) {
    if (message.type !== 'user' || message.parent_tool_use_id) return unavailable()
    /** 仅已完成的工具回执可出现在锚点与错误提示之间。 */
    const content = (message as SDKUserMessage).message?.content
    if (!Array.isArray(content) || !content.length) return unavailable()
    for (const block of content) {
      if (block.type !== 'tool_result' || !('tool_use_id' in block) || typeof block.tool_use_id !== 'string') return unavailable()
      displayedToolIds.push(block.tool_use_id)
    }
  }
  /** 映射存在但未在展示转录保留的 UUID，正是旧版包装错误时丢失的原始身份。 */
  const displayedUuids = new Set(input.messages.flatMap((message) => 'uuid' in message && message.uuid ? [message.uuid] : []))
  const orphanEntryIds = new Set(Object.entries(input.bindings).filter(([uuid]) => !displayedUuids.has(uuid)).map(([, id]) => id))
  /** 同一分支区间内只允许重试错误与工具回执，不跳过成功输出。 */
  const interval = input.branch.slice(anchorPosition.index + 1, endIndex)
  const rawToolIds: string[] = []
  const candidates: PiHistoryEntry[] = []
  for (const entry of interval) {
    if (entry.type === 'context_edit') continue
    if (entry.message?.role === 'toolResult' && entry.message.toolCallId) rawToolIds.push(entry.message.toolCallId)
    else if (entry.message?.role === 'assistant' && entry.message.stopReason === 'error') {
      if (orphanEntryIds.has(entry.id)) candidates.push(entry)
    } else return unavailable()
  }
  if (displayedToolIds.length !== rawToolIds.length || displayedToolIds.some((id, index) => id !== rawToolIds[index])) return unavailable()
  /** 旧版部分正文已用原 UUID 持久化时，锚点本身就是候选错误终态。 */
  if (anchorPosition.entry.message?.stopReason === 'error' && interval.length === 0) candidates.push(anchorPosition.entry)
  if (candidates.length !== 1) return unavailable()
  /** 恢复点必须是回合最后的原始消息，不能截在下一次重试或工具执行之前。 */
  const candidate = candidates[0]!
  const lastMessage = interval.findLast((entry) => entry.type === 'message') ?? anchorPosition.entry
  const candidateTime = Date.parse(candidate.timestamp)
  if (lastMessage.id !== candidate.id || !Number.isFinite(candidateTime) || candidateTime > noticeTime
    || candidate.message?.errorMessage?.trim() !== target.error.message.trim()) return unavailable()
  return candidate.id
}
