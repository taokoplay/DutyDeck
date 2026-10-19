import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'

/** Pi session 分支条目的最小结构；不依赖 Pi SDK，便于恢复阶段同步校验。 */
export interface PiArtifactEntryLike {
  type: string
  id: string
  parentId: string | null
  message?: { role?: string }
}

/** Pi artifact 文件和当前活动 branch 的只读摘要。 */
export interface PiArtifactSnapshot {
  sessionId: string
  sessionFile: string
  branchEntryIds: string[]
  branchTipId?: string
  artifactSha256: string
}

/** SessionManager 对外提供的最小 branch 读取能力。 */
export interface PiBranchReader {
  getSessionId(): string
  getSessionFile(): string | undefined
  getBranch(): readonly PiArtifactEntryLike[]
}

/** 读取并解析真实 Pi artifact，计算活动 branch 和文件摘要。 */
export function readPiArtifactSnapshot(sessionFile: string): PiArtifactSnapshot {
  if (!existsSync(sessionFile)) throw new Error('PI_ARTIFACT_NOT_FOUND')
  const bytes = readFileSync(sessionFile)
  const lines = bytes.toString('utf8').split('\n').filter(Boolean)
  if (lines.length === 0) throw new Error('PI_ARTIFACT_EMPTY')

  const records = lines.map((line, index) => parseArtifactRecord(line, index + 1))
  const header = records[0]
  if (!header || header.type !== 'session' || typeof header.id !== 'string') throw new Error('PI_ARTIFACT_HEADER_INVALID')
  const entries = records.slice(1).map((record, index) => parseArtifactEntry(record, index + 2))
  const byId = new Map(entries.map((entry) => [entry.id, entry]))
  if (byId.size !== entries.length) throw new Error('PI_ARTIFACT_ENTRY_DUPLICATE')
  const branchEntryIds: string[] = []
  /** 恶意/损坏 parent 图不能让恢复检查陷入无限循环。 */
  const visited = new Set<string>()
  let current = entries.at(-1)
  while (current) {
    if (visited.has(current.id)) throw new Error('PI_ARTIFACT_BRANCH_CYCLE')
    visited.add(current.id)
    branchEntryIds.push(current.id)
    if (current.parentId === null) break
    const parent = byId.get(current.parentId)
    if (!parent) throw new Error('PI_ARTIFACT_PARENT_MISSING')
    current = parent
  }
  branchEntryIds.reverse()

  return {
    sessionId: header.id,
    sessionFile,
    branchEntryIds,
    ...(branchEntryIds.at(-1) ? { branchTipId: branchEntryIds.at(-1) } : {}),
    artifactSha256: createHash('sha256').update(bytes).digest('hex'),
  }
}

/** 校验 SessionManager 当前 branch 与展示层保存的 Pi binding 完全一致。 */
export function assertPiBranchBinding(input: {
  expectedSessionId?: string
  actualSessionId?: string
  branch: readonly PiArtifactEntryLike[]
  entryBindings: Readonly<Record<string, string>>
  expectedBranchTipId?: string
}): void {
  const branchIds = new Set(input.branch.map((entry) => entry.id))
  if (input.expectedSessionId && input.actualSessionId && input.expectedSessionId !== input.actualSessionId) {
    throw new Error('PI_ARTIFACT_SESSION_MISMATCH')
  }
  if (input.expectedSessionId && input.branch.length === 0) throw new Error('PI_ARTIFACT_BRANCH_EMPTY')
  for (const entryId of Object.values(input.entryBindings)) {
    if (!branchIds.has(entryId)) throw new Error(`PI_ARTIFACT_ENTRY_NOT_IN_BRANCH:${entryId}`)
  }
  if (input.expectedBranchTipId && input.branch.at(-1)?.id !== input.expectedBranchTipId) {
    throw new Error('PI_ARTIFACT_BRANCH_TIP_MISMATCH')
  }
}

function parseArtifactRecord(line: string, lineNumber: number): Record<string, unknown> {
  let parsed: unknown
  try { parsed = JSON.parse(line) } catch { throw new Error(`PI_ARTIFACT_JSON_INVALID:${lineNumber}`) }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error(`PI_ARTIFACT_RECORD_INVALID:${lineNumber}`)
  return parsed as Record<string, unknown>
}

function parseArtifactEntry(record: Record<string, unknown>, lineNumber: number): PiArtifactEntryLike {
  if (typeof record.type !== 'string' || typeof record.id !== 'string' || (record.parentId !== null && typeof record.parentId !== 'string')) {
    throw new Error(`PI_ARTIFACT_ENTRY_INVALID:${lineNumber}`)
  }
  const message = record.message
  return {
    type: record.type,
    id: record.id,
    parentId: record.parentId as string | null,
    ...(message && typeof message === 'object' && !Array.isArray(message) && typeof (message as { role?: unknown }).role === 'string'
      ? { message: { role: (message as { role: string }).role } }
      : {}),
  }
}
