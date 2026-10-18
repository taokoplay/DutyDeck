import { existsSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'

/** userData 目录选择结果；source 用于启动日志和回归测试定位兼容路径。 */
export interface UserDataPathResolution {
  /** Electron 最终使用的 userData 绝对路径。 */
  path: string
  /** 当前目录与旧目录的绝对路径，便于诊断。 */
  currentPath: string
  legacyPath: string
  /** 说明使用当前目录还是旧目录兼容启动。 */
  source: 'current' | 'legacy'
}

/** 判断 renderer 是否已经在目录中写入过 Chromium Local Storage 数据。 */
function hasRendererStorage(userDataPath: string): boolean {
  const levelDbPath = join(userDataPath, 'Local Storage', 'leveldb')
  try {
    const hasLevelDbTable = readdirSync(levelDbPath).some((entry) => {
      if (!entry.endsWith('.ldb')) return false
      try {
        const stat = statSync(join(levelDbPath, entry))
        return stat.isFile() && stat.size > 0
      } catch {
        return false
      }
    })
    if (hasLevelDbTable) return true

    // Chromium 的空 profile 也会生成 LOG/Preferences；只有明显非空的
    // Preferences 才能作为旧版用户偏好的辅助证据。
    const preferencesPath = join(userDataPath, 'Preferences')
    const preferences = statSync(preferencesPath, { throwIfNoEntry: false })
    return preferences?.isFile() === true && preferences.size > 1024
  } catch {
    return false
  }
}

/**
 * 选择 Electron userData 目录，优先保持已有用户偏好可读。
 * @param appDataPath Electron 平台级应用数据父目录。
 * @param currentDirectoryName DutyDeck 当前 userData 目录名。
 * @param legacyDirectoryName Proma 旧版 userData 目录名。
 * @returns 当前版本应传给 app.setPath('userData') 的路径及来源。
 */
export function resolveUserDataPath(
  appDataPath: string,
  currentDirectoryName: string,
  legacyDirectoryName: string,
): UserDataPathResolution {
  const currentPath = join(appDataPath, currentDirectoryName)
  const legacyPath = join(appDataPath, legacyDirectoryName)
  const currentExists = existsSync(currentPath)
  const legacyExists = existsSync(legacyPath)
  const legacyHasStorage = legacyExists && hasRendererStorage(legacyPath)
  const currentHasStorage = currentExists && hasRendererStorage(currentPath)

  // 旧目录存在且新目录尚未写入 renderer 偏好时直接复用旧目录，
  // 避免复制 Chromium LevelDB 导致锁、日志或数据库状态不一致。
  const useLegacy = legacyExists && (!currentExists || (!currentHasStorage && legacyHasStorage))
  return {
    path: useLegacy ? legacyPath : currentPath,
    currentPath,
    legacyPath,
    source: useLegacy ? 'legacy' : 'current',
  }
}
