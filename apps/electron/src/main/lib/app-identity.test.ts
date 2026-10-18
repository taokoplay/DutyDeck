import { describe, expect, test } from 'bun:test'
import {
  DUTYDECK_SAFE_STORAGE_NAME,
  LEGACY_SAFE_STORAGE_NAME,
  LEGACY_USER_DATA_DIRECTORY_NAME,
  resolveAppIdentity,
  resolveLegacyDevUserDataDirectoryName,
} from './app-identity'

test('DutyDeck 使用新 Safe Storage 身份并保留旧身份用于迁移', () => {
  expect(DUTYDECK_SAFE_STORAGE_NAME).toBe('@dutydeck/electron')
  expect(LEGACY_SAFE_STORAGE_NAME).toBe('@proma/electron')
})

test('旧版开发 helper 保留实例目录兼容性', () => {
  expect(resolveLegacyDevUserDataDirectoryName()).toBe('@proma/electron-dev')
  expect(resolveLegacyDevUserDataDirectoryName(' feature/1 ')).toBe('@proma/electron-dev-feature1')
})

describe('Electron 应用身份', () => {
  test('Given 打包环境 When 解析身份 Then 使用 DutyDeck 展示名与稳定 App ID', () => {
    expect(resolveAppIdentity(true)).toEqual({
      displayName: 'DutyDeck',
      appId: 'com.taokoplay.dutydeck.app',
      safeStorageName: '@dutydeck/electron',
      userDataDirectoryName: '@dutydeck/electron',
    })
  })

  test('Given 默认开发环境 When 解析身份 Then 使用独立开发身份', () => {
    expect(resolveAppIdentity(false)).toEqual({
      displayName: 'DutyDeck Dev',
      appId: 'com.taokoplay.dutydeck.dev',
      safeStorageName: '@dutydeck/electron',
      userDataDirectoryName: '@dutydeck/electron-dev',
    })
  })

  test('Given 多工作树实例 When 解析身份 Then 名称和 userData 都包含清理后的实例名', () => {
    expect(resolveAppIdentity(false, ' feature/1 ')).toEqual({
      displayName: 'DutyDeck Dev - feature1',
      appId: 'com.taokoplay.dutydeck.dev',
      safeStorageName: '@dutydeck/electron',
      userDataDirectoryName: '@dutydeck/electron-dev-feature1',
    })
  })

  test('Given 品牌改名 When 解析任何环境的身份 Then 加密身份与 App ID 使用 DutyDeck 命名空间', () => {
    /** 打包版与开发版的展示名、App ID 与加密服务名均使用 DutyDeck 命名空间。 */
    const packaged = resolveAppIdentity(true)
    const development = resolveAppIdentity(false)

    expect(packaged.safeStorageName).toBe('@dutydeck/electron')
    expect(development.safeStorageName).toBe('@dutydeck/electron')
    expect(packaged.appId).toBe('com.taokoplay.dutydeck.app')
    expect(development.appId).toBe('com.taokoplay.dutydeck.dev')
    expect(packaged.displayName).not.toContain('@proma')
    expect(development.displayName).not.toContain('@proma')
  })

  test('旧版正式 userData 目录固定为 Proma 兼容路径', () => {
    expect(LEGACY_USER_DATA_DIRECTORY_NAME).toBe('@proma/electron')
  })
})
