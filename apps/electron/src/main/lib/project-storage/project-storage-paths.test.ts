import { afterEach, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  inspectProjectStorageDirectory,
  resolveProjectStorageDirectory,
} from './project-storage-paths'

/** 测试创建的隔离项目根，用例结束后统一清理。 */
const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

/** 创建真实临时项目根。 */
function createProjectRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'dutydeck-project-storage-'))
  roots.push(root)
  return root
}

describe('项目存储目录解析', () => {
  test('Given 新旧目录都不存在 When 创建写入路径 Then 使用 .dutydeck', () => {
    const root = createProjectRoot()
    const path = resolveProjectStorageDirectory(root, 'design', true)
    expect(path).toBe(join(root, '.dutydeck', 'design'))
  })

  test('Given 只有旧目录 When 解析 Then 继续兼容旧路径且不双写', () => {
    const root = createProjectRoot()
    mkdirSync(join(root, '.proma', 'design'), { recursive: true })
    expect(resolveProjectStorageDirectory(root, 'design', true)).toBe(join(root, '.proma', 'design'))
    expect(inspectProjectStorageDirectory(root, 'design')).toEqual({
      directory: 'design',
      state: 'legacy',
      sourcePath: join(root, '.proma', 'design'),
      targetPath: join(root, '.dutydeck', 'design'),
    })
  })

  test('Given 同一模块新旧目录同时存在 When 解析 Then fail closed', () => {
    const root = createProjectRoot()
    mkdirSync(join(root, '.proma', 'design'), { recursive: true })
    mkdirSync(join(root, '.dutydeck', 'design'), { recursive: true })
    expect(() => resolveProjectStorageDirectory(root, 'design', true)).toThrow('PROJECT_STORAGE_DIRECTORY_CONFLICT')
  })

  test('Given 旧存储根是符号链接 When 解析 Then 拒绝越界', () => {
    const root = createProjectRoot()
    symlinkSync(tmpdir(), join(root, '.proma'))
    expect(() => resolveProjectStorageDirectory(root, 'design', true)).toThrow('PROJECT_STORAGE_UNSAFE')
  })
})
