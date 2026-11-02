import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createVaultFileSystem } from './vault-service'

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function createRoot(prefix: string): string {
  const root = mkdtempSync(join(tmpdir(), prefix))
  roots.push(root)
  return root
}

describe('VaultFileSystem.readFile', () => {
  test('Given 笔记内容与指纹未变 When 连续读取 Then 复用上次结果且 sha256 保持一致', () => {
    const root = createRoot('dutydeck-vault-read-cache-')
    writeFileSync(join(root, 'note.md'), '# 标题\n\n正文')

    const vault = createVaultFileSystem(root)
    const first = vault.readFile('note.md')
    const second = vault.readFile('note.md')

    expect(first.content).toBe('# 标题\n\n正文')
    /** 返回同一份结果对象，证明第二次未重新读盘与哈希。 */
    expect(second).toBe(first)
    expect(second.sha256).toBe(first.sha256)
  })

  test('Given 笔记被外部改写 When mtime 与大小变化 Then 重新读取正文与新摘要', () => {
    const root = createRoot('dutydeck-vault-read-external-')
    const notePath = join(root, 'note.md')
    writeFileSync(notePath, '旧正文')

    const vault = createVaultFileSystem(root)
    const before = vault.readFile('note.md')

    writeFileSync(notePath, '新的外部正文')
    /** 显式推进 mtime，避免同毫秒写入被指纹视为未变更。 */
    const future = new Date(Date.now() + 5_000)
    utimesSync(notePath, future, future)

    const after = vault.readFile('note.md')
    expect(after.content).toBe('新的外部正文')
    expect(after.sha256).not.toBe(before.sha256)
  })

  test('Given 同进程刚刚写入 When 立即读取 Then 不命中写入前的旧结果', () => {
    const root = createRoot('dutydeck-vault-read-write-')
    writeFileSync(join(root, 'note.md'), '第一版')

    const vault = createVaultFileSystem(root)
    const before = vault.readFile('note.md')

    const written = vault.writeFile({ relativePath: 'note.md', content: '第二版', expectedSha256: before.sha256 })
    /** 联合类型先收窄，才能读取成功分支的摘要。 */
    if (!written.ok) throw new Error(`写入应成功，实际: ${written.reason}`)

    const after = vault.readFile('note.md')
    expect(after.content).toBe('第二版')
    expect(after.sha256).toBe(written.sha256)
    expect(after.sha256).not.toBe(before.sha256)
  })
  test('Given 笔记被重命名 When 读取新路径 Then 返回新相对路径且旧路径缓存不残留', () => {
    const root = createRoot('dutydeck-vault-read-rename-')
    writeFileSync(join(root, 'old.md'), '内容')

    const vault = createVaultFileSystem(root)
    const renamed = vault.renameFile({ relativePath: 'old.md', name: 'new' })

    expect(renamed.relativePath).toBe('new.md')
    expect(renamed.content).toBe('内容')
    expect(() => vault.readFile('old.md')).toThrow()
    expect(vault.readFile('new.md').sha256).toBe(renamed.sha256)
  })
})
