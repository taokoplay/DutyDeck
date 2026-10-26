import { existsSync, lstatSync } from 'node:fs'
import { isAbsolute, join, resolve } from 'node:path'
import {
  LEGACY_PROJECT_STORAGE_DIRECTORY_NAME,
  PROJECT_STORAGE_DIRECTORY_NAME,
  type ProjectStorageDirectoryMigrationState,
  type ProjectStorageOwnedDirectory,
} from '@dutydeck/shared'
import { ensureDirectoryDurable } from '../safe-file'

/** 单个项目存储子目录的真实位置与迁移状态。 */
export interface ProjectStorageDirectoryInspection {
  /** 项目内 DutyDeck 拥有的模块目录名。 */
  directory: ProjectStorageOwnedDirectory
  /** 该模块当前所处的新旧目录状态。 */
  state: ProjectStorageDirectoryMigrationState
  /** 旧命名空间中的精确目录，仅用于兼容读取和迁移。 */
  sourcePath: string
  /** 新命名空间中的精确目录。 */
  targetPath: string
}

/**
 * 无副作用检查一个项目存储子目录的新旧位置。
 *
 * @param projectRoot 已完成工作区解析的绝对项目根。
 * @param directory DutyDeck 拥有的项目存储子目录。
 * @returns 新旧路径及缺失、旧路径、当前路径或冲突状态。
 */
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

/**
 * 解析模块应使用的项目存储目录。
 *
 * 旧项目在显式迁移前继续返回旧目录，避免应用升级后静默双写；新项目直接返回并创建
 * `.dutydeck`。同一模块新旧目录同时存在时 fail closed，防止错误选择覆盖数据。
 *
 * @param projectRoot 已完成工作区解析的绝对项目根。
 * @param directory DutyDeck 拥有的项目存储子目录。
 * @param create 是否允许为全新项目创建当前目录。
 * @returns 当前可安全使用的项目存储绝对路径。
 */
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
  const root = validateProjectRoot(projectRoot)
  if (create && existsSync(root)) {
    ensureDirectoryDurable(join(root, PROJECT_STORAGE_DIRECTORY_NAME))
    ensureDirectoryDurable(inspection.targetPath)
  }
  return inspection.targetPath
}

/** 校验项目根是绝对路径；缺失允许由后续写入方创建，已存在时必须是实际目录。 */
function validateProjectRoot(projectRoot: string): string {
  if (!isAbsolute(projectRoot)) throw new Error('PROJECT_STORAGE_UNSAFE: 项目根必须是绝对路径')
  const root = resolve(projectRoot)
  if (!existsSync(root)) return root
  const state = lstatSync(root)
  if (!state.isDirectory() || state.isSymbolicLink()) {
    throw new Error('PROJECT_STORAGE_UNSAFE: 项目根不是安全的实际目录')
  }
  return root
}

/** 检查路径是否为实际目录；缺失返回 false，链接或错误类型立即拒绝。 */
function inspectActualDirectory(path: string): boolean {
  if (!existsSync(path)) return false
  const state = lstatSync(path)
  if (!state.isDirectory() || state.isSymbolicLink()) {
    throw new Error(`PROJECT_STORAGE_UNSAFE: ${path} 不是安全的实际目录`)
  }
  return true
}
