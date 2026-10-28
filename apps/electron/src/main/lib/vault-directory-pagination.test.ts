import { describe, expect, test } from 'bun:test'
import type { VaultTreeEntry } from '@dutydeck/shared'
import {
  createVaultDirectorySnapshot,
  decodeVaultDirectoryCursor,
  encodeVaultDirectoryCursor,
  paginateVaultDirectoryEntries,
} from './vault-directory-pagination'

function file(relativePath: string): VaultTreeEntry {
  const name = relativePath.split('/').at(-1) ?? relativePath
  return { kind: 'file', relativePath, name, size: 1, modifiedAt: 1 }
}

describe('Vault directory pagination', () => {
  test('每页返回有界条目并生成可续读 cursor', () => {
    const entries = Array.from({ length: 3 }, (_, index) => file(`note-${index}.md`))
    const snapshot = createVaultDirectorySnapshot(entries)

    const first = paginateVaultDirectoryEntries(entries, { limit: 2 }, snapshot)
    expect(first.entries.map(entry => entry.relativePath)).toEqual(['note-0.md', 'note-1.md'])
    expect(first.nextCursor).toBeDefined()

    const cursor = decodeVaultDirectoryCursor(first.nextCursor)
    const second = paginateVaultDirectoryEntries(entries, { cursor: first.nextCursor, limit: 2 }, snapshot)
    expect(cursor.snapshot).toBe(snapshot)
    expect(second.entries.map(entry => entry.relativePath)).toEqual(['note-2.md'])
    expect(second.nextCursor).toBeUndefined()
  })

  test('目录快照变化后拒绝旧 cursor，避免分页跳过或重复条目', () => {
    const entries = [file('a.md'), file('b.md'), file('c.md')]
    const oldSnapshot = createVaultDirectorySnapshot(entries)
    const first = paginateVaultDirectoryEntries(entries, { limit: 1 }, oldSnapshot)
    const changed = [...entries, file('d.md')]
    const newSnapshot = createVaultDirectorySnapshot(changed)

    expect(() => paginateVaultDirectoryEntries(changed, { cursor: first.nextCursor, limit: 1 }, newSnapshot)).toThrow('目录已变化')
  })

  test('非法 limit 和 cursor 都 fail closed', () => {
    const entries = [file('a.md')]
    const snapshot = createVaultDirectorySnapshot(entries)
    expect(() => paginateVaultDirectoryEntries(entries, { limit: 0 }, snapshot)).toThrow('分页大小无效')
    expect(() => paginateVaultDirectoryEntries(entries, { cursor: 'bad', limit: 1 }, snapshot)).toThrow('目录 cursor 无效')
    expect(() => encodeVaultDirectoryCursor({ snapshot, offset: -1 })).toThrow('目录 cursor 无效')
    // 缺失或非数字偏移量不能成为可续读的目录位置。
    for (const offset of [undefined, null, '1', -1, 1.5]) {
      const malformed = Buffer.from(JSON.stringify({ snapshot, offset }), 'utf8').toString('base64url')
      expect(() => decodeVaultDirectoryCursor(malformed)).toThrow('目录 cursor 无效')
    }
  })
})
