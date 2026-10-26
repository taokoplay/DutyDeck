import { afterEach, describe, expect, test } from 'bun:test'
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
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
import { createProjectStorageAttachmentResolver } from './project-storage-attachment-paths'

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
  test('Given design 已完成首次迁移 When 独立迁移 knowledge Then 保留旧附件映射且不虚报新建模块', () => {
    const root = createProjectRoot()
    mkdirSync(join(root, '.proma', 'design'), { recursive: true })
    migrateProjectStorageNamespace(root)
    mkdirSync(join(root, '.dutydeck', 'visual-production'))
    mkdirSync(join(root, '.proma', 'knowledge'))
    migrateProjectStorageNamespace(root)
    const resolveAttachment = createProjectStorageAttachmentResolver(root, (path) => path)
    expect(resolveAttachment(join(root, '.proma', 'design', 'image.png')))
      .toBe(join(root, '.dutydeck', 'design', 'image.png'))
    expect(JSON.parse(readFileSync(join(root, '.dutydeck', 'project-storage.json'), 'utf8')).movedDirectories)
      .toEqual(['design', 'knowledge'])
  })

  test('Given 历史迁移目录已移走 When 再迁移 Then 不保留失效历史声明', () => {
    const root = createProjectRoot()
    mkdirSync(join(root, '.proma', 'design'), { recursive: true })
    migrateProjectStorageNamespace(root)
    renameSync(join(root, '.dutydeck', 'design'), join(root, 'design-backup'))
    mkdirSync(join(root, '.proma', 'knowledge'))
    migrateProjectStorageNamespace(root)
    expect(JSON.parse(readFileSync(join(root, '.dutydeck', 'project-storage.json'), 'utf8')).movedDirectories).toEqual(['knowledge'])
  })

  test.each(['损坏JSON', '非法目录', '悬空链接'])('Given 已有标记%s When 后续迁移 Then 移动前拒绝且保留源目录', (kind) => {
    const root = createProjectRoot()
    mkdirSync(join(root, '.proma', 'knowledge'), { recursive: true })
    mkdirSync(join(root, '.dutydeck'))
    const markerPath = join(root, '.dutydeck', 'project-storage.json')
    if (kind === '悬空链接') symlinkSync(join(root, 'missing-marker'), markerPath)
    else writeFileSync(markerPath, kind === '损坏JSON' ? '{' : JSON.stringify({
      version: 1, migratedAt: 1, movedDirectories: ['../outside'], retainedLegacyEntries: [],
    }))
    expect(() => migrateProjectStorageNamespace(root)).toThrow('PROJECT_STORAGE_UNSAFE')
    expect(existsSync(join(root, '.proma', 'knowledge'))).toBe(true)
    expect(existsSync(join(root, '.dutydeck', 'knowledge'))).toBe(false)
  })

  test.each(['字符串', '旧安全整数'])('Given %s身份日志 When 移动后中断再恢复 Then 无损匹配真实目录', (format) => {
    const root = createProjectRoot()
    mkdirSync(join(root, '.proma', 'design'), { recursive: true })
    expect(() => migrateProjectStorageNamespace(root, { rename: (source, target) => {
      renameSync(source, target)
      throw new Error('身份恢复中断')
    } })).toThrow('身份恢复中断')
    const journalPath = join(root, '.dutydeck', '.project-storage-migration.json')
    const source = readFileSync(journalPath, 'utf8')
    expect(JSON.parse(source).entries.design.ino).toBe(lstatSync(join(root, '.dutydeck', 'design'), { bigint: true }).ino.toString())
    if (format === '旧安全整数') {
      /** 仅将可无损转换的十进制身份退回旧日志格式。 */
      const legacy: unknown = JSON.parse(source, (_key, value: unknown) => (
        typeof value === 'string' && /^[0-9]+$/.test(value) && Number.isSafeInteger(Number(value)) ? Number(value) : value
      ))
      writeFileSync(journalPath, JSON.stringify(legacy))
    }
    expect(migrateProjectStorageNamespace(root).movedDirectories).toEqual([])
    expect(existsSync(journalPath)).toBe(false)
  })

  test.each(['9007199254740993', 9007199254740992])('Given 超安全整数身份%s When 读取恢复日志 Then 字符串保留精度而不精确number拒绝', (identity) => {
    const root = createProjectRoot()
    mkdirSync(join(root, '.proma', 'design'), { recursive: true })
    expect(() => migrateProjectStorageNamespace(root, { rename: () => { throw new Error('写入日志后中断') } })).toThrow('写入日志后中断')
    const journalPath = join(root, '.dutydeck', '.project-storage-migration.json')
    const journal = JSON.parse(readFileSync(journalPath, 'utf8')) as { project: { ino: string | number } }
    journal.project.ino = identity
    writeFileSync(journalPath, JSON.stringify(journal))
    if (typeof identity === 'string') {
      expect(inspectProjectStorageMigrationNamespace(root).recoveryRequired).toBe(true)
      expect(() => migrateProjectStorageNamespace(root)).toThrow('迁移父目录身份已变化')
    } else expect(() => migrateProjectStorageNamespace(root)).toThrow('迁移日志身份无效')
    expect(existsSync(join(root, '.proma', 'design'))).toBe(true)
  })
  test('Given 无存储数据 When 预览与迁移 Then 不创建任何文件', () => {
    const root = createProjectRoot()
    expect(inspectProjectStorageMigrationNamespace(root).state).toBe('none')
    expect(migrateProjectStorageNamespace(root).movedDirectories).toEqual([])
    expect(readdirSync(root)).toEqual([])
  })

  test('Given 仅一个旧模块 When 迁移 Then missing 不影响 legacy/current 汇总', () => {
    const root = createProjectRoot()
    mkdirSync(join(root, '.proma', 'design'), { recursive: true })
    expect(inspectProjectStorageMigrationNamespace(root).state).toBe('legacy')
    migrateProjectStorageNamespace(root)
    expect(inspectProjectStorageMigrationNamespace(root).state).toBe('current')
  })

  test('Given rename 后故障 When 重试 Then 识别已移动身份且 marker 包含完整历史', () => {
    const root = createProjectRoot()
    mkdirSync(join(root, '.proma', 'design'), { recursive: true })
    mkdirSync(join(root, '.proma', 'knowledge'), { recursive: true })
    expect(() => migrateProjectStorageNamespace(root, {
      rename: (source, target) => {
        renameSync(source, target)
        throw new Error('模拟移动后中断')
      },
    })).toThrow('模拟移动后中断')
    expect(inspectProjectStorageMigrationNamespace(root).recoveryRequired).toBe(true)
    expect(migrateProjectStorageNamespace(root).movedDirectories).toEqual(['knowledge'])
    expect(JSON.parse(readFileSync(join(root, '.dutydeck', 'project-storage.json'), 'utf8')).movedDirectories)
      .toEqual(['design', 'knowledge'])
    expect(inspectProjectStorageMigrationNamespace(root).recoveryRequired).toBeUndefined()
    expect(existsSync(join(root, '.dutydeck', '.project-storage-migration.json'))).toBe(false)
  })

  test('Given 最后目录已移动但标记前中断 When 恢复 Then current 状态仍提供恢复入口并清理日志', () => {
    const root = createProjectRoot()
    mkdirSync(join(root, '.proma', 'design'), { recursive: true })
    expect(() => migrateProjectStorageNamespace(root, { rename: (source, target) => { renameSync(source, target); throw new Error('标记前中断') } })).toThrow('标记前中断')
    expect(inspectProjectStorageMigrationNamespace(root)).toMatchObject({ state: 'current', recoveryRequired: true })
    expect(migrateProjectStorageNamespace(root).movedDirectories).toEqual([])
    expect(inspectProjectStorageMigrationNamespace(root).recoveryRequired).toBeUndefined()
    expect(JSON.parse(readFileSync(join(root, '.dutydeck', 'project-storage.json'), 'utf8')).movedDirectories).toEqual(['design'])
  })

  test('Given 已移动目录被替换 When 重试 Then 不接认外部目录', () => {
    const root = createProjectRoot()
    mkdirSync(join(root, '.proma', 'design'), { recursive: true })
    expect(() => migrateProjectStorageNamespace(root, {
      rename: (source, target) => {
        renameSync(source, target)
        throw new Error('模拟中断')
      },
    })).toThrow('模拟中断')
    renameSync(join(root, '.dutydeck', 'design'), join(root, 'original-design'))
    mkdirSync(join(root, '.dutydeck', 'design'))
    expect(() => migrateProjectStorageNamespace(root)).toThrow('PROJECT_STORAGE_UNSAFE')
  })

  test('Given 已有迁移锁 When 迁移 Then 阻断且不创建新命名空间', () => {
    const root = createProjectRoot()
    mkdirSync(join(root, '.proma', 'design'), { recursive: true })
    writeFileSync(join(root, '.project-storage-migration.lock'), JSON.stringify({ version: 1, pid: process.pid, token: 'active-owner' }))
    expect(() => migrateProjectStorageNamespace(root)).toThrow('PROJECT_STORAGE_MIGRATION_BUSY')
    expect(existsSync(join(root, '.dutydeck'))).toBe(false)
  })

  test('Given 崩溃进程留下锁 When 重试 Then 通过唯一后继恢复迁移', () => {
    const root = createProjectRoot()
    mkdirSync(join(root, '.proma', 'design'), { recursive: true })
    /** 超出平台 PID 范围的正整数模拟已退出 owner，不终止任何真实进程。 */
    writeFileSync(join(root, '.project-storage-migration.lock'), JSON.stringify({ version: 1, pid: 2147483647, token: 'dead-owner' }))
    expect(migrateProjectStorageNamespace(root).movedDirectories).toEqual(['design'])
  })

  test('Given 悬空目标链接 When 迁移 Then 拒绝并保留源数据', () => {
    const root = createProjectRoot()
    mkdirSync(join(root, '.proma', 'design'), { recursive: true })
    mkdirSync(join(root, '.dutydeck'))
    symlinkSync(join(root, 'missing'), join(root, '.dutydeck', 'design'))
    expect(() => migrateProjectStorageNamespace(root)).toThrow('PROJECT_STORAGE_UNSAFE')
    expect(existsSync(join(root, '.proma', 'design'))).toBe(true)
  })
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
