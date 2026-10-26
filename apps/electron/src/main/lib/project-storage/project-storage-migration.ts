import { existsSync, lstatSync, readFileSync, readdirSync, renameSync } from 'node:fs'
import { dirname, join } from 'node:path'
import {
  PROJECT_STORAGE_MARKER_FILE_NAME,
  PROJECT_STORAGE_OWNED_DIRECTORIES,
  type ProjectStorageDirectoryMigrationState,
  type ProjectStorageMigrationStatus,
  type ProjectStorageOwnedDirectory,
} from '@dutydeck/shared'
import { ensureDirectoryDurable, removeFileAtomic, syncDirectoryDurability, writeJsonFileAtomicSecure } from '../safe-file'
import { inspectProjectStorageDirectory } from './project-storage-paths'
import { acquireMediaFileLock } from '../media/media-file-lock'

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

/** 固定日志与跨进程 claim 锁；退出 owner 的恢复复用不可变后继协议。 */
const JOURNAL_NAME = '.project-storage-migration.json'
const LOCK_NAME = '.project-storage-migration.lock'

/** dev/ino 绑定目录对象，避免将外部新建目标误认为此前迁移结果。 */
interface DirectoryIdentity {
  /** 所在设备的无损十进制表示。 */
  dev: string
  /** 文件系统对象编号的无损十进制表示，避免 Windows 64 位 ID 被 number 舍入。 */
  ino: string
}

/** 日志先于 rename 落盘，恢复时以对象身份而不是完成位判定结果。 */
interface MigrationJournal {
  /** 日志格式版本。 */
  version: 1
  /** 已授权项目根身份。 */
  project: DirectoryIdentity
  /** 旧命名空间身份。 */
  source: DirectoryIdentity
  /** 新命名空间身份。 */
  target: DirectoryIdentity
  /** 所有已计划移动的目录及最初身份。 */
  entries: Partial<Record<ProjectStorageOwnedDirectory, DirectoryIdentity>>
}

/** 读取实际目录身份；缺失、链接、非目录均拒绝。 */
function directoryIdentity(path: string): DirectoryIdentity {
  const state = lstatSync(path, { bigint: true })
  if (!state.isDirectory() || state.isSymbolicLink()) throw new Error('PROJECT_STORAGE_UNSAFE: 目录身份无效')
  return { dev: state.dev.toString(), ino: state.ino.toString() }
}

/** 比较持久化身份与当前文件系统对象。 */
function sameIdentity(left: DirectoryIdentity, right: DirectoryIdentity): boolean {
  return left.dev === right.dev && left.ino === right.ino
}

/** 解析日志身份；兼容旧版安全整数，但拒绝已经发生精度损失的 number。 */
function parseDirectoryIdentity(value: unknown): DirectoryIdentity {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('PROJECT_STORAGE_UNSAFE: 迁移日志身份无效')
  }
  const fields = value as Record<string, unknown>
  /** JSON 中使用规范十进制字符串；旧安全整数可无损升级。 */
  const normalize = (field: unknown): string => {
    if (typeof field === 'string' && /^(0|[1-9][0-9]{0,39})$/.test(field)) return field
    if (typeof field === 'number' && Number.isSafeInteger(field) && field >= 0) return String(field)
    throw new Error('PROJECT_STORAGE_UNSAFE: 迁移日志身份无效')
  }
  return { dev: normalize(fields.dev), ino: normalize(fields.ino) }
}

/** 严格读取旧迁移标记；不安全或损坏的标记必须在移动数据前拒绝。 */
function readMarker(path: string): ProjectStorageMarker | null {
  const state = lstatSync(path, { throwIfNoEntry: false })
  if (!state) return null
  if (!state.isFile() || state.isSymbolicLink() || state.size > 16_384) {
    throw new Error('PROJECT_STORAGE_UNSAFE: 迁移标记不安全')
  }
  let value: unknown
  try { value = JSON.parse(readFileSync(path, 'utf8')) } catch {
    throw new Error('PROJECT_STORAGE_UNSAFE: 迁移标记无效')
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('PROJECT_STORAGE_UNSAFE: 迁移标记无效')
  const marker = value as Record<string, unknown>
  if (marker.version !== 1 || typeof marker.migratedAt !== 'number' || !Number.isFinite(marker.migratedAt)
    || !Array.isArray(marker.movedDirectories)
    || marker.movedDirectories.length > PROJECT_STORAGE_OWNED_DIRECTORIES.length
    || new Set(marker.movedDirectories).size !== marker.movedDirectories.length
    || marker.movedDirectories.some((directory) => !PROJECT_STORAGE_OWNED_DIRECTORIES.includes(directory))
    || !Array.isArray(marker.retainedLegacyEntries) || marker.retainedLegacyEntries.some((entry) => typeof entry !== 'string')) {
    throw new Error('PROJECT_STORAGE_UNSAFE: 迁移标记无效')
  }
  return value as ProjectStorageMarker
}

/** 严格读取有界日志，未知结构不能降级为全新迁移。 */
function readJournal(path: string): MigrationJournal | null {
  const state = lstatSync(path, { throwIfNoEntry: false })
  if (!state) return null
  if (!state.isFile() || state.isSymbolicLink() || state.size > 16_384) {
    throw new Error('PROJECT_STORAGE_UNSAFE: 迁移日志不安全')
  }
  const value: unknown = JSON.parse(readFileSync(path, 'utf8'))
  if (!value || typeof value !== 'object') throw new Error('PROJECT_STORAGE_UNSAFE: 迁移日志无效')
  const record = value as Record<string, unknown>
  if (record.version !== 1 || !record.entries || typeof record.entries !== 'object'
    || Array.isArray(record.entries)
    || Object.keys(record.entries).some((name) => (
      !PROJECT_STORAGE_OWNED_DIRECTORIES.includes(name as ProjectStorageOwnedDirectory)
    ))) throw new Error('PROJECT_STORAGE_UNSAFE: 迁移日志无效')
  return {
    version: 1,
    project: parseDirectoryIdentity(record.project),
    source: parseDirectoryIdentity(record.source),
    target: parseDirectoryIdentity(record.target),
    entries: Object.fromEntries(Object.entries(record.entries).map(([name, identity]) => [name, parseDirectoryIdentity(identity)])),
  }
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
  const recoveryRequired = readJournal(join(dirname(inspections[0]!.targetPath), JOURNAL_NAME)) !== null
  const retainedLegacyEntries = existsSync(sourceRoot)
    ? readdirSync(sourceRoot)
        .filter((name) => !PROJECT_STORAGE_OWNED_DIRECTORIES.includes(name as ProjectStorageOwnedDirectory))
        .sort((left, right) => left.localeCompare(right))
    : []

  return {
    state: resolveAggregateState(states),
    directories: inspections.map((item) => ({ directory: item.directory, state: item.state })),
    retainedLegacyEntries,
    ...(recoveryRequired ? { recoveryRequired: true } : {}),
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
  let preview = previewProjectStorageMigration(projectRoot)
  if (preview.blockers.length > 0) {
    throw new Error(`${preview.blockers[0]}: 同一模块的新旧项目目录同时存在，请先人工处理`)
  }

  const moveDirectory = options.rename ?? renameSync
  const movedDirectories: ProjectStorageOwnedDirectory[] = []
  /** 无旧数据且无恢复日志时保持零写盘，包括不创建锁目录。 */
  const journalPath = join(preview.targetRoot, JOURNAL_NAME)
  if (!preview.directories.some((item) => item.action === 'move') && !readJournal(journalPath)) {
    return {
      sourceRoot: preview.sourceRoot,
      targetRoot: preview.targetRoot,
      retainedLegacyEntries: preview.retainedLegacyEntries,
      movedDirectories,
    }
  }
  const lockPath = join(projectRoot, LOCK_NAME)
  /** 映射共享锁错误为迁移稳定码；不修改或抢删其它进程的 claim。 */
  let releaseLock: () => void
  try { releaseLock = acquireMediaFileLock(lockPath) } catch (error) {
    throw new Error('PROJECT_STORAGE_MIGRATION_BUSY: 无法取得项目迁移锁', { cause: error })
  }
  try {
    preview = previewProjectStorageMigration(projectRoot)
    if (preview.blockers.length) throw new Error('PROJECT_STORAGE_DIRECTORY_CONFLICT: 迁移目录冲突')
    /** 历史标记在任何目录移动前严格校验，避免覆盖损坏证据。 */
    const markerPath = join(preview.targetRoot, PROJECT_STORAGE_MARKER_FILE_NAME)
    const previousMarker = readMarker(markerPath)
    ensureDirectoryDurable(preview.targetRoot)
    const journal: MigrationJournal = readJournal(journalPath) ?? {
      version: 1 as const,
      project: directoryIdentity(projectRoot),
      source: directoryIdentity(preview.sourceRoot),
      target: directoryIdentity(preview.targetRoot),
      entries: {},
    }
    /** 每次移动前后复验父目录；这不是对不合作进程的原子 no-replace 保证。 */
    const verifyRoots = (): void => {
      if (!sameIdentity(journal.project, directoryIdentity(projectRoot))
        || !sameIdentity(journal.source, directoryIdentity(preview.sourceRoot))
        || !sameIdentity(journal.target, directoryIdentity(preview.targetRoot))) {
        throw new Error('PROJECT_STORAGE_UNSAFE: 迁移父目录身份已变化')
      }
    }
    verifyRoots()
    /** 先探测持久化能力；Windows 明确不支持目录同步时沿用 safe-file 的可见降级。 */
    syncDirectoryDurability(preview.sourceRoot)
    syncDirectoryDurability(preview.targetRoot)
    for (const item of preview.directories) {
      const identity = journal.entries[item.directory]
      const inspection = inspectProjectStorageDirectory(projectRoot, item.directory)
      if (identity && (inspection.state === 'missing' || !sameIdentity(identity,
        directoryIdentity(inspection.state === 'legacy' ? inspection.sourcePath : inspection.targetPath)))) {
        throw new Error('PROJECT_STORAGE_UNSAFE: 迁移目录身份与日志不一致')
      }
      if (item.action === 'move' && !identity) journal.entries[item.directory] = directoryIdentity(inspection.sourcePath)
    }
    writeJsonFileAtomicSecure(journalPath, journal)
    for (const item of preview.directories) {
      if (item.action !== 'move') continue
      verifyRoots()
      const fresh = inspectProjectStorageDirectory(projectRoot, item.directory)
      if (fresh.state !== 'legacy') throw new Error('PROJECT_STORAGE_DIRECTORY_CONFLICT: 移动前目录状态已变化')
      if (!sameIdentity(journal.entries[item.directory]!, directoryIdentity(fresh.sourcePath))) {
        throw new Error('PROJECT_STORAGE_UNSAFE: 源目录身份已变化')
      }
      moveDirectory(fresh.sourcePath, fresh.targetPath)
      verifyRoots()
      if (!sameIdentity(journal.entries[item.directory]!, directoryIdentity(fresh.targetPath))
        || lstatSync(fresh.sourcePath, { throwIfNoEntry: false })) {
        throw new Error('PROJECT_STORAGE_UNSAFE: 移动后目录身份异常')
      }
      syncDirectoryDurability(preview.sourceRoot)
      syncDirectoryDurability(preview.targetRoot)
      movedDirectories.push(item.directory)
    }
    const finalStatus = inspectProjectStorageMigrationNamespace(projectRoot)
    const marker: ProjectStorageMarker = {
      version: 1,
      migratedAt: (options.now ?? Date.now)(),
      movedDirectories: PROJECT_STORAGE_OWNED_DIRECTORIES.filter((directory) => (
        Boolean(journal.entries[directory]) || (previousMarker?.movedDirectories.includes(directory)
          && finalStatus.directories.some((item) => item.directory === directory && item.state === 'current'))
      )),
      retainedLegacyEntries: finalStatus.retainedLegacyEntries,
    }
    verifyRoots()
    /** 恢复可能发生在 rename 已成功但同步前；发布 marker 前补齐两个父目录同步。 */
    syncDirectoryDurability(preview.sourceRoot)
    syncDirectoryDurability(preview.targetRoot)
    writeJsonFileAtomicSecure(markerPath, marker)
    /** 标记成功后结束恢复状态；删除失败保持可重试错误，已移动数据不回滚。 */
    verifyRoots()
    removeFileAtomic(journalPath)
  } finally {
    releaseLock()
  }
  return {
    sourceRoot: preview.sourceRoot,
    targetRoot: preview.targetRoot,
    movedDirectories,
    retainedLegacyEntries: inspectProjectStorageMigrationNamespace(projectRoot).retainedLegacyEntries,
  }
}

/** 把逐项目录状态折叠为稳定的工作区级状态。 */
function resolveAggregateState(
  states: ReadonlySet<ProjectStorageDirectoryMigrationState>,
): ProjectStorageMigrationStatus['state'] {
  if (states.has('conflict')) return 'conflict'
  if (states.has('current') && states.has('legacy')) return 'mixed'
  if (states.has('current')) return 'current'
  if (states.has('legacy')) return 'legacy'
  return 'none'
}
