import { afterEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  ensureKnowledgeDirectories,
  getKnowledgeRoot,
  getManifestPath,
} from './paths'
import type { ResolvedKnowledgeProject } from './types'

/** 测试创建的隔离项目，用例结束后统一清理。 */
const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

/** 创建真实临时项目及其可信知识边界。 */
function createProject(): ResolvedKnowledgeProject {
  const root = mkdtempSync(join(tmpdir(), 'dutydeck-knowledge-paths-'))
  roots.push(root)
  return {
    projectId: 'project-1',
    projectRoot: root,
    memoryRoot: join(root, 'memory'),
    cacheRoot: join(root, 'cache'),
  }
}

describe('项目知识目录解析', () => {
  test('Given 新知识库 When 创建目录 Then 写入 .dutydeck/knowledge', () => {
    const project = createProject()

    ensureKnowledgeDirectories(project)

    expect(getKnowledgeRoot(project)).toBe(join(project.projectRoot, '.dutydeck', 'knowledge'))
    expect(getManifestPath(project)).toBe(join(project.projectRoot, '.dutydeck', 'knowledge', 'manifest.json'))
    expect(existsSync(join(project.projectRoot, '.dutydeck', 'knowledge'))).toBe(true)
    expect(existsSync(join(project.projectRoot, '.proma'))).toBe(false)
  })

  test('Given 只有旧知识库 When 读取 Then 使用 .proma/knowledge 等待迁移', () => {
    const project = createProject()
    mkdirSync(join(project.projectRoot, '.proma', 'knowledge'), { recursive: true })

    expect(getKnowledgeRoot(project)).toBe(join(project.projectRoot, '.proma', 'knowledge'))
    expect(existsSync(join(project.projectRoot, '.dutydeck'))).toBe(false)
  })
})
