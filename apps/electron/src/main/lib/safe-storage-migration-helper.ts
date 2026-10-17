import { app, safeStorage } from 'electron'
import { collectLegacySafeStorageSnapshot } from './safe-storage-migration'
import { LEGACY_SAFE_STORAGE_NAME } from './app-identity'

/** 主进程通过 stdout 识别 helper 的唯一结果行，避免被 Electron 诊断输出干扰。 */
export const SAFE_STORAGE_MIGRATION_RESULT_PREFIX = 'DUTYDECK_SAFE_STORAGE_MIGRATION_RESULT='

/** helper 进程读取旧身份密文所需的启动参数。 */
export const SAFE_STORAGE_MIGRATION_HELPER_ARG = '--dutydeck-safe-storage-migration-helper'

/** 运行在旧应用身份下的 Safe Storage 扫描器。 */
export async function runSafeStorageMigrationHelper(dataRoot: string): Promise<void> {
  try {
    // 必须在 helper 进程首次调用 safeStorage 前固定旧名称，否则会生成新身份密钥。
    app.setName(LEGACY_SAFE_STORAGE_NAME)
    await app.whenReady()
    if (!safeStorage.isEncryptionAvailable()) {
      process.stdout.write(`${SAFE_STORAGE_MIGRATION_RESULT_PREFIX}${JSON.stringify({ status: 'unavailable' })}\n`)
      return
    }
    const snapshot = collectLegacySafeStorageSnapshot(dataRoot, safeStorage)
    process.stdout.write(`${SAFE_STORAGE_MIGRATION_RESULT_PREFIX}${JSON.stringify({ status: 'completed', snapshot })}\n`)
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    process.stdout.write(`${SAFE_STORAGE_MIGRATION_RESULT_PREFIX}${JSON.stringify({ status: 'failed', reason })}\n`)
  } finally {
    app.quit()
  }
}
