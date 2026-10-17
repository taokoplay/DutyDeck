import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { writeJsonFileAtomic } from './safe-file'

/** Safe Storage 只需要这两个同步能力，测试可以注入确定性的伪实现。 */
export interface SafeStorageMigrationBackend {
  isEncryptionAvailable(): boolean
  encryptString(value: string): Buffer
  decryptString(value: Buffer): string
}

/** 运行时修改 Electron 应用名，使 macOS Keychain 使用指定服务名。 */
export interface SafeStorageMigrationOptions {
  dataRoot: string
  currentName: string
  legacyName: string
  setAppName: (name: string) => void
  safeStorage: SafeStorageMigrationBackend
}

/** 迁移结果，供启动日志和回归测试判断实际处理量。 */
export interface SafeStorageMigrationResult {
  status: 'completed' | 'skipped' | 'failed'
  scannedFiles: number
  migratedValues: number
  reason?: string
}

interface EncryptedValue {
  kind: 'encrypted'
  plaintext: string
}

interface MigrationState {
  version: 1
  migratedAt: number
  migratedValues: number
}

const MIGRATION_STATE_FILE = '.dutydeck-safe-storage-migration.json'
const MAX_JSON_FILE_BYTES = 8 * 1024 * 1024

/** 扫描配置根下的 JSON 文件，跳过迁移标记和临时/备份文件。 */
function collectJsonFiles(root: string): string[] {
  const files: string[] = []
  const visit = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue
      const path = join(directory, entry.name)
      if (entry.isDirectory()) {
        visit(path)
      } else if (entry.isFile() && entry.name.endsWith('.json')) {
        files.push(path)
      }
    }
  }
  visit(root)
  return files
}

/** 仅尝试规范 Base64 字符串，避免把普通文本误提交给系统密钥库。 */
function decodeBase64(value: string): Buffer | null {
  if (value.length < 16 || value.length % 4 !== 0) return null
  try {
    const buffer = Buffer.from(value, 'base64')
    return buffer.toString('base64') === value ? buffer : null
  } catch {
    return null
  }
}

/** 在旧服务名下递归解密 JSON 值，并保留普通值原样。 */
function decryptTree(value: unknown, safeStorage: SafeStorageMigrationBackend): { value: unknown; count: number } {
  if (typeof value === 'string') {
    const encoded = decodeBase64(value)
    if (!encoded) return { value, count: 0 }
    try {
      const encrypted: EncryptedValue = { kind: 'encrypted', plaintext: safeStorage.decryptString(encoded) }
      return { value: encrypted, count: 1 }
    } catch {
      return { value, count: 0 }
    }
  }
  if (Array.isArray(value)) {
    let count = 0
    const next = value.map((item) => {
      const result = decryptTree(item, safeStorage)
      count += result.count
      return result.value
    })
    return { value: next, count }
  }
  if (value && typeof value === 'object') {
    let count = 0
    const next: Record<string, unknown> = {}
    for (const [key, item] of Object.entries(value)) {
      const result = decryptTree(item, safeStorage)
      count += result.count
      next[key] = result.value
    }
    return { value: next, count }
  }
  return { value, count: 0 }
}

/** 在新服务名下递归重新加密迁移标记值。 */
function encryptTree(value: unknown, safeStorage: SafeStorageMigrationBackend): unknown {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const candidate = value as Partial<EncryptedValue>
    if (candidate.kind === 'encrypted' && typeof candidate.plaintext === 'string') {
      return safeStorage.encryptString(candidate.plaintext).toString('base64')
    }
  }
  if (Array.isArray(value)) return value.map((item) => encryptTree(item, safeStorage))
  if (value && typeof value === 'object') {
    const next: Record<string, unknown> = {}
    for (const [key, item] of Object.entries(value)) next[key] = encryptTree(item, safeStorage)
    return next
  }
  return value
}

/**
 * 将旧 Proma Safe Storage 密文迁移到 DutyDeck 服务名。
 * 迁移只处理可解析 JSON 中能被旧密钥成功解密的字符串，普通配置和会话正文不会改写。
 */
export function migrateLegacySafeStorage(options: SafeStorageMigrationOptions): SafeStorageMigrationResult {
  const statePath = join(options.dataRoot, MIGRATION_STATE_FILE)
  try {
    const state = JSON.parse(readFileSync(statePath, 'utf8')) as Partial<MigrationState>
    if (state.version === 1) return { status: 'completed', scannedFiles: 0, migratedValues: state.migratedValues ?? 0 }
  } catch {
    // 首次启动或旧标记损坏时重新扫描；扫描成功后会原子覆盖标记。
  }
  if (!options.safeStorage.isEncryptionAvailable()) {
    return { status: 'skipped', scannedFiles: 0, migratedValues: 0, reason: '系统密钥库不可用' }
  }

  const files = collectJsonFiles(options.dataRoot)
  let migratedValues = 0
  let scannedFiles = 0
  try {
    options.setAppName(options.legacyName)
    for (const filePath of files) {
      if (filePath === statePath) continue
      const source = readFileSync(filePath, 'utf8')
      if (Buffer.byteLength(source, 'utf8') > MAX_JSON_FILE_BYTES) continue
      let parsed: unknown
      try { parsed = JSON.parse(source) } catch { continue }
      const decrypted = decryptTree(parsed, options.safeStorage)
      scannedFiles += 1
      if (decrypted.count === 0) continue
      options.setAppName(options.currentName)
      const encrypted = encryptTree(decrypted.value, options.safeStorage)
      writeJsonFileAtomic(filePath, encrypted as object)
      migratedValues += decrypted.count
      options.setAppName(options.legacyName)
    }
    options.setAppName(options.currentName)
    const state: MigrationState = { version: 1, migratedAt: Date.now(), migratedValues }
    writeJsonFileAtomic(statePath, state, true)
    return { status: 'completed', scannedFiles, migratedValues }
  } catch (error) {
    options.setAppName(options.currentName)
    return {
      status: 'failed',
      scannedFiles,
      migratedValues,
      reason: error instanceof Error ? error.message : String(error),
    }
  }
}
