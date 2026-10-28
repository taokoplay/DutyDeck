import { createHash } from 'node:crypto'
import type { VaultDirectoryPage, VaultDirectoryPageRequest, VaultTreeEntry } from '@dutydeck/shared'

export type { VaultDirectoryPage, VaultDirectoryPageRequest } from '@dutydeck/shared'

/** Vault 目录分页的最大单页条目，避免一次 IPC 回传过大的树。 */
export const VAULT_DIRECTORY_PAGE_SIZE = 256

/** 目录 cursor 内部载荷；只包含不敏感的快照摘要和偏移量。 */
export interface VaultDirectoryCursor {
  snapshot: string
  offset: number
}

/** 用条目元数据生成稳定快照，目录内容变化后旧 cursor 会失效。 */
export function createVaultDirectorySnapshot(entries: readonly VaultTreeEntry[]): string {
  const normalized = [...entries]
    .sort((left, right) => left.relativePath.localeCompare(right.relativePath))
    .map(entry => entry.kind === 'file'
      ? [entry.kind, entry.relativePath, entry.name, entry.size, entry.modifiedAt]
      : [entry.kind, entry.relativePath, entry.name])
  return createHash('sha256').update(JSON.stringify(normalized), 'utf8').digest('hex').slice(0, 32)
}

/** 编码不含路径和正文的目录 cursor，供下一页继续读取。 */
export function encodeVaultDirectoryCursor(cursor: VaultDirectoryCursor): string {
  if (!cursor.snapshot || !Number.isSafeInteger(cursor.offset) || cursor.offset < 0) {
    throw new Error('目录 cursor 无效')
  }
  return Buffer.from(JSON.stringify(cursor), 'utf8').toString('base64url')
}

/** 解码并校验目录 cursor，所有异常都折叠为固定错误。 */
export function decodeVaultDirectoryCursor(value: string | undefined): VaultDirectoryCursor {
  if (!value) throw new Error('目录 cursor 无效')
  try {
    const parsed: unknown = JSON.parse(Buffer.from(value, 'base64url').toString('utf8'))
    if (!parsed || typeof parsed !== 'object') throw new Error()
    const cursor = parsed as Partial<VaultDirectoryCursor>
    if (typeof cursor.snapshot !== 'string' || !cursor.snapshot || typeof cursor.offset !== 'number' || !Number.isSafeInteger(cursor.offset) || cursor.offset < 0) throw new Error()
    return { snapshot: cursor.snapshot, offset: cursor.offset }
  } catch {
    throw new Error('目录 cursor 无效')
  }
}

/**
 * 对单个目录的已过滤条目做稳定分页；目录扫描与安全路径校验由主进程负责。
 * cursor 的快照不一致时直接拒绝，避免变更期间静默漏读或重复读。
 */
export function paginateVaultDirectoryEntries(
  entries: readonly VaultTreeEntry[],
  request: VaultDirectoryPageRequest,
  snapshot: string,
): VaultDirectoryPage {
  const limit = request.limit ?? VAULT_DIRECTORY_PAGE_SIZE
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > VAULT_DIRECTORY_PAGE_SIZE) {
    throw new Error(`分页大小无效，最大为 ${VAULT_DIRECTORY_PAGE_SIZE}`)
  }
  const sorted = [...entries].sort((left, right) => left.relativePath.localeCompare(right.relativePath))
  const cursor = request.cursor ? decodeVaultDirectoryCursor(request.cursor) : { snapshot, offset: 0 }
  if (cursor.snapshot !== snapshot) throw new Error('目录已变化，请重新加载')
  if (cursor.offset > sorted.length) throw new Error('目录 cursor 无效')
  const end = Math.min(cursor.offset + limit, sorted.length)
  const page: VaultDirectoryPage = { entries: sorted.slice(cursor.offset, end), snapshot }
  if (end < sorted.length) page.nextCursor = encodeVaultDirectoryCursor({ snapshot, offset: end })
  return page
}
