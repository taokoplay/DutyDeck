import { join } from 'node:path'

/** userData 目录选择结果；保留旧路径供诊断和后续显式迁移使用。 */
export interface UserDataPathResolution {
  /** Electron 最终使用的 userData 绝对路径。 */
  path: string
  /** 当前目录与旧目录的绝对路径，便于诊断。 */
  currentPath: string
  legacyPath: string
  /** 当前版本始终使用独立的 DutyDeck 目录。 */
  source: 'current'
}

/**
 * 解析 Electron userData 目录，并始终返回 DutyDeck 自己的目录。
 * @param appDataPath Electron 平台级应用数据父目录。
 * @param currentDirectoryName DutyDeck 当前 userData 目录名。
 * @param legacyDirectoryName Proma 旧版 userData 目录名。
 * @returns 当前版本应传给 app.setPath('userData') 的独立路径。
 */
export function resolveUserDataPath(
  appDataPath: string,
  currentDirectoryName: string,
  legacyDirectoryName: string,
): UserDataPathResolution {
  const currentPath = join(appDataPath, currentDirectoryName)
  const legacyPath = join(appDataPath, legacyDirectoryName)
  // 旧 Proma 目录只保留为迁移/诊断来源，绝不能作为运行目录：
  // Chromium 会在 userData 下创建 SingletonLock，复用它会让 Proma 与 DutyDeck
  // 互相误判为同一实例，并在安装/启动时出现无窗口或闪退。
  return {
    path: currentPath,
    currentPath,
    legacyPath,
    source: 'current',
  }
}
