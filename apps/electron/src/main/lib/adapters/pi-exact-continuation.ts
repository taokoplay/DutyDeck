import { realpathSync } from 'node:fs'
import type { SessionManager } from '@earendil-works/pi-coding-agent'
import type { AgentMessage } from '@earendil-works/pi-agent-core'
import { readPiArtifactSnapshot } from '../pi-artifact-reconciliation'

/** 仅由可信恢复服务签发的不可替换 Pi 持久化快照。 */
export interface PiResumeContinuation {
  /** 预期 artifact 的真实路径。 */
  expectedSessionFile: string
  /** Pi session 身份，必须与普通 resumeSessionId 相同。 */
  sessionId: string
  /** 恢复批准时的活动叶节点。 */
  branchTipId: string
  /** 恢复批准时完整 artifact 字节的 SHA-256。 */
  artifactSha256: string
}

/** 校验已打开的真实 SessionManager；任何不一致均拒绝，不创建替代会话。 */
export function assertPiExactContinuation(manager: SessionManager, expected: PiResumeContinuation): void {
  /** 当前打开的持久化路径和磁盘快照。 */
  const file = manager.getSessionFile()
  if (!file || realpathSync(file) !== realpathSync(expected.expectedSessionFile)) throw new Error('PI_CONTINUATION_FILE_MISMATCH')
  const snapshot = readPiArtifactSnapshot(file)
  if (snapshot.sessionId !== expected.sessionId || manager.getSessionId() !== expected.sessionId) throw new Error('PI_CONTINUATION_SESSION_MISMATCH')
  if (snapshot.artifactSha256 !== expected.artifactSha256) throw new Error('PI_CONTINUATION_HASH_MISMATCH')
  if (snapshot.branchTipId !== expected.branchTipId || manager.getLeafId() !== expected.branchTipId) throw new Error('PI_CONTINUATION_BRANCH_MISMATCH')
  assertPiContinuationMessages(manager.buildSessionContext().messages)
}

/** 验证模型将消费的有效上下文；未决/重复/孤立工具结果都不能自动重放。 */
export function assertPiContinuationMessages(messages: readonly AgentMessage[]): void {
  /** 尚未闭合的工具调用 ID。 */
  const pending = new Map<string, string>()
  /** 所有已出现调用，防止同一 ID 被重复执行或结果错配。 */
  const seen = new Set<string>()
  for (const message of messages) {
    if (message.role === 'assistant') {
      if (pending.size > 0) throw new Error('PI_CONTINUATION_PENDING_TOOL')
      for (const block of message.content) {
        if (block.type !== 'toolCall') continue
        if (seen.has(block.id)) throw new Error('PI_CONTINUATION_DUPLICATE_TOOL')
        seen.add(block.id)
        pending.set(block.id, block.name)
      }
    } else if (message.role === 'toolResult') {
      if (pending.get(message.toolCallId) !== message.toolName) throw new Error('PI_CONTINUATION_ORPHAN_TOOL_RESULT')
      pending.delete(message.toolCallId)
    } else if (message.role === 'user' && pending.size > 0) {
      throw new Error('PI_CONTINUATION_PENDING_TOOL')
    }
  }
  if (pending.size > 0) throw new Error('PI_CONTINUATION_PENDING_TOOL')
  /** Pi 原生 continue 只允许尚未回答的 user 或已完成的 toolResult。 */
  const last = messages.at(-1)
  if (last?.role !== 'user' && last?.role !== 'toolResult') throw new Error('PI_CONTINUATION_UNSAFE_TAIL')
}
