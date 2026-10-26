import { afterEach, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createProjectStorageAttachmentResolver } from './project-storage-attachment-paths'
import { migrateProjectStorageNamespace } from './project-storage-migration'
import { projectSessionAttachmentPaths } from '../session-attachment-path-compat'
import type { SDKMessage } from '@dutydeck/shared'

/** 历史附件测试只创建隔离项目，不读取真实会话。 */
const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })

/** 生成一个可迁移的旧项目。 */
function project(): string {
  const root = mkdtempSync(join(tmpdir(), 'dutydeck-attachment-alias-'))
  roots.push(root)
  mkdirSync(join(root, '.proma', 'design'), { recursive: true })
  return root
}

describe('项目迁移历史附件投影', () => {
  test('Given 已确认迁移 When 读取结构化历史附件 Then 只映射白名单路径且不改正文或原消息', () => {
    const root = project()
    const oldPath = join(root, '.proma', 'design', 'assets', 'image.png')
    const before = createProjectStorageAttachmentResolver(root, (path) => path)
    expect(before(oldPath)).toBe(oldPath)
    migrateProjectStorageNamespace(root)
    const resolver = createProjectStorageAttachmentResolver(root, (path) => path)
    const message = { type: 'user', imageAttachments: [{ localPath: oldPath }], message: { content: `正文 ${oldPath}` } } as unknown as SDKMessage
    const projected = projectSessionAttachmentPaths(message, resolver)
    expect(JSON.stringify(projected)).toContain(join(root, '.dutydeck', 'design', 'assets', 'image.png'))
    expect(JSON.stringify(projected)).toContain(`正文 ${oldPath}`)
    expect(JSON.stringify(message)).not.toContain('.dutydeck')
    for (const path of [join(root, '.proma', 'unknown', 'a.png'), join(root, '.proma', 'design-other', 'a.png'), join(root, 'elsewhere', 'a.png'), join(root, '.proma', 'design', '..', 'secret.png')]) {
      expect(resolver(path)).toBe(path)
    }
  })

  test('Given 无迁移标记或目标根被换成链接 When 读取 Then 保留原引用且数据根解析错误仍传播', () => {
    const root = project()
    const oldPath = join(root, '.proma', 'design', 'a.png')
    mkdirSync(join(root, '.dutydeck', 'knowledge'), { recursive: true })
    expect(createProjectStorageAttachmentResolver(root, (path) => path)(oldPath)).toBe(oldPath)
    rmSync(join(root, '.dutydeck'), { recursive: true })
    symlinkSync(tmpdir(), join(root, '.dutydeck'))
    expect(createProjectStorageAttachmentResolver(root, (path) => path)(oldPath)).toBe(oldPath)
    expect(() => createProjectStorageAttachmentResolver(undefined, () => { throw new Error('定位器离线') })(oldPath)).toThrow('定位器离线')
  })
})
