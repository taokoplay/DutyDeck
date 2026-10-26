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
  /** 项目内 DutyDeck 拥有的模块目录名。 */
  directory: ProjectStorageOwnedDirectory
  /** 该模块当前的数据位置状态。 */
  state: ProjectStorageDirectoryMigrationState
}

/** 工作区项目存储命名空间的汇总状态。 */
export interface ProjectStorageMigrationStatus {
  /** 项目存储整体处于无数据、旧路径、当前路径、混合或冲突状态。 */
  state: 'none' | 'legacy' | 'current' | 'mixed' | 'conflict'
  /** 四个已知模块目录的逐项状态。 */
  directories: ProjectStorageDirectoryMigrationStatus[]
  /** 迁移后仍保留在旧命名空间、但不属于 DutyDeck 的条目名称。 */
  retainedLegacyEntries: string[]
  /** 上次迁移中断，需要核对已移动目录并完成标记。 */
  recoveryRequired?: boolean
}
