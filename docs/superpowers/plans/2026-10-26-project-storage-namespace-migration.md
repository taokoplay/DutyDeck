# 项目存储命名空间迁移实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

> 执行状态：2026-10-26 已完成。下方代码块保留原始设计草案；最终实现差异、验证与限制见文末执行记录。

**Goal:** 将 DutyDeck 自有的项目级数据从 `<项目根>/.proma/*` 迁移到 `<项目根>/.dutydeck/*`，保留迁移前旧目录的兼容读写和可恢复迁移路径，确保旧项目、自定义数据根及并发写入场景不会丢数据。

**Architecture:** 新增唯一的项目存储目录契约和惰性解析器。新项目直接写入 `.dutydeck`；仍只有 `.proma` 的旧项目在用户显式确认前继续使用旧目录，确认后仅在应用无活动写入时把四个已知子目录原子改名到 `.dutydeck`。未知 `.proma` 内容不移动、不删除；`.proma-location.json`、`PROMA_*`、`proma` CLI 和用户级 `~/.proma` 迁移兼容继续保留。

**Tech Stack:** Bun、TypeScript、Electron、React、Jotai、Bun test、safe-file 原子写入。

---

## 已确认边界

- 用户级业务数据根已经迁移到 `~/.DutyDeck`，本计划不再修改 DataRootLocator。
- 当前项目存储命名空间统一为 `.dutydeck`，与已有 `.dutydeck/plugin-artifacts/` 保持一致。
- 只迁移 DutyDeck 拥有的四个项目子目录：
  - `design`
  - `knowledge`
  - `interaction-design`
  - `visual-production`
- `<项目根>/.proma` 中不属于上述子目录的文件和目录属于未知内容，迁移器不得移动、覆盖或删除。
- 用户级 `~/.proma`、`.proma-location.json`、`PROMA_*`、`proma` CLI、历史 `proma_event` 等跨版本兼容值不在本计划删除范围。
- 新项目创建数据时直接使用 `.dutydeck`；旧项目只有旧目录时继续使用旧目录，直到用户确认迁移，避免迁移与旧版本客户端之间出现静默双写。
- 迁移采用同一项目卷内 `rename`，不复制大文件；每个子目录的移动是原子的，整个迁移通过逐项检查和标记实现可恢复。
- 应用存在运行中的 Agent 写入、Automation、媒体任务或任何项目的异步写租约时，迁移必须被阻断；同一物理根的工作区别名必须共同加锁。
- 迁移成功后不保证旧版 DutyDeck/Proma 继续读取项目数据；确认对话框必须明确提示这一点，并建议先备份项目。

## 文件结构

### 新增

- `packages/shared/src/constants/project-storage.ts`
  - 当前与旧项目存储目录名、已知子目录白名单和稳定错误码。
- `packages/shared/src/constants/project-storage.test.ts`
  - 锁定命名空间常量，防止各模块再次散落硬编码。
- `apps/electron/src/main/lib/project-storage/project-storage-paths.ts`
  - 只读解析当前目录、旧目录和冲突状态。
- `apps/electron/src/main/lib/project-storage/project-storage-paths.test.ts`
  - 覆盖新项目、旧项目、迁移完成、双目录冲突和符号链接。
- `apps/electron/src/main/lib/project-storage/project-storage-migration.ts`
  - 只读预览、原子移动、部分完成恢复与迁移标记。
- `apps/electron/src/main/lib/project-storage/project-storage-migration.test.ts`
  - 覆盖成功、幂等、部分迁移、冲突、未知内容和失败恢复。

### 修改

- `packages/shared/src/index.ts`
- `packages/shared/src/types/path-management.ts`
- `packages/shared/src/types/visual-production-plugin.ts`
- `apps/electron/src/main/lib/design/design-paths.ts`
- `apps/electron/src/main/lib/design/design-context-catalog.ts`
- `apps/electron/src/main/lib/design/design-project-text-index.ts`
- `apps/electron/src/main/lib/project-knowledge/paths.ts`
- `apps/electron/src/main/lib/project-knowledge/scanner.ts`
- `apps/electron/src/main/lib/project-knowledge/vault.ts`
- `apps/electron/src/main/lib/interaction-design/paths.ts`
- `apps/electron/src/main/lib/interaction-design/store.ts`
- `apps/electron/src/main/lib/interaction-design/asset-service.ts`
- `apps/electron/src/main/lib/visual-production/store.ts`
- `apps/electron/src/main/lib/visual-production/context-evidence-store.ts`
- `apps/electron/src/main/lib/visual-production/editing-store.ts`
- `apps/electron/src/main/lib/path-management-ipc.ts`
- `apps/electron/src/main/lib/workspace-project-relocator-production.ts`
- `apps/electron/src/main/ipc.ts`
- `apps/electron/src/preload/path-management-preload.ts`
- `apps/electron/src/renderer/components/settings/PathManagementSettings.tsx`
- `apps/electron/src/renderer/components/settings/PathManagementSettings.test.tsx`
- 对应模块测试与 `README.md`、教程、迁移说明和扩展文档。

## Task 1：建立唯一项目存储契约

**Files:**
- Create: `packages/shared/src/constants/project-storage.ts`
- Create: `packages/shared/src/constants/project-storage.test.ts`
- Modify: `packages/shared/src/index.ts`

- [x] **Step 1: 写失败测试，锁定命名空间和归属范围**

```ts
import { describe, expect, test } from 'bun:test'
import {
  PROJECT_STORAGE_DIRECTORY_NAME,
  LEGACY_PROJECT_STORAGE_DIRECTORY_NAME,
  PROJECT_STORAGE_OWNED_DIRECTORIES,
  PROJECT_STORAGE_MARKER_FILE_NAME,
} from './project-storage'

describe('DutyDeck 项目存储契约', () => {
  test('Given 新项目存储契约 When 读取常量 Then 使用 .dutydeck 并只迁移已知目录', () => {
    expect(PROJECT_STORAGE_DIRECTORY_NAME).toBe('.dutydeck')
    expect(LEGACY_PROJECT_STORAGE_DIRECTORY_NAME).toBe('.proma')
    expect(PROJECT_STORAGE_OWNED_DIRECTORIES).toEqual([
      'design',
      'knowledge',
      'interaction-design',
      'visual-production',
    ])
    expect(PROJECT_STORAGE_MARKER_FILE_NAME).toBe('project-storage.json')
  })
})
```

- [x] **Step 2: 运行测试确认失败**

Run:

```bash
bun test packages/shared/src/constants/project-storage.test.ts
```

Expected: FAIL，因为 `project-storage.ts` 尚不存在。

- [x] **Step 3: 实现共享常量**

```ts
/** DutyDeck 当前项目级数据目录。 */
export const PROJECT_STORAGE_DIRECTORY_NAME = '.dutydeck' as const

/** 旧版 Proma/DutyDeck 项目级数据目录，只用于兼容读取和显式迁移。 */
export const LEGACY_PROJECT_STORAGE_DIRECTORY_NAME = '.proma' as const

/** 项目存储迁移标记；位于当前项目存储根内。 */
export const PROJECT_STORAGE_MARKER_FILE_NAME = 'project-storage.json' as const

/** DutyDeck 拥有并可迁移的项目子目录；未知旧目录不得自动移动。 */
export const PROJECT_STORAGE_OWNED_DIRECTORIES = [
  'design',
  'knowledge',
  'interaction-design',
  'visual-production',
] as const

/** DutyDeck 项目存储子目录名称。 */
export type ProjectStorageOwnedDirectory = typeof PROJECT_STORAGE_OWNED_DIRECTORIES[number]

/** 单个项目存储子目录的迁移状态。 */
export type ProjectStorageDirectoryMigrationState = 'missing' | 'legacy' | 'current' | 'conflict'

/** 单个项目存储子目录的公开状态。 */
export interface ProjectStorageDirectoryMigrationStatus {
  directory: ProjectStorageOwnedDirectory
  state: ProjectStorageDirectoryMigrationState
}

/** 工作区项目存储命名空间的汇总状态。 */
export interface ProjectStorageMigrationStatus {
  state: 'none' | 'legacy' | 'current' | 'mixed' | 'conflict'
  directories: ProjectStorageDirectoryMigrationStatus[]
  retainedLegacyEntries: string[]
}
```

在 `packages/shared/src/index.ts` 增加：

```ts
export * from './constants/project-storage'
```

- [x] **Step 4: 运行测试确认通过**

Run:

```bash
bun test packages/shared/src/constants/project-storage.test.ts
```

Expected: PASS，4 个断言通过。

- [x] **Step 5: 提交共享契约**

```bash
git add packages/shared/src/constants/project-storage.ts packages/shared/src/constants/project-storage.test.ts packages/shared/src/index.ts
git commit -m "新增项目存储命名空间契约"
```

## Task 2：实现新旧目录解析器

**Files:**
- Create: `apps/electron/src/main/lib/project-storage/project-storage-paths.ts`
- Create: `apps/electron/src/main/lib/project-storage/project-storage-paths.test.ts`

- [x] **Step 1: 写失败测试，覆盖四种目录状态**

```ts
import { afterEach, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  inspectProjectStorageDirectory,
  resolveProjectStorageDirectory,
} from './project-storage-paths'

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function projectRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'dutydeck-project-storage-'))
  roots.push(root)
  return root
}

describe('项目存储目录解析', () => {
  test('Given 新旧目录都不存在 When 创建写入路径 Then 使用 .dutydeck', () => {
    const root = projectRoot()
    const path = resolveProjectStorageDirectory(root, 'design', true)
    expect(path).toBe(join(root, '.dutydeck', 'design'))
  })

  test('Given 只有旧目录 When 解析 Then 继续兼容旧路径且不双写', () => {
    const root = projectRoot()
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
    const root = projectRoot()
    mkdirSync(join(root, '.proma', 'design'), { recursive: true })
    mkdirSync(join(root, '.dutydeck', 'design'), { recursive: true })
    expect(() => resolveProjectStorageDirectory(root, 'design', true)).toThrow('PROJECT_STORAGE_DIRECTORY_CONFLICT')
  })

  test('Given 旧存储根是符号链接 When 解析 Then 拒绝越界', () => {
    const root = projectRoot()
    symlinkSync(tmpdir(), join(root, '.proma'))
    expect(() => resolveProjectStorageDirectory(root, 'design', true)).toThrow('PROJECT_STORAGE_UNSAFE')
  })
})
```

- [x] **Step 2: 运行测试确认失败**

Run:

```bash
bun test apps/electron/src/main/lib/project-storage/project-storage-paths.test.ts
```

Expected: FAIL，因为解析器尚不存在。

- [x] **Step 3: 实现只读状态解析和写入路径选择**

实现以下公开接口：

```ts
import { existsSync, lstatSync } from 'node:fs'
import { isAbsolute, join, resolve } from 'node:path'
import {
  LEGACY_PROJECT_STORAGE_DIRECTORY_NAME,
  PROJECT_STORAGE_DIRECTORY_NAME,
  type ProjectStorageDirectoryMigrationState,
  type ProjectStorageOwnedDirectory,
} from '@dutydeck/shared'
import { ensureDirectoryDurable } from '../safe-file'

export interface ProjectStorageDirectoryInspection {
  directory: ProjectStorageOwnedDirectory
  state: ProjectStorageDirectoryMigrationState
  sourcePath: string
  targetPath: string
}

export function inspectProjectStorageDirectory(
  projectRoot: string,
  directory: ProjectStorageOwnedDirectory,
): ProjectStorageDirectoryInspection {
  const root = validateProjectRoot(projectRoot)
  const sourceRoot = join(root, LEGACY_PROJECT_STORAGE_DIRECTORY_NAME)
  const targetRoot = join(root, PROJECT_STORAGE_DIRECTORY_NAME)
  const sourcePath = join(sourceRoot, directory)
  const targetPath = join(targetRoot, directory)
  /** 必须先检查命名空间根，避免子目录 lstat 跟随祖先符号链接。 */
  const sourceRootExists = inspectActualDirectory(sourceRoot)
  const targetRootExists = inspectActualDirectory(targetRoot)
  const legacyExists = sourceRootExists && inspectActualDirectory(sourcePath)
  const currentExists = targetRootExists && inspectActualDirectory(targetPath)
  return {
    directory,
    state: legacyExists && currentExists
      ? 'conflict'
      : legacyExists
        ? 'legacy'
        : currentExists
          ? 'current'
          : 'missing',
    sourcePath,
    targetPath,
  }
}

export function resolveProjectStorageDirectory(
  projectRoot: string,
  directory: ProjectStorageOwnedDirectory,
  create: boolean,
): string {
  const inspection = inspectProjectStorageDirectory(projectRoot, directory)
  if (inspection.state === 'conflict') {
    throw new Error(`PROJECT_STORAGE_DIRECTORY_CONFLICT: ${inspection.sourcePath} 与 ${inspection.targetPath} 同时存在`)
  }
  if (inspection.state === 'current') return inspection.targetPath
  if (inspection.state === 'legacy') return inspection.sourcePath
  if (create) {
    ensureDirectoryDurable(join(validateProjectRoot(projectRoot), PROJECT_STORAGE_DIRECTORY_NAME))
    ensureDirectoryDurable(inspection.targetPath)
  }
  return inspection.targetPath
}
```

同时实现两个私有辅助函数：

```ts
function validateProjectRoot(projectRoot: string): string {
  if (!isAbsolute(projectRoot)) throw new Error('PROJECT_STORAGE_UNSAFE: 项目根必须是绝对路径')
  const root = resolve(projectRoot)
  const state = lstatSync(root)
  if (!state.isDirectory() || state.isSymbolicLink()) {
    throw new Error('PROJECT_STORAGE_UNSAFE: 项目根不是安全的实际目录')
  }
  return root
}

function inspectActualDirectory(path: string): boolean {
  if (!existsSync(path)) return false
  const state = lstatSync(path)
  if (!state.isDirectory() || state.isSymbolicLink()) {
    throw new Error(`PROJECT_STORAGE_UNSAFE: ${path} 不是安全的实际目录`)
  }
  return true
}
```

所有新增函数和接口必须保留中文注释，说明用途、入参和返回值。

- [x] **Step 4: 运行解析器测试**

Run:

```bash
bun test apps/electron/src/main/lib/project-storage/project-storage-paths.test.ts
```

Expected: PASS，新项目选择 `.dutydeck`，旧项目继续读取 `.proma`，冲突和链接均 fail closed。

- [x] **Step 5: 提交解析器**

```bash
git add apps/electron/src/main/lib/project-storage/project-storage-paths.ts apps/electron/src/main/lib/project-storage/project-storage-paths.test.ts
git commit -m "新增项目存储新旧路径解析"
```

## Task 3：实现可恢复的项目存储迁移

**Files:**
- Create: `apps/electron/src/main/lib/project-storage/project-storage-migration.ts`
- Create: `apps/electron/src/main/lib/project-storage/project-storage-migration.test.ts`

- [x] **Step 1: 写失败测试，覆盖数据安全边界**

至少加入以下用例：

```ts
test('Given 旧项目 When 迁移 Then 四个已知目录移动到 .dutydeck 且未知内容保留', () => {
  const root = projectRoot()
  mkdirSync(join(root, '.proma', 'design'), { recursive: true })
  mkdirSync(join(root, '.proma', 'knowledge'), { recursive: true })
  writeFileSync(join(root, '.proma', 'design', 'canvas.json'), '{"version":4}')
  writeFileSync(join(root, '.proma', 'user-note.txt'), 'keep')

  const result = migrateProjectStorageNamespace(root)

  expect(result.movedDirectories).toEqual(['design', 'knowledge'])
  expect(readFileSync(join(root, '.dutydeck', 'design', 'canvas.json'), 'utf8')).toBe('{"version":4}')
  expect(readFileSync(join(root, '.proma', 'user-note.txt'), 'utf8')).toBe('keep')
})

test('Given 同一模块新旧目录同时存在 When 迁移 Then 不移动任何目录', () => {
  const root = projectRoot()
  mkdirSync(join(root, '.proma', 'design'), { recursive: true })
  mkdirSync(join(root, '.dutydeck', 'design'), { recursive: true })
  expect(() => migrateProjectStorageNamespace(root)).toThrow('PROJECT_STORAGE_DIRECTORY_CONFLICT')
  expect(existsSync(join(root, '.proma', 'design'))).toBe(true)
  expect(existsSync(join(root, '.dutydeck', 'design'))).toBe(true)
})

test('Given 上次只迁移了一部分 When 再次迁移 Then 从剩余目录继续且保持幂等', () => {
  const root = projectRoot()
  mkdirSync(join(root, '.dutydeck', 'design'), { recursive: true })
  mkdirSync(join(root, '.proma', 'knowledge'), { recursive: true })
  expect(migrateProjectStorageNamespace(root).movedDirectories).toEqual(['knowledge'])
  expect(migrateProjectStorageNamespace(root).movedDirectories).toEqual([])
})
```

- [x] **Step 2: 运行测试确认失败**

Run:

```bash
bun test apps/electron/src/main/lib/project-storage/project-storage-migration.test.ts
```

Expected: FAIL，因为迁移器尚不存在。

- [x] **Step 3: 实现迁移预览、原子移动和标记**

实现以下公开接口：

```ts
export interface ProjectStorageMigrationDirectory {
  directory: ProjectStorageOwnedDirectory
  action: 'move' | 'skip-current' | 'skip-missing' | 'conflict'
}

export interface ProjectStorageMigrationPreview {
  sourceRoot: string
  targetRoot: string
  directories: ProjectStorageMigrationDirectory[]
  retainedLegacyEntries: string[]
  blockers: string[]
}

export interface ProjectStorageNamespaceMigrationResult {
  sourceRoot: string
  targetRoot: string
  movedDirectories: ProjectStorageOwnedDirectory[]
  retainedLegacyEntries: string[]
}

export function inspectProjectStorageMigrationNamespace(
  projectRoot: string,
): ProjectStorageMigrationStatus

export function migrateProjectStorageNamespace(
  projectRoot: string,
): ProjectStorageNamespaceMigrationResult
```

实现规则：

1. `inspectProjectStorageMigrationNamespace(projectRoot)` 返回共享的 `ProjectStorageMigrationStatus`，只做 `lstat`/`readdir`，不得创建目录。
2. `previewProjectStorageMigration(projectRoot)` 复用同一状态计算，只做 `lstat`/`readdir`，不得创建目录。
3. 汇总状态固定为：无已知目录 `none`；只有旧目录 `legacy`；只有当前目录 `current`；不同模块分别处于新旧目录 `mixed`；同一模块同时存在新旧目录 `conflict`。
4. 任一已知子目录同时存在时产生 `PROJECT_STORAGE_DIRECTORY_CONFLICT` blocker。
5. 任一存储根或已知子目录是符号链接、非目录时产生 `PROJECT_STORAGE_UNSAFE` blocker。
6. 执行前重新计算预览；发现 blocker 时在任何移动前失败。
7. 先持久创建 `<项目根>/.dutydeck`，再按固定顺序对 `legacy` 项调用 `renameSync(sourcePath, targetPath)`。
8. 每次 `renameSync` 前再次确认源存在、目标不存在且双方均为实际目录。
9. 全部移动后，用 `writeJsonFileAtomic` 写入：

```ts
interface ProjectStorageMarker {
  version: 1
  migratedAt: number
  movedDirectories: ProjectStorageOwnedDirectory[]
  retainedLegacyEntries: string[]
}
```

10. 任何单项失败都立即停止；已完成项保留，下一次运行根据目录存在性继续。
11. 不删除 `.proma` 根目录，也不触碰未知内容。

- [x] **Step 4: 运行迁移测试**

Run:

```bash
bun test apps/electron/src/main/lib/project-storage/project-storage-migration.test.ts
```

Expected: PASS，包含成功、冲突、部分恢复、幂等和未知内容保留。

- [x] **Step 5: 提交迁移引擎**

```bash
git add apps/electron/src/main/lib/project-storage/project-storage-migration.ts apps/electron/src/main/lib/project-storage/project-storage-migration.test.ts
git commit -m "实现项目存储可恢复迁移"
```

## Task 4：迁移 Design 数据路径

**Files:**
- Modify: `apps/electron/src/main/lib/design/design-paths.ts`
- Modify: `apps/electron/src/main/lib/design/design-context-catalog.ts`
- Modify: `apps/electron/src/main/lib/design/design-project-text-index.ts`
- Modify: `apps/electron/src/main/lib/design/design-store.test.ts`
- Modify: `apps/electron/src/main/lib/design/design-paths.test.ts`
- Modify: `apps/electron/src/main/lib/design/canvas-session-store.test.ts`
- Modify: `apps/electron/src/main/lib/design/design-context-catalog.test.ts`
- Modify: `apps/electron/src/main/lib/design/design-project-text-index.test.ts`

- [x] **Step 1: 先改测试为新的当前路径并保留一套旧项目兼容测试**

将“当前项目新建/读写”断言改为：

```ts
const designRoot = join(projectRoot, '.dutydeck', 'design')
expect(existsSync(join(projectRoot, '.proma'))).toBe(false)
```

保留一条独立测试：

```ts
test('Given 只有旧 .proma/design When 首次解析 Then 继续使用旧目录等待显式迁移', () => {
  mkdirSync(join(projectRoot, '.proma', 'design'), { recursive: true })
  const paths = createDesignPathResolver(dependencies).resolve('project-1')
  expect(paths.designRoot).toBe(join(projectRoot, '.proma', 'design'))
})
```

- [x] **Step 2: 运行 Design 测试确认失败**

Run:

```bash
bun test apps/electron/src/main/lib/design/design-paths.test.ts apps/electron/src/main/lib/design/design-store.test.ts apps/electron/src/main/lib/design/design-context-catalog.test.ts apps/electron/src/main/lib/design/design-project-text-index.test.ts
```

Expected: FAIL，当前仍生成 `.proma/design`。

- [x] **Step 3: 接入项目存储解析器**

在 `design-paths.ts` 中把硬编码替换为：

```ts
const designRoot = resolveProjectStorageDirectory(projectRoot, 'design', true)
const storageRoot = dirname(designRoot)
```

为 `DesignPaths` 增加：

```ts
/** 项目存储根，供子目录边界校验复用。 */
storageRoot: string
```

在 `design-context-catalog.ts` 的两处 `.proma` 构造改为 `paths.storageRoot`。在 `design-project-text-index.ts` 的排除集合同时保留旧目录并新增当前目录：

```ts
'.proma',
'.dutydeck',
```

- [x] **Step 4: 运行 Design 回归**

Run:

```bash
bun test apps/electron/src/main/lib/design/design-paths.test.ts apps/electron/src/main/lib/design/design-store.test.ts apps/electron/src/main/lib/design/design-context-catalog.test.ts apps/electron/src/main/lib/design/design-project-text-index.test.ts
```

Expected: PASS；新项目写 `.dutydeck`，旧项目仍读 `.proma`，扫描器排除两者。

- [x] **Step 5: 提交 Design 迁移**

```bash
git add apps/electron/src/main/lib/design/design-paths.ts apps/electron/src/main/lib/design/design-context-catalog.ts apps/electron/src/main/lib/design/design-project-text-index.ts apps/electron/src/main/lib/design/design-store.test.ts apps/electron/src/main/lib/design/design-paths.test.ts apps/electron/src/main/lib/design/canvas-session-store.test.ts apps/electron/src/main/lib/design/design-context-catalog.test.ts apps/electron/src/main/lib/design/design-project-text-index.test.ts
git commit -m "迁移 Design 项目数据目录"
```

## Task 5：迁移项目知识库路径

**Files:**
- Modify: `apps/electron/src/main/lib/project-knowledge/paths.ts`
- Modify: `apps/electron/src/main/lib/project-knowledge/scanner.ts`
- Modify: `apps/electron/src/main/lib/project-knowledge/vault.ts`
- Modify: `apps/electron/src/main/lib/project-knowledge/service.test.ts`
- Modify: `apps/electron/src/main/lib/project-knowledge/organizer.test.ts`

- [x] **Step 1: 写失败测试**

增加以下场景：

```ts
test('Given 新知识库 When 创建目录 Then 写入 .dutydeck/knowledge', () => {
  const project = createResolvedProject()
  ensureKnowledgeDirectories(project)
  expect(existsSync(getManifestPath(project))).toBe(false)
  expect(existsSync(join(project.projectRoot, '.dutydeck', 'knowledge'))).toBe(true)
  expect(existsSync(join(project.projectRoot, '.proma'))).toBe(false)
})

test('Given 只有旧知识库 When 读取 Then 使用 .proma/knowledge 等待迁移', () => {
  const project = createResolvedProject()
  mkdirSync(join(project.projectRoot, '.proma', 'knowledge'), { recursive: true })
  expect(getKnowledgeRoot(project)).toBe(join(project.projectRoot, '.proma', 'knowledge'))
})
```

- [x] **Step 2: 运行知识库测试确认失败**

Run:

```bash
bun test apps/electron/src/main/lib/project-knowledge
```

Expected: FAIL，新路径仍为 `.proma/knowledge`。

- [x] **Step 3: 通过中央解析器解析知识库根**

删除固定分段常量，改为：

```ts
/** 返回当前可用的项目知识目录，不创建目录。 */
export function getKnowledgeRoot(project: ResolvedKnowledgeProject): string {
  return resolveProjectStorageDirectory(project.projectRoot, 'knowledge', false)
}
```

目录创建函数改为对 `dirname(getKnowledgeRoot(project))` 和 `getKnowledgeRoot(project)` 逐层调用 `ensureDirectoryDurable`，继续拒绝符号链接。

在 `scanner.ts` 和 `vault.ts` 的内部目录拒绝列表同时加入 `.dutydeck`，保留 `.proma` 用于兼容旧库存和防越界。

- [x] **Step 4: 运行知识库回归**

Run:

```bash
bun test apps/electron/src/main/lib/project-knowledge
```

Expected: PASS；新知识库写 `.dutydeck/knowledge`，旧知识库继续可读。

- [x] **Step 5: 提交知识库迁移**

```bash
git add apps/electron/src/main/lib/project-knowledge/paths.ts apps/electron/src/main/lib/project-knowledge/scanner.ts apps/electron/src/main/lib/project-knowledge/vault.ts apps/electron/src/main/lib/project-knowledge/service.test.ts apps/electron/src/main/lib/project-knowledge/organizer.test.ts
git commit -m "迁移项目知识库目录"
```

## Task 6：迁移交互设计路径

**Files:**
- Modify: `apps/electron/src/main/lib/interaction-design/paths.ts`
- Modify: `apps/electron/src/main/lib/interaction-design/store.ts`
- Modify: `apps/electron/src/main/lib/interaction-design/asset-service.ts`
- Modify: `apps/electron/src/main/lib/interaction-design/access.test.ts`
- Modify: `apps/electron/src/main/lib/interaction-design/store.test.ts`

- [x] **Step 1: 把当前路径测试切到 `.dutydeck`，保留旧读取测试**

当前写入断言改为：

```ts
expect(existsSync(join(root, '.dutydeck', 'interaction-design', 'prototypes'))).toBe(true)
```

增加旧项目测试：

```ts
test('Given 只有旧交互设计目录 When 打开项目 Then 继续读取 .proma 且不创建空 .dutydeck', () => {
  mkdirSync(join(root, '.proma', 'interaction-design', 'prototypes'), { recursive: true })
  const service = createService(root)
  expect(service.list()).toEqual([])
  expect(existsSync(join(root, '.dutydeck'))).toBe(false)
})
```

- [x] **Step 2: 运行交互设计测试确认失败**

Run:

```bash
bun test apps/electron/src/main/lib/interaction-design/access.test.ts apps/electron/src/main/lib/interaction-design/store.test.ts
```

Expected: FAIL，因为当前目录仍为 `.proma`。

- [x] **Step 3: 在统一目录函数中解析命名空间**

将 `interactionDirectory()` 的第一段处理改为通过：

```ts
if (parts[0] === PROJECT_STORAGE_DIRECTORY_NAME || parts[0] === LEGACY_PROJECT_STORAGE_DIRECTORY_NAME) {
  const storageDirectory = parts[1]
  if (!storageDirectory || !PROJECT_STORAGE_OWNED_DIRECTORIES.includes(storageDirectory as ProjectStorageOwnedDirectory)) {
    throw new Error('项目存储子目录非法')
  }
  const storageRoot = resolveProjectStorageDirectory(root, storageDirectory as ProjectStorageOwnedDirectory, create)
  let current = storageRoot
  for (const part of parts.slice(2)) {
    if (!part) throw new Error('交互设计目录片段非法')
    assertInteractionId(part)
    current = join(current, part)
    assertOrCreateActualDirectory(current, create)
  }
  return current
}
```

将 `store.ts`、`asset-service.ts` 中所有 `[ '.proma', 'interaction-design', ... ]` 改为 `[ PROJECT_STORAGE_DIRECTORY_NAME, 'interaction-design', ... ]`。旧目录命中由中央解析器处理。

- [x] **Step 4: 运行交互设计回归**

Run:

```bash
bun test apps/electron/src/main/lib/interaction-design/access.test.ts apps/electron/src/main/lib/interaction-design/store.test.ts
```

Expected: PASS；新数据写 `.dutydeck`，旧数据仍可只读/继续使用，链接目录拒绝规则不降低。

- [x] **Step 5: 提交交互设计迁移**

```bash
git add apps/electron/src/main/lib/interaction-design/paths.ts apps/electron/src/main/lib/interaction-design/store.ts apps/electron/src/main/lib/interaction-design/asset-service.ts apps/electron/src/main/lib/interaction-design/access.test.ts apps/electron/src/main/lib/interaction-design/store.test.ts
git commit -m "迁移交互设计项目目录"
```

## Task 7：迁移影像制作与剪辑路径

**Files:**
- Modify: `packages/shared/src/types/visual-production-plugin.ts`
- Modify: `packages/shared/src/types/visual-production-plugin.test.ts`
- Modify: `apps/electron/src/main/lib/visual-production/store.ts`
- Modify: `apps/electron/src/main/lib/visual-production/context-evidence-store.ts`
- Modify: `apps/electron/src/main/lib/visual-production/editing-store.ts`
- Modify: `apps/electron/src/main/lib/visual-production/store.test.ts`
- Modify: `apps/electron/src/main/lib/visual-production/context-evidence-store.test.ts`
- Modify: `apps/electron/src/main/lib/visual-production/initial-shot-adoption.test.ts`

- [x] **Step 1: 先改共享常量和失败测试**

共享常量改为：

```ts
/** 新影像作品写入项目 .dutydeck；旧 .proma 由中央迁移服务兼容。 */
export const VISUAL_PRODUCTION_STORAGE_SEGMENTS = [PROJECT_STORAGE_DIRECTORY_NAME, 'visual-production'] as const
```

测试断言：

```ts
expect(VISUAL_PRODUCTION_STORAGE_NAMESPACE).toBe('.dutydeck/visual-production')
expect(existsSync(join(root, '.proma'))).toBe(false)
expect(existsSync(join(root, '.dutydeck', 'visual-production'))).toBe(true)
```

- [x] **Step 2: 运行影像测试确认失败**

Run:

```bash
bun test apps/electron/src/main/lib/visual-production
```

Expected: FAIL，当前命名空间仍是 `.proma/visual-production`。

- [x] **Step 3: 用共享常量替换散落路径**

所有生产代码只引用 `VISUAL_PRODUCTION_STORAGE_SEGMENTS`，不得再直接拼 `.proma` 或 `.dutydeck`。`interactionDirectory()` 已负责从旧命名空间解析或迁移。

当前写入测试改为 `.dutydeck/visual-production`；新增一条：

```ts
test('Given 只有旧影像目录 When 读取 Then 使用 .proma/visual-production 兼容', () => {
  mkdirSync(join(root, '.proma', 'visual-production', 'projects', 'p1'), { recursive: true })
  expect(resolveProjectStorageDirectory(root, 'visual-production', false)).toBe(join(root, '.proma', 'visual-production'))
})
```

- [x] **Step 4: 运行影像和剪辑回归**

Run:

```bash
bun test apps/electron/src/main/lib/visual-production
```

Expected: PASS；作品、候选、证据、剪辑和时间线在新旧目录中行为一致。

- [x] **Step 5: 提交影像迁移**

```bash
git add packages/shared/src/types/visual-production-plugin.ts packages/shared/src/types/visual-production-plugin.test.ts apps/electron/src/main/lib/visual-production
git commit -m "迁移影像制作项目存储目录"
```

## Task 8：接入路径设置页和四层 IPC

**Files:**
- Modify: `packages/shared/src/types/path-management.ts`
- Modify: `packages/shared/src/types/path-management.test.ts`
- Modify: `apps/electron/src/main/lib/workspace-operation-lock.ts`
- Modify: `apps/electron/src/main/lib/workspace-operation-lock.test.ts`
- Modify: `apps/electron/src/main/lib/path-management-ipc.ts`
- Modify: `apps/electron/src/main/lib/path-management-workspace-ipc.test.ts`
- Modify: `apps/electron/src/main/lib/workspace-project-relocator-production.ts`
- Modify: `apps/electron/src/main/ipc.ts`
- Modify: `apps/electron/src/preload/path-management-preload.ts`
- Modify: `apps/electron/src/preload/path-management-preload.test.ts`
- Modify: `apps/electron/src/renderer/components/settings/PathManagementSettings.tsx`
- Modify: `apps/electron/src/renderer/components/settings/PathManagementSettings.test.tsx`

- [x] **Step 1: 写共享状态和 IPC 失败测试**

新增共享类型：

```ts
/** 单个工作区执行项目存储迁移后的公开结果。 */
export interface ProjectStorageMigrationResult {
  workspaceId: string
  movedDirectories: ProjectStorageOwnedDirectory[]
  retainedLegacyEntries: string[]
}
```

在 `WorkspacePathState` 增加必填字段：

```ts
projectStorageMigration: ProjectStorageMigrationStatus
```

在 IPC 常量中增加：

```ts
MIGRATE_PROJECT_STORAGE: 'path-management:migrate-project-storage',
```

将 `WorkspaceOperationKind` 和 `workspace-operation-lock.ts` 的运行时白名单扩展为：

```ts
export type WorkspaceOperationKind = 'relocation' | 'deletion' | 'project-storage-migration'
```

`operationBlockReason()` 对 `project-storage-migration` 返回“项目数据目录正在迁移，请等待完成后重试”。测试必须断言该类型会阻断新的工作区写 lease，并保留 relocation/deletion 原有提示。

测试必须覆盖：

- `legacy` 工作区可以迁移。
- `current` 工作区按钮禁用。
- `conflict` 工作区阻断并显示具体目录。
- 不可用或运行中的项目不会执行迁移。

- [x] **Step 2: 运行 IPC 测试确认失败**

Run:

```bash
bun test packages/shared/src/types/path-management.test.ts apps/electron/src/main/lib/path-management-workspace-ipc.test.ts apps/electron/src/preload/path-management-preload.test.ts
```

Expected: FAIL，因为状态字段和通道尚不存在。

- [x] **Step 3: 完成主进程、preload 和 renderer 四层接线**

主进程在 `workspace-project-relocator-production.ts` 中：

```ts
export function inspectWorkspaceProjectStorageMigration(sourceRoot: string): ProjectStorageMigrationStatus {
  return inspectProjectStorageMigrationNamespace(sourceRoot)
}

export function migrateWorkspaceProjectStorage(workspaceId: string): ProjectStorageMigrationResult {
  const workspace = getAgentWorkspace(workspaceId)
  if (!workspace) throw new Error('项目不存在')
  if (hasActiveAgentDataWritesForWorkspace(workspaceId)) throw new Error('项目正在执行 Agent 写入，不能迁移项目存储')
  if (hasRunningAutomationForWorkspace(workspaceId)) throw new Error('项目有运行中的 Automation，不能迁移项目存储')
  const projectRoot = workspace.projectRootPath ?? getWorkspaceFilesDir(workspace.slug)
  const release = acquireWorkspaceOperation(workspaceId, 'project-storage-migration')
  try {
    const result = migrateProjectStorageNamespace(projectRoot)
    return {
      workspaceId,
      movedDirectories: [...result.movedDirectories],
      retainedLegacyEntries: [...result.retainedLegacyEntries],
    }
  } finally {
    release()
  }
}
```

`listWorkspacePathStates()` 为每个工作区填充 `projectStorageMigration`。`path-management-ipc.ts` 注册单次迁移 handler，并且在 handler 中再次读取最新 workspace 状态，禁止 renderer 直接传路径。

preload 只新增：

```ts
migrateProjectStorage: (workspaceId: string) => Promise<ProjectStorageMigrationResult>
```

renderer 在 `WorkspacePathList` 中显示：

- `legacy`：显示“迁移项目数据”，确认文案列出 `.proma/{design,knowledge,interaction-design,visual-production}` 到 `.dutydeck` 的移动、旧版客户端将不能读取迁移后数据、未知 `.proma` 内容会保留。
- `current`：显示“已迁移”，禁用按钮。
- `mixed`：显示已迁移模块数量和剩余旧模块，允许继续迁移。
- `conflict`：禁用执行，列出冲突子目录，并提供“打开项目位置”。

- [x] **Step 4: 运行路径管理和界面测试**

Run:

```bash
bun test packages/shared/src/types/path-management.test.ts apps/electron/src/main/lib/path-management-workspace-ipc.test.ts apps/electron/src/preload/path-management-preload.test.ts apps/electron/src/renderer/components/settings/PathManagementSettings.test.tsx
```

Expected: PASS；确认前不写入，运行中不迁移，成功后刷新状态，失败保留原目录。

- [x] **Step 5: 提交迁移入口**

```bash
git add packages/shared/src/types/path-management.ts packages/shared/src/types/path-management.test.ts apps/electron/src/main/lib/workspace-operation-lock.ts apps/electron/src/main/lib/workspace-operation-lock.test.ts apps/electron/src/main/lib/path-management-ipc.ts apps/electron/src/main/lib/path-management-workspace-ipc.test.ts apps/electron/src/main/lib/workspace-project-relocator-production.ts apps/electron/src/main/ipc.ts apps/electron/src/preload/path-management-preload.ts apps/electron/src/preload/path-management-preload.test.ts apps/electron/src/renderer/components/settings/PathManagementSettings.tsx apps/electron/src/renderer/components/settings/PathManagementSettings.test.tsx
git commit -m "新增项目存储迁移入口"
```

## Task 9：清理非兼容路径残留和补充文档

**Files:**
- Modify: stale `~/.proma` comments in `packages/shared/src/types/*.ts`
- Modify: stale comments in `apps/electron/src/main/lib/**`
- Modify: `docs/slack-bridge.md`
- Modify: `docs/linux.md`
- Modify: `docs/proactive-scheduler-monitor-design.md`
- Modify: `docs/extensions/canvas.md`
- Modify: `README.md`
- Modify: `README.en.md`
- Modify: `MEMORY.md`

- [x] **Step 1: 先加入残留分类测试**

在 `scripts/check-deproma-residue.test.ts` 增加项目路径断言：

```ts
test('Given 当前生产代码 When 检查项目存储命名空间 Then 只允许中央契约含 .proma', async () => {
  const offenders = await collectProjectStorageLiteralOffenders(ROOT)
  expect(offenders).toEqual([])
})
```

在 `scripts/check-deproma-residue.ts` 实现该函数：对
`apps/electron/src/main/lib/{design,project-knowledge,interaction-design,visual-production}`
递归扫描非测试 `.ts`/`.tsx` 文件，跳过本计划的
`apps/electron/src/main/lib/project-storage/`，任何包含 `.proma` 路径段的行都返回
`ResidueFinding`；同时把 `docs/slack-bridge.md`、`docs/linux.md`、
`docs/proactive-scheduler-monitor-design.md` 和 `docs/extensions/canvas.md` 中仍把当前数据位置写成
`.proma` 的具体片段加入 `FORBIDDEN_RESIDUES`。

允许列表只包含：

- `packages/shared/src/constants/project-storage.ts`
- `apps/electron/src/main/lib/project-storage/project-storage-paths.ts`
- `apps/electron/src/main/lib/project-storage/project-storage-migration.ts`
- 数据根兼容与旧格式迁移测试

- [x] **Step 2: 运行测试确认文档和注释仍触发规则**

Run:

```bash
bun test scripts/check-deproma-residue.test.ts
```

Expected: FAIL，并列出仍把当前用户配置描述为 `~/.proma/*` 的注释或文档。

- [x] **Step 3: 区分兼容说明与当前路径**

执行以下替换规则：

- 当前用户级配置说明：`~/.proma/foo.json` → `活动数据根/foo.json`，默认展示为 `~/.DutyDeck/foo.json`。
- 当前项目存储说明：`<项目根>/.proma/<模块>` → `<项目根>/.dutydeck/<模块>`。
- 迁移说明保留 `~/.proma` 与 `<项目根>/.proma`，并明确标注“旧版本兼容”。
- `PROMA_*`、`.proma-location.json`、`proma` CLI、历史 wire value 和临时崩溃恢复前缀不替换。
- `PathManagementSettings` 的跨设备恢复提示保留旧 `.proma`，因为用户确实可能导入旧 ZIP。

- [x] **Step 4: 运行文档、残留和类型检查**

Run:

```bash
bun test scripts/check-deproma-residue.test.ts
bun run check:deproma
bun run typecheck
```

Expected: 全部通过；无未解释的当前 `.proma` 路径。

- [x] **Step 5: 提交清理**

```bash
git add packages/shared/src/types apps/electron/src/main/lib docs README.md README.en.md scripts/check-deproma-residue.ts scripts/check-deproma-residue.test.ts MEMORY.md
git commit -m "清理旧 Proma 路径文案并补充迁移说明"
```

## Task 10：完整迁移验收

**Files:**
- Test: `apps/electron/src/main/lib/project-storage/*.test.ts`
- Test: `apps/electron/src/main/lib/design/*.test.ts`
- Test: `apps/electron/src/main/lib/project-knowledge/*.test.ts`
- Test: `apps/electron/src/main/lib/interaction-design/*.test.ts`
- Test: `apps/electron/src/main/lib/visual-production/*.test.ts`
- Test: `apps/electron/src/main/lib/path-management-workspace-ipc.test.ts`
- Test: `apps/electron/src/renderer/components/settings/PathManagementSettings.test.tsx`

- [x] **Step 1: 运行项目存储定向回归**

Run:

```bash
bun test apps/electron/src/main/lib/project-storage
bun test apps/electron/src/main/lib/design
bun test apps/electron/src/main/lib/project-knowledge
bun test apps/electron/src/main/lib/interaction-design
bun test apps/electron/src/main/lib/visual-production
```

Expected: 全部 PASS；失败必须回到对应模块任务修复，不能跳过链接、冲突或旧目录兼容断言。

- [x] **Step 2: 运行四层 IPC 和设置页回归**

Run:

```bash
bun test apps/electron/src/main/lib/path-management-workspace-ipc.test.ts apps/electron/src/preload/path-management-preload.test.ts apps/electron/src/renderer/components/settings/PathManagementSettings.test.tsx
```

Expected: PASS；preload 不暴露任意路径参数，renderer 只传 workspaceId，确认前无写入。

- [x] **Step 3: 运行全仓静态检查**

Run:

```bash
bun run typecheck
bun run check:deproma
bun run --cwd apps/electron check:data-root
git diff --check
```

Expected: 全部 PASS。若 `check:data-root` 仍报告项目级 `.proma`，只能修改审计器对中央项目存储解析器的识别，不能删除兼容目录。

- [x] **Step 4: 构建 Electron 产物**

Run:

```bash
bun run electron:build
```

Expected: main、preload、renderer、agent runtime 和资源构建成功。

- [x] **Step 5: 在隔离 Electron 数据中做真实迁移冒烟**

准备一个临时项目和临时数据根，创建：

```text
<project>/.proma/design/canvas.json
<project>/.proma/knowledge/manifest.json
<project>/.proma/interaction-design/prototypes/example/head.json
<project>/.proma/visual-production/projects/example/snapshot.json
<project>/.proma/user-note.txt
```

通过真实设置页执行迁移，验收：

1. 四个已知目录移动到 `.dutydeck`。
2. `user-note.txt` 仍位于 `.proma`。
3. 各业务页重新打开后内容一致。
4. 重复点击迁移不产生变化。
5. 制造同模块新旧目录冲突时，界面阻断且不移动任何文件。
6. 运行中的 Agent 或 Automation 会让迁移按钮阻断或报错。

Expected: 六项全部通过，截图和临时目录证据保存在任务报告中。

- [x] **Step 6: 提交最终验收记录**

```bash
git add docs/superpowers/plans/2026-10-26-project-storage-namespace-migration.md
git commit -m "记录项目存储迁移验收结果"
```

## 发布与回滚

- 本变更按项目存储格式变更处理，应使用下一 minor 版本，不使用仅修复补丁版本。
- 发布说明必须写明：新项目使用 `.dutydeck`；旧项目在用户确认前继续使用 `.proma`；迁移后旧版客户端不再读取新数据。
- 回滚代码不会自动把数据搬回 `.proma`。若迁移后必须回滚客户端，先退出所有客户端并从迁移前备份恢复整个项目，不在运行中手工合并或覆盖目录。
- 不自动删除 `.proma` 根目录；是否清理空目录留到后续独立版本，迁移前旧项目继续兼容读写。
- `PROMA_*`、`.proma-location.json`、`proma` CLI 和用户级 `~/.proma` 迁移兼容不在本计划中删除。

## 自检

- 规格覆盖：用户级数据根、项目已知子目录、未知内容、显式迁移、忙碌阻断、失败恢复、文档残留、四层 IPC、测试和发布回滚均有独立任务。
- 类型一致性：统一使用 `ProjectStorageOwnedDirectory`、`ProjectStorageMigrationStatus`、`ProjectStorageMigrationResult`，不使用 `any`。
- 数据安全：所有写入口先解析安全实际目录；冲突、链接、运行中写入均 fail closed；不覆盖未知 `.proma` 内容。
- 验证闭环：每个模块先红后绿，最终执行定向回归、全仓类型检查、数据根审计、Electron 构建和隔离真实迁移冒烟。

## 实际执行与验收记录（2026-10-26）

Task 1–10 已完成。开发分支为 `codex/project-storage-namespace-migration`；未发布版本、推送或移动真实项目数据。

### 相对草案的必要调整

- 旧项目在显式迁移前继续原地读写；迁移状态忽略未创建的模块，避免仅一个旧模块被误报混合状态。影像枚举、剪辑读写与媒体导出也经中央解析器，空读取不落盘。
- 迁移日志先于移动持久化，绑定项目、两个命名空间及模块目录的真实身份；Windows 64 位文件对象编号采用无损十进制字符串，兼容旧安全整数日志。每次移动前后验证身份并同步父目录，完成 marker 后删除日志；最后一个目录移动后中断仍提供恢复入口。进程退出的 claim 锁可安全恢复。
- 迁移完成会重启整个应用，因此准入检查覆盖全局 Agent、Automation、API、媒体/Design 在途任务与所有工作区异步写租约，同物理根别名共同加锁；知识观察器在整轮异步恢复/扫描中持有租约。忙碌时立即拒绝并允许稍后重试，不排队等待。
- 历史会话附件按权威会话项目及成功迁移 marker 只读投影，不改 JSONL、普通正文或任意工具参数。多次独立迁移累积仍有效的历史模块，不把原生新目录误记为迁移。
- 审计器用已有 TypeScript AST 检测旧项目运行时路径构造，不用整文件白名单；用户级旧根、locator、环境变量、CLI 与恢复临时前缀保留。
- 设置入口位于 `WorkspacePathList` 的独立行级组件，normal preload 仅接受 workspaceId；轻量恢复窗口不暴露迁移。单个不安全/离线项目不会拖垮其余项目列表。

### 验证证据

| 验证范围 | 结果 | 本机日志 |
| --- | --- | --- |
| Design 全目录 | 2067 通过、0 失败 | `/tmp/dutydeck-storage-design-final.log` |
| 交互设计与影像全目录 | 334 通过、0 失败 | `/tmp/dutydeck-storage-creative-final.log` |
| 项目知识全目录 | 102 通过、0 失败 | `/tmp/dutydeck-storage-knowledge-final.log` |
| 项目存储、IPC、preload、设置页、附件投影 | 144 通过、497 断言、0 失败 | `/tmp/dutydeck-storage-final-integration.log` |
| safe-file 与三类后台服务 | 213 通过、0 失败 | `/tmp/dutydeck-storage-final-background.log` |
| 知识观察器、文件统计边界与残留审计 | 17 通过、0 失败 | `/tmp/dutydeck-storage-final-audit-tests.log` |
| 真实会话三种读取入口的项目附件兼容 | 1 通过、14 断言 | `/tmp/dutydeck-storage-session-wiring.log` |
| 全仓 `bun run typecheck` | 通过 | `/tmp/dutydeck-storage-typecheck-verified.log` |
| `check:deproma`、`check:data-root`、`git diff --check` | 通过 | 终端验证输出 |
| 完整 `bun run electron:build` | 通过，Swift 缓存使用隔离临时目录 | `/tmp/dutydeck-storage-build-verified.log` |

会话管理全套为 92 通过、10 失败；独立导出迁移前提交 `8d14f56b` 的相同测试为 91 通过、10 失败，失败名称集合完全一致，新增的项目附件回归通过。既有失败涉及两项知识 admission fixture、删除回调的旧精确断言、两项旧 CLI 期待值和五项空 Pi artifact fixture；本次未扩大范围修复。当前与基线日志为 `/tmp/dutydeck-storage-session-final.log`、`/tmp/dutydeck-session-baseline-results.log`。

真实 Electron 冒烟使用生产四模块 store、真实设置行组件、preload、IPC、wrapper 和迁移引擎；应用生命周期替身只记录重启请求。覆盖确认/取消零写入、Agent/后台/另一项目写租约阻断、四模块迁移前后重读一致、未知内容与插件产物保留、状态刷新、已迁移按钮禁用及冲突零移动，Renderer 错误为 0。

可复跑命令：`bun scripts/project-storage-migration-smoke.ts`。最终证据目录：`/private/var/folders/p_/tktfn8z91gbckq8h5m_cs8vh0000gn/T/dutydeck-project-storage-smoke-TsDT9N/`，包含 `evidence.json` 与 6 张截图。所有夹具均在随机临时根，未迁移真实用户数据或重启现有客户端。

独立规格复核通过；质量审查发现的跨项目重启和重复迁移 marker 问题均先回归后修复，并已独立复验关闭。本任务没有新增依赖，未改版本或默认 Skill。

### 性能与剩余边界

- 迁移使用同卷目录改名，不复制大媒体；状态读取仅检查四类模块及有界 16 KiB 日志/标记，不递归扫描资产。忙碌检查读取进程内计数，历史附件每次读取只捕获一次别名快照。
- Node `rename` 没有跨平台原子 no-replace 保证；不合作的本地进程若在最后检查与系统调用之间恶意替换空目标，超出当前协议保护边界。迁移期间不应通过外部工具搬动目录。
- 当前机器验证 macOS；Windows 身份精度、日志恢复及已有 safe-file 目录 fsync 降级有回归覆盖，尚未执行 Windows 实机冒烟。
- `MEMORY.md` 已追加本次决策与验收位置，但保留未提交，以免混入此前已有的上游审计和搜索修复记录；无关搜索改动也未纳入迁移提交。Nowledge Mem 定向检索因本机服务连接拒绝不可用，未同步。
