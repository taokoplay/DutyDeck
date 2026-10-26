import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AgentWorkspace } from '@dutydeck/shared'
import { createDesignPathResolver } from './design-paths'

describe('Design 路径解析', () => {
  /** 每个测试独占的临时根。 */
  let tempRoot: string
  /** 实际存在的项目根。 */
  let projectRoot: string
  /** 当前活动业务数据根。 */
  let configRoot: string

  beforeEach(() => {
    tempRoot = mkdtempSync(join(tmpdir(), 'dutydeck-design-paths-'))
    projectRoot = join(tempRoot, 'project')
    configRoot = join(tempRoot, 'config', '.DutyDeck')
    mkdirSync(projectRoot, { recursive: true })
    mkdirSync(configRoot, { recursive: true })
  })

  afterEach(() => {
    rmSync(tempRoot, { recursive: true, force: true })
  })

  /** 创建可读取真实临时项目根的解析器。 */
  function createResolver(workspace: AgentWorkspace | undefined): ReturnType<typeof createDesignPathResolver> {
    return createDesignPathResolver({
      getWorkspace: () => workspace,
      getProjectFilesPath: () => projectRoot,
      getConfigDir: () => configRoot,
    })
  }

  test('Given 外部项目 When 解析 Then 新项目正式数据写入 .dutydeck 且缓存按稳定 ID 隔离', () => {
    const resolver = createResolver({
      id: 'project-1',
      name: '项目',
      slug: 'stable-slug',
      projectRootPath: projectRoot,
      createdAt: 1,
      updatedAt: 1,
    })

    expect(resolver.resolve('project-1')).toEqual({
      projectId: 'project-1',
      projectRoot,
      storageRoot: join(projectRoot, '.dutydeck'),
      designRoot: join(projectRoot, '.dutydeck', 'design'),
      canvasPath: join(projectRoot, '.dutydeck', 'design', 'canvas.json'),
      canvasesRoot: join(projectRoot, '.dutydeck', 'design', 'canvases'),
      canvasSessionsIndexPath: join(projectRoot, '.dutydeck', 'design', 'canvases', 'index.json'),
      assetsDir: join(projectRoot, '.dutydeck', 'design', 'assets'),
      annotationsDir: join(projectRoot, '.dutydeck', 'design', 'annotations'),
      contextRoot: join(projectRoot, '.dutydeck', 'design', 'context'),
      contextManifestPath: join(projectRoot, '.dutydeck', 'design', 'context', 'manifest.json'),
      contextDocumentsDir: join(projectRoot, '.dutydeck', 'design', 'context', 'documents'),
      contextReferencesDir: join(projectRoot, '.dutydeck', 'design', 'context', 'references'),
      cacheRoot: join(configRoot, 'design-cache', 'project-1'),
      preferencesPath: join(configRoot, 'design-cache', 'project-1', 'preferences.json'),
      thumbnailsDir: join(configRoot, 'design-cache', 'project-1', 'thumbnails'),
      jobsDir: join(configRoot, 'design-cache', 'project-1', 'jobs'),
      tracesDir: join(configRoot, 'design-cache', 'project-1', 'traces'),
      stagingDir: join(configRoot, 'design-cache', 'project-1', 'staging'),
    })

    expect(resolver.resolveCanvas('project-1', 'canvas-1')).toMatchObject({
      canvasRoot: join(projectRoot, '.dutydeck', 'design', 'canvases', 'canvas-1'),
      documentPath: join(projectRoot, '.dutydeck', 'design', 'canvases', 'canvas-1', 'canvas.json'),
    })
    expect(existsSync(join(projectRoot, '.dutydeck', 'design'))).toBe(false)
    expect(existsSync(join(projectRoot, '.proma'))).toBe(false)
  })

  test('Given 只有旧 .proma/design When 解析 Then 继续使用旧目录等待显式迁移', () => {
    mkdirSync(join(projectRoot, '.proma', 'design'), { recursive: true })
    const resolver = createResolver({
      id: 'project-1',
      name: '旧项目',
      slug: 'stable-slug',
      projectRootPath: projectRoot,
      createdAt: 1,
      updatedAt: 1,
    })

    const paths = resolver.resolve('project-1')

    expect(paths.storageRoot).toBe(join(projectRoot, '.proma'))
    expect(paths.designRoot).toBe(join(projectRoot, '.proma', 'design'))
    expect(existsSync(join(projectRoot, '.dutydeck'))).toBe(false)
  })

  test('Given 托管项目 When 解析 Then 通过不可变 slug 获取项目根', () => {
    let resolvedSlug = ''
    const resolver = createDesignPathResolver({
      getWorkspace: () => ({
        id: 'project-2',
        name: '托管项目',
        slug: 'managed-slug',
        createdAt: 1,
        updatedAt: 1,
      }),
      getProjectFilesPath: (slug) => {
        resolvedSlug = slug
        return projectRoot
      },
      getConfigDir: () => configRoot,
    })

    const paths = resolver.resolve('project-2')
    expect(resolvedSlug).toBe('managed-slug')
    expect(paths.projectRoot).toBe(projectRoot)
    expect(paths.designRoot).toBe(join(projectRoot, '.dutydeck', 'design'))
  })

  test('Given 未知项目 When 解析 Then 明确拒绝', () => {
    const resolver = createResolver(undefined)
    expect(() => resolver.resolve('forged')).toThrow('项目不存在: forged')
  })

  test('Given 非法项目 ID When 解析 Then 在构造缓存路径前拒绝', () => {
    let workspaceLookupCalled = false
    const resolver = createDesignPathResolver({
      getWorkspace: () => {
        workspaceLookupCalled = true
        return undefined
      },
      getProjectFilesPath: () => projectRoot,
      getConfigDir: () => configRoot,
    })

    expect(() => resolver.resolve('../escape')).toThrow('项目 ID 非法')
    expect(workspaceLookupCalled).toBe(false)
  })

  test('Given 项目显示名变化 When 解析 Then 缓存映射保持稳定', () => {
    let projectName = '旧名称'
    const resolver = createDesignPathResolver({
      getWorkspace: () => ({
        id: 'stable_id-1',
        name: projectName,
        slug: 'stable-slug',
        createdAt: 1,
        updatedAt: 1,
      }),
      getProjectFilesPath: () => projectRoot,
      getConfigDir: () => configRoot,
    })

    const beforeRename = resolver.resolve('stable_id-1').cacheRoot
    projectName = '新名称'
    expect(resolver.resolve('stable_id-1').cacheRoot).toBe(beforeRename)
  })
})
