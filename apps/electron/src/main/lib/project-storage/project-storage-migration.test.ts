import { afterEach, describe, expect, test } from 'bun:test'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  inspectProjectStorageMigrationNamespace,
  migrateProjectStorageNamespace,
  previewProjectStorageMigration,
} from './project-storage-migration'

/** 测试创建的隔离项目根，用例结束后统一清理。 */
const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

/** 创建真实临时项目根。 */
function createProjectRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'dutydeck-project-storage-migration-'))
  roots.push(root)
  return root
}

describe('项目存储迁移', () => {
  test('Given 旧项目 When 迁移 Then 已知目录移动到 .dutydeck 且未知内容保留', () => {
    const root = createProjectRoot()
    mkdirSync(join(root, '.proma', 'design'), { recursive: true })
    mkdirSync(join(root, '.proma', 'knowledge'), { recursive: true })
    writeFileSync(join(root, '.proma', 'design', 'canvas.json'), '{"version":4}')
    writeFileSync(join(root, '.proma', 'user-note.txt'), 'keep')

    const result = migrateProjectStorageNamespace(root)

    expect(result.movedDirectories).toEqual(['design', 'knowledge'])
    expect(readFileSync(join(root, '.dutydeck', 'design', 'canvas.json'), 'utf8')).toBe('{"version":4}')
    expect(readFileSync(join(root, '.proma', 'user-note.txt'), 'utf8')).toBe('keep')
    expect(existsSync(join(root, '.proma', 'design'))).toBe(false)
    expect(JSON.parse(readFileSync(join(root, '.dutydeck', 'project-storage.json'), 'utf8'))).toMatchObject({
      version: 1,
      movedDirectories: ['design', 'knowledge'],
      retainedLegacyEntries: ['user-note.txt'],
    })
  })

  test('Given 同一模块新旧目录同时存在 When 迁移 Then 不移动任何目录', () => {
    const root = createProjectRoot()
    mkdirSync(join(root, '.proma', 'design'), { recursive: true })
    mkdirSync(join(root, '.dutydeck', 'design'), { recursive: true })

    expect(() => migrateProjectStorageNamespace(root)).toThrow('PROJECT_STORAGE_DIRECTORY_CONFLICT')
    expect(existsSync(join(root, '.proma', 'design'))).toBe(true)
    expect(existsSync(join(root, '.dutydeck', 'design'))).toBe(true)
    expect(inspectProjectStorageMigrationNamespace(root).state).toBe('conflict')
  })

  test('Given 上次只迁移了一部分 When 再次迁移 Then 从剩余目录继续且保持幂等', () => {
    const root = createProjectRoot()
    mkdirSync(join(root, '.dutydeck', 'design'), { recursive: true })
    mkdirSync(join(root, '.proma', 'knowledge'), { recursive: true })

    expect(migrateProjectStorageNamespace(root).movedDirectories).toEqual(['knowledge'])
    expect(migrateProjectStorageNamespace(root).movedDirectories).toEqual([])
  })

  test('Given 新旧目录分散在不同模块 When 检查 Then 返回 mixed', () => {
    const root = createProjectRoot()
    mkdirSync(join(root, '.proma', 'design'), { recursive: true })
    mkdirSync(join(root, '.dutydeck', 'knowledge'), { recursive: true })

    const status = inspectProjectStorageMigrationNamespace(root)

    expect(status.state).toBe('mixed')
    expect(status.directories.find((item) => item.directory === 'design')?.state).toBe('legacy')
    expect(status.directories.find((item) => item.directory === 'knowledge')?.state).toBe('current')
  })

  test('Given 旧存储根是符号链接 When 预览 Then 明确阻断且不创建当前目录', () => {
    const root = createProjectRoot()
    symlinkSync(tmpdir(), join(root, '.proma'))

    expect(() => previewProjectStorageMigration(root)).toThrow('PROJECT_STORAGE_UNSAFE')
    expect(existsSync(join(root, '.dutydeck'))).toBe(false)
  })
})
