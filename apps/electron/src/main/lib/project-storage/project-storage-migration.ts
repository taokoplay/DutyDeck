import { existsSync, readdirSync, renameSync } from 'node:fs'
import { dirname, join } from 'node:path'
import {
  PROJECT_STORAGE_MARKER_FILE_NAME,
  PROJECT_STORAGE_OWNED_DIRECTORIES,
  type ProjectStorageDirectoryMigrationState,
  type ProjectStorageMigrationStatus,
  type ProjectStorageOwnedDirectory,
} from '@dutydeck/shared'
import { ensureDirectoryDurable, writeJsonFileAtomic } from '../safe-file'
import { inspectProjectStorageDirectory } from './project-storage-paths'

/** 单个已知项目目录在迁移预览中的动作。 */
export interface ProjectStorageMigrationDirectory {
  /** DutyDeck 拥有的项目模块目录名。 */
  directory: ProjectStorageOwnedDirectory
  /** 本次迁移将执行的固定动作。 */
  action: 'move' | 'skip-current' | 'skip-missing' | 'conflict'
}

/** 只读的项目存储迁移预览。 */
export interface ProjectStorageMigrationPreview {
  /** 旧命名空间绝对路径，即使不存在也不创建。 */
  sourceRoot: string
  /** 新命名空间绝对路径，即使不存在也不创建。 */
  targetRoot: string
  /** 四个已知目录的逐项动作。 */
  directories: ProjectStorageMigrationDirectory[]
  /** 迁移后仍留在旧命名空间的未知条目名称。 */
  retainedLegacyEntries: string[]
  /** 阻止执行迁移的稳定错误码。 */
  blockers: string[]
}

/** 一次项目存储迁移的可持久化结果。 */
export interface ProjectStorageNamespaceMigrationResult {
  /** 旧命名空间绝对路径。 */
  sourceRoot: string
  /** 新命名空间绝对路径。 */
  targetRoot: string
  /** 本次实际移动的已知目录。 */
  movedDirectories: ProjectStorageOwnedDirectory[]
  /** 因不属于 DutyDeck 而保留在旧命名空间的条目名称。 */
  retainedLegacyEntries: string[]
}

/** 迁移执行所需的最小可变依赖，供测试替换时钟和文件移动。 */
export interface ProjectStorageMigrationOptions {
  /** 生成迁移标记时间。 */
  now?: () => number
  /** 同一项目卷内移动一个目录。 */
  rename?: (sourcePath: string, targetPath: string) => void
}

/** 写入 `.dutydeck/project-storage.json` 的稳定最小结构。 */
interface ProjectStorageMarker {
  version: 1
  migratedAt: number
  movedDirectories: ProjectStorageOwnedDirectory[]
  retainedLegacyEntries: string[]
}

/**
 * 以只读方式汇总项目存储命名空间状态。
 *
 * @param projectRoot 已完成工作区解析的绝对项目根。
 * @returns 四个已知目录状态、整体状态和未知旧条目。
 */
export function inspectProjectStorageMigrationNamespace(
  projectRoot: string,
): ProjectStorageMigrationStatus {
  const inspections = PROJECT_STORAGE_OWNED_DIRECTORIES.map((directory) => (
    inspectProjectStorageDirectory(projectRoot, directory)
  ))
  const states = new Set(inspections.map((item) => item.state))
  const sourceRoot = dirname(inspections[0]!.sourcePath)
  const retainedLegacyEntries = existsSync(sourceRoot)
    ? readdirSync(sourceRoot)
        .filter((name) => !PROJECT_STORAGE_OWNED_DIRECTORIES.includes(name as ProjectStorageOwnedDirectory))
        .sort((left, right) => left.localeCompare(right))
    : []

  return {
    state: resolveAggregateState(states),
    directories: inspections.map((item) => ({ directory: item.directory, state: item.state })),
    retainedLegacyEntries,
  }
}

/**
 * 无副作用生成项目存储迁移预览。
 *
 * @param projectRoot 已完成工作区解析的绝对项目根。
 * @returns 四个已知目录的计划动作和阻断项。
 */
export function previewProjectStorageMigration(
  projectRoot: string,
): ProjectStorageMigrationPreview {
  const status = inspectProjectStorageMigrationNamespace(projectRoot)
  const first = inspectProjectStorageDirectory(projectRoot, PROJECT_STORAGE_OWNED_DIRECTORIES[0])
  return {
    sourceRoot: dirname(first.sourcePath),
    targetRoot: dirname(first.targetPath),
    directories: status.directories.map((item) => ({
      directory: item.directory,
      action: item.state === 'legacy'
        ? 'move'
        : item.state === 'current'
          ? 'skip-current'
          : item.state === 'conflict'
            ? 'conflict'
            : 'skip-missing',
    })),
    retainedLegacyEntries: status.retainedLegacyEntries,
    blockers: status.state === 'conflict' ? ['PROJECT_STORAGE_DIRECTORY_CONFLICT'] : [],
  }
}

/**
 * 把 DutyDeck 拥有的项目子目录从旧命名空间迁移到当前命名空间。
 *
 * 每个子目录使用同一项目卷内的原子 rename；已完成的项再次调用时保持幂等。
 * 未知旧目录和文件不移动，旧命名空间根目录也不自动删除。
 *
 * @param projectRoot 已完成工作区解析的绝对项目根。
 * @param options 可注入的时钟和目录移动函数。
 * @returns 本次实际移动的目录及旧命名空间保留项。
 */
export function migrateProjectStorageNamespace(
  projectRoot: string,
  options: ProjectStorageMigrationOptions = {},
): ProjectStorageNamespaceMigrationResult {
  const preview = previewProjectStorageMigration(projectRoot)
  if (preview.blockers.length > 0) {
    throw new Error(`${preview.blockers[0]}: 同一模块的新旧项目目录同时存在，请先人工处理`)
  }

  const moveDirectory = options.rename ?? renameSync
  const movedDirectories: ProjectStorageOwnedDirectory[] = []
  /** 新目录只在存在待迁移项时创建，避免只读预览或纯旧项目被额外写盘。 */
  if (preview.directories.some((item) => item.action === 'move')) {
    ensureDirectoryDurable(preview.targetRoot)
  }

  for (const item of preview.directories) {
    if (item.action !== 'move') continue
    /** 逐项执行前重新读取，避免预览后目录状态被外部改变。 */
    const fresh = inspectProjectStorageDirectory(projectRoot, item.directory)
    if (fresh.state === 'conflict') {
      throw new Error(`PROJECT_STORAGE_DIRECTORY_CONFLICT: ${fresh.sourcePath} 与 ${fresh.targetPath} 同时存在`)
    }
    if (fresh.state !== 'legacy') continue
    moveDirectory(fresh.sourcePath, fresh.targetPath)
    movedDirectories.push(item.directory)
  }

  const finalStatus = inspectProjectStorageMigrationNamespace(projectRoot)
  if (movedDirectories.length > 0) {
    const first = inspectProjectStorageDirectory(projectRoot, PROJECT_STORAGE_OWNED_DIRECTORIES[0])
    /** 标记固定写在新命名空间根，不写入具体模块目录。 */
    const targetRoot = dirname(first.targetPath)
    const marker: ProjectStorageMarker = {
      version: 1,
      migratedAt: (options.now ?? Date.now)(),
      movedDirectories,
      retainedLegacyEntries: finalStatus.retainedLegacyEntries,
    }
    writeJsonFileAtomic(join(targetRoot, PROJECT_STORAGE_MARKER_FILE_NAME), marker)
  }

  const first = inspectProjectStorageDirectory(projectRoot, PROJECT_STORAGE_OWNED_DIRECTORIES[0])
  return {
    sourceRoot: dirname(first.sourcePath),
    targetRoot: dirname(first.targetPath),
    movedDirectories,
    retainedLegacyEntries: finalStatus.retainedLegacyEntries,
  }
}

/** 把逐项目录状态折叠为稳定的工作区级状态。 */
function resolveAggregateState(
  states: ReadonlySet<ProjectStorageDirectoryMigrationState>,
): ProjectStorageMigrationStatus['state'] {
  if (states.has('conflict')) return 'conflict'
  if (states.size === 1 && states.has('missing')) return 'none'
  if (states.size === 1 && states.has('current')) return 'current'
  if (states.size === 1 && states.has('legacy')) return 'legacy'
  return 'mixed'
}
