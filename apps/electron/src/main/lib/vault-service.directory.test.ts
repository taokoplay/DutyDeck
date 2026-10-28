import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createVaultFileSystem } from './vault-service'

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('VaultFileSystem.listDirectoryPage', () => {
  test('只读取当前目录并支持跨页续读', async () => {
    const root = mkdtempSync(join(tmpdir(), 'dutydeck-vault-page-'))
    roots.push(root)
    mkdirSync(join(root, 'nested'))
    writeFileSync(join(root, 'a.md'), '# A')
    writeFileSync(join(root, 'b.md'), '# B')
    writeFileSync(join(root, 'nested', 'hidden.md'), '# hidden')
    writeFileSync(join(root, 'ignore.txt'), 'ignore')

    const vault = createVaultFileSystem(root)
    const first = await vault.listDirectoryPage('', { limit: 2 })
    expect(first.entries.map(entry => entry.relativePath)).toEqual(['a.md', 'b.md'])
    expect(first.nextCursor).toBeDefined()

    const second = await vault.listDirectoryPage('', { cursor: first.nextCursor, limit: 2 })
    expect(second.entries.map(entry => entry.relativePath)).toEqual(['nested'])
    expect(second.nextCursor).toBeUndefined()
  })

  test('子目录分页不递归读取更深层文件', async () => {
    const root = mkdtempSync(join(tmpdir(), 'dutydeck-vault-page-'))
    roots.push(root)
    mkdirSync(join(root, 'nested', 'deep'), { recursive: true })
    writeFileSync(join(root, 'nested', 'one.md'), '# one')
    writeFileSync(join(root, 'nested', 'deep', 'two.md'), '# two')

    const page = await createVaultFileSystem(root).listDirectoryPage('nested')
    expect(page.entries.map(entry => entry.relativePath)).toEqual(['nested/deep', 'nested/one.md'])
  })

  test('目录变化后旧 cursor 会被拒绝', async () => {
    const root = mkdtempSync(join(tmpdir(), 'dutydeck-vault-page-'))
    roots.push(root)
    writeFileSync(join(root, 'a.md'), '# A')
    writeFileSync(join(root, 'b.md'), '# B')
    const vault = createVaultFileSystem(root)
    const first = await vault.listDirectoryPage('', { limit: 1 })
    writeFileSync(join(root, 'c.md'), '# C')

    await expect(vault.listDirectoryPage('', { cursor: first.nextCursor, limit: 1 })).rejects.toThrow('目录已变化')
  })
})
