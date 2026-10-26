import { lstatSync, readFileSync } from 'node:fs'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'
import { PROJECT_STORAGE_DIRECTORY_NAME, PROJECT_STORAGE_MARKER_FILE_NAME, PROJECT_STORAGE_OWNED_DIRECTORIES } from '@dutydeck/shared'
import { inspectProjectStorageDirectory } from './project-storage-paths'

/** 一次历史读取捕获的旧模块根与当前根，不持有附件正文。 */
interface ProjectStoragePathAlias {
  /** 已迁移的精确旧模块根。 */
  source: string
  /** 仍需由读取方重新验证权限的当前模块根。 */
  target: string
}

/**
 * 为已迁移项目的历史附件创建只读路径投影，永不改写 JSONL 或任意正文。
 * @param projectRoot 当前会话已授权项目根；缺失时只执行原数据根解析。
 * @param resolveDataPath 原有用户数据根解析器，继续负责 locator 兼容。
 * @returns 捕获一次迁移标记的纯路径函数；此函数不授予文件读取权限。
 */
export function createProjectStorageAttachmentResolver(
  projectRoot: string | undefined,
  resolveDataPath: (path: string) => string,
): (path: string) => string {
  const aliases: ProjectStoragePathAlias[] = []
  if (projectRoot) {
    try {
      /** 先验证两个命名空间，不能透过符号链接读取伪造迁移标记。 */
      const inspections = PROJECT_STORAGE_OWNED_DIRECTORIES.map((directory) => inspectProjectStorageDirectory(projectRoot, directory))
      const markerPath = join(projectRoot, PROJECT_STORAGE_DIRECTORY_NAME, PROJECT_STORAGE_MARKER_FILE_NAME)
      const state = lstatSync(markerPath, { throwIfNoEntry: false })
      if (state?.isFile() && !state.isSymbolicLink() && state.size <= 16_384) {
        const marker: unknown = JSON.parse(readFileSync(markerPath, 'utf8'))
        if (marker && typeof marker === 'object' && 'version' in marker && marker.version === 1
          && 'movedDirectories' in marker && Array.isArray(marker.movedDirectories)) {
          for (const inspection of inspections) {
            if (inspection.state === 'current' && marker.movedDirectories.includes(inspection.directory)) {
              aliases.push({ source: inspection.sourcePath, target: inspection.targetPath })
            }
          }
        }
      }
    } catch {
      // 项目离线或标记不可信时保留原引用；实际文件读取沿用严格权限与错误处理。
    }
  }
  return (path) => {
    const current = resolveDataPath(path)
    if (!isAbsolute(current)) return current
    for (const alias of aliases) {
      const suffix = relative(alias.source, resolve(current))
      if (suffix && suffix !== '..' && !suffix.startsWith(`..${sep}`) && !isAbsolute(suffix)) return join(alias.target, suffix)
    }
    return current
  }
}
