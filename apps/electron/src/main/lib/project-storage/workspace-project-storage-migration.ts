import { realpathSync } from 'node:fs'
import type { ProjectStorageMigrationResult } from '@dutydeck/shared'
import { migrateProjectStorageNamespace } from './project-storage-migration'

/** 迁移仅从主进程工作区索引取得项目根，不接收任意路径授权。 */
export interface ProjectStorageWorkspace {
  /** 工作区唯一身份。 */
  id: string
  /** 主进程解析的实际项目根。 */
  projectRoot: string
}

/** 可测试的工作区迁移准入与存储端口。 */
export interface WorkspaceProjectStorageMigrationDependencies {
  /** 枚举权威工作区绑定，包含指向相同物理根的别名。 */
  listWorkspaces(): ProjectStorageWorkspace[]
  /** 检查仍可能继续写项目的 Agent 或 Automation。 */
  isActive(workspaceId: string): boolean
  /** 独占操作会等待调用方重试，不取消现有异步写入。 */
  acquireOperation(workspaceId: string): () => void
  /** 可注入故障的同步迁移引擎，执行期间不让出事件循环。 */
  migrate?: typeof migrateProjectStorageNamespace
}

/**
 * 独占同一物理项目的全部工作区后执行命名空间迁移。
 * @param workspaceId 用户确认的工作区身份。
 * @param dependencies 主进程索引、活动状态和锁。
 * @returns 实际移动目录与保留内容。
 */
export function migrateWorkspaceProjectStorageWithDependencies(
  workspaceId: string,
  dependencies: WorkspaceProjectStorageMigrationDependencies,
): ProjectStorageMigrationResult {
  const workspaces = dependencies.listWorkspaces()
  const workspace = workspaces.find((item) => item.id === workspaceId)
  if (!workspace) throw new Error('项目不存在')
  const root = realpathSync(workspace.projectRoot)
  /** 同一 canonical root 的多个工作区必须共同准入；离线的无关项目不阻断。 */
  const aliases = workspaces.filter((item) => {
    try { return realpathSync(item.projectRoot) === root } catch { return false }
  })
  const assertIdle = (): void => {
    if (aliases.some((item) => dependencies.isActive(item.id))) {
      throw new Error('项目仍有 Agent 或 Automation 运行，请等待完成后迁移')
    }
  }
  const releases: Array<() => void> = []
  assertIdle()
  try {
    for (const alias of aliases) releases.push(dependencies.acquireOperation(alias.id))
    /** 锁后再次检查，且检查到 rename 全程同步，避免新任务插入。 */
    assertIdle()
    const result = (dependencies.migrate ?? migrateProjectStorageNamespace)(workspace.projectRoot)
    return { workspaceId, movedDirectories: result.movedDirectories, retainedLegacyEntries: result.retainedLegacyEntries }
  } finally {
    for (const release of releases.reverse()) release()
  }
}
