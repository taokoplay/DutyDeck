import { afterEach, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { interactionDirectory } from './paths'

/** 测试创建的隔离项目根，用例结束后统一清理。 */
const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

/** 创建真实临时项目根。 */
function createProjectRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'dutydeck-interaction-paths-'))
  roots.push(root)
  return root
}

describe('交互设计项目存储路径', () => {
  test('Given 新项目 When 创建交互目录 Then 使用 .dutydeck', () => {
    const root = createProjectRoot()
    expect(interactionDirectory(root, ['.dutydeck', 'interaction-design', 'prototypes'], true))
      .toBe(join(root, '.dutydeck', 'interaction-design', 'prototypes'))
  })

  test('Given 只有旧项目目录 When 读取 Then 继续使用 .proma', () => {
    const root = createProjectRoot()
    mkdirSync(join(root, '.proma', 'interaction-design', 'prototypes'), { recursive: true })
    expect(interactionDirectory(root, ['.dutydeck', 'interaction-design', 'prototypes'], false))
      .toBe(join(root, '.proma', 'interaction-design', 'prototypes'))
  })

  test('Given 同一模块新旧目录同时存在 When 解析 Then fail closed', () => {
    const root = createProjectRoot()
    mkdirSync(join(root, '.proma', 'interaction-design'), { recursive: true })
    mkdirSync(join(root, '.dutydeck', 'interaction-design'), { recursive: true })
    expect(() => interactionDirectory(root, ['.dutydeck', 'interaction-design'], false))
      .toThrow('PROJECT_STORAGE_DIRECTORY_CONFLICT')
  })

  test('Given 旧存储根是符号链接 When 解析 Then 拒绝越界', () => {
    const root = createProjectRoot()
    symlinkSync(tmpdir(), join(root, '.proma'))
    expect(() => interactionDirectory(root, ['.dutydeck', 'interaction-design'], false))
      .toThrow('PROJECT_STORAGE_UNSAFE')
  })
})
