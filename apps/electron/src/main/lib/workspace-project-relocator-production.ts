import type { ProjectStorageMigrationResult, WorkspacePathState } from '@dutydeck/shared'
import { inspectProjectStorageMigrationNamespace } from './project-storage/project-storage-migration'
import { migrateWorkspaceProjectStorageWithDependencies } from './project-storage/workspace-project-storage-migration'
import { getConfigDir, getWorkspaceFilesDir } from './config-paths'
import { hasActiveAgentDataWritesForWorkspace } from './agent-service'
import { hasRunningAutomationForWorkspace } from './automation-scheduler'
import { listWorktreesStrict } from './git-diff-service'
import { listAgentSessions, rebaseWorkspaceSessionPaths } from './agent-session-manager'
import {
  getAgentWorkspace,
  listAgentWorkspaces,
  rebaseWorkspaceConfigPaths,
  relinkAgentWorkspaceProjectRoot,
  updateAgentWorkspaceProjectRoot,
} from './agent-workspace-manager'
import { getLocalProjectRootStatusSync } from './project-root-health'
import { acquireWorkspaceOperation } from './workspace-operation-lock'
import { WorkspaceProjectRelocator } from './workspace-project-relocator'

/** production 进程唯一的项目迁移器，所有 IPC 与启动恢复共享同一控制器状态。 */
let defaultRelocator: WorkspaceProjectRelocator | null = null

/** 使用现有业务依赖构造 production 项目迁移器。 */
export function getDefaultWorkspaceProjectRelocator(): WorkspaceProjectRelocator {
  if (defaultRelocator === null) {
    defaultRelocator = new WorkspaceProjectRelocator({
      getConfigDir,
      getWorkspace: getAgentWorkspace,
      getManagedProjectRoot: getWorkspaceFilesDir,
      acquireWorkspaceOperation,
      hasActiveAgentDataWritesForWorkspace,
      hasRunningAutomationForWorkspace,
      listWorkspaceSessions: (workspaceId) => listAgentSessions().filter((session) => session.workspaceId === workspaceId),
      listWorktrees: listWorktreesStrict,
      rebaseWorkspaceSessionPaths,
      rebaseWorkspaceConfigPaths,
      updateAgentWorkspaceProjectRoot: (workspaceId, targetRoot) => {
        updateAgentWorkspaceProjectRoot(workspaceId, targetRoot)
      },
    })
  }
  return defaultRelocator
}

/** 为设置页枚举项目根、类型、即时可用性和可恢复迁移状态。 */
export function listWorkspacePathStates(): WorkspacePathState[] {
  const relocator = getDefaultWorkspaceProjectRelocator()
  return listAgentWorkspaces().map((workspace) => {
    /** 显式项目根为 external；缺省项目根位于 Proma 托管 workspace-files。 */
    const kind = workspace.projectRootPath === undefined ? 'managed' as const : 'external' as const
    const sourceRoot = workspace.projectRootPath ?? getWorkspaceFilesDir(workspace.slug)
    const rootStatus = getLocalProjectRootStatusSync(sourceRoot)
    /** 每个项目独立检查，损坏/符号链接不影响其他设置行；不扫描模块内容。 */
    let projectStorageMigration: WorkspacePathState['projectStorageMigration'] = null
    let projectStorageMigrationError: string | undefined
    if (rootStatus === 'available') {
      try { projectStorageMigration = inspectProjectStorageMigrationNamespace(sourceRoot) }
      catch { projectStorageMigrationError = '项目数据目录不安全或无法检查，请打开项目位置处理' }
    }
    return {
      workspaceId: workspace.id,
      name: workspace.name,
      sourceRoot,
      kind,
      availability: rootStatus === 'available'
        ? 'available'
        : rootStatus === 'missing'
          ? 'missing'
          : 'unavailable',
      relocation: relocator.getStatus(workspace.id),
      projectStorageMigration,
      ...(projectStorageMigrationError ? { projectStorageMigrationError } : {}),
    }
  })
}

/** 同一项目的全部工作区共享迁移准入，不会停止用户任务。 */
export function migrateWorkspaceProjectStorage(workspaceId: string): ProjectStorageMigrationResult {
  return migrateWorkspaceProjectStorageWithDependencies(workspaceId, {
    listWorkspaces: () => listAgentWorkspaces().map((workspace) => ({
      id: workspace.id,
      projectRoot: workspace.projectRootPath ?? getWorkspaceFilesDir(workspace.slug),
    })),
    isActive: (id) => hasActiveAgentDataWritesForWorkspace(id) || hasRunningAutomationForWorkspace(id),
    acquireOperation: (id) => acquireWorkspaceOperation(id, 'project-storage-migration'),
  })
}

/** 消费已授权目录后复用现有离线项目重定位能力。 */
export function relinkWorkspaceProjectRoot(workspaceId: string, targetRoot: string): void {
  relinkAgentWorkspaceProjectRoot(workspaceId, targetRoot)
}
