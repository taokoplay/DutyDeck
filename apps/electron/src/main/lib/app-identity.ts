import { APP_NAME } from '@dutydeck/shared'

/** Electron 运行实例的系统身份。 */
export interface AppIdentity {
  /** Dock、任务栏和系统菜单显示名称。 */
  displayName: string
  /** 系统用于区分应用的稳定标识。 */
  appId: string
  /** Electron Safe Storage 使用的当前服务名。 */
  safeStorageName?: string
  /** 开发实例使用的 Electron userData 目录名。 */
  userDataDirectoryName?: string
}

/** 新版 DutyDeck 的系统应用标识。 */
export const DUTYDECK_APP_ID = 'com.taokoplay.dutydeck.app'

/** 新版 DutyDeck 的开发实例标识。 */
export const DUTYDECK_DEV_APP_ID = 'com.taokoplay.dutydeck.dev'

/** 新版 DutyDeck 的 Safe Storage 加密服务名。 */
export const DUTYDECK_SAFE_STORAGE_NAME = '@dutydeck/electron'

/** 旧版 Proma 的加密服务名，供迁移诊断和人工恢复使用。 */
export const LEGACY_SAFE_STORAGE_NAME = '@proma/electron'

/**
 * 解析正式版或开发版应用身份。
 * @param isPackaged 当前是否为正式打包环境。
 * @param rawInstance 可选的开发工作树实例名。
 * @returns 当前运行实例应使用的名称、App ID 和 userData 目录。
 */
export function resolveAppIdentity(isPackaged: boolean, rawInstance?: string): AppIdentity {
  // 新版使用 DutyDeck 独立身份；业务数据根仍由 DataRootLocator 读取旧 Proma locator，
  // 因此应用身份迁移不会删除旧配置目录。
  if (isPackaged) {
    return {
      displayName: APP_NAME,
      appId: DUTYDECK_APP_ID,
      safeStorageName: DUTYDECK_SAFE_STORAGE_NAME,
    }
  }
  /** 去除会污染进程名称或目录名的开发实例字符。 */
  const instance = rawInstance?.replace(/[^a-zA-Z0-9_-]/g, '') || undefined
  return {
    displayName: instance ? `${APP_NAME} Dev - ${instance}` : `${APP_NAME} Dev`,
    appId: DUTYDECK_DEV_APP_ID,
    safeStorageName: DUTYDECK_SAFE_STORAGE_NAME,
    userDataDirectoryName: instance ? `@dutydeck/electron-dev-${instance}` : '@dutydeck/electron-dev',
  }
}
