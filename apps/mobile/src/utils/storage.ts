// ===== localStorage 统一 key 管理 =====

const PREFIX = 'dutydeck_mobile_'
const LEGACY_PREFIX = 'proma_mobile_'

export const STORAGE_KEYS = {
  token: PREFIX + 'token',
  host: PREFIX + 'host',
  port: PREFIX + 'port',
  activeConv: PREFIX + 'active_conv',
  view: PREFIX + 'view',
  workspaceId: PREFIX + 'workspace_id',
  deviceId: PREFIX + 'device_id',
  deviceCredential: PREFIX + 'device_credential',
} as const

export const LEGACY_STORAGE_KEYS = {
  token: LEGACY_PREFIX + 'token', host: LEGACY_PREFIX + 'host', port: LEGACY_PREFIX + 'port',
  activeConv: LEGACY_PREFIX + 'active_conv', view: LEGACY_PREFIX + 'view',
  workspaceId: LEGACY_PREFIX + 'workspace_id', deviceId: LEGACY_PREFIX + 'device_id',
  deviceCredential: LEGACY_PREFIX + 'device_credential',
} as const

export interface StorageLike { getItem(key: string): string | null; setItem(key: string, value: string): void; removeItem(key: string): void }
/** 获取浏览器默认的本地存储实现。 */
function browserStorage(): StorageLike { return localStorage }

export function readStorage<T>(key: string, fallback: T, storage: StorageLike = browserStorage()): T {
  try {
    const raw = storage.getItem(key)
    if (raw === null) return fallback
    try { return JSON.parse(raw) as T } catch { return raw as T }
  } catch {
    return fallback
  }
}

/** 按新 key 优先读取，并将旧 key 的原始值迁移到新 key。 */
export function readStorageWithLegacy<T>(storage: StorageLike, key: string, legacyKey: string, fallback: T): T {
  if (storage.getItem(key) !== null) return readStorage(key, fallback, storage)
  const raw = storage.getItem(legacyKey)
  if (raw === null) return fallback
  storage.setItem(key, raw)
  return readStorage(legacyKey, fallback, storage)
}

/** 写入序列化后的 DutyDeck key；支持注入存储以便测试。 */
export function writeStorage(key: string, value: unknown): void
export function writeStorage(storage: StorageLike, key: string, value: unknown): void
export function writeStorage(first: string | StorageLike, second: string | unknown, third?: unknown): void {
  const storage = typeof first === 'string' ? browserStorage() : first
  const key = typeof first === 'string' ? first : second as string
  const value = typeof first === 'string' ? second : third
  storage.setItem(key, typeof value === 'string' ? value : JSON.stringify(value))
}

/** 删除新 key 及对应旧 key，防止已退出的旧凭证继续生效。 */
export function removeStorage(key: string): void
export function removeStorage(storage: StorageLike, key: string): void
export function removeStorage(first: string | StorageLike, second?: string): void {
  const storage = typeof first === 'string' ? browserStorage() : first
  const key = typeof first === 'string' ? first : second!
  storage.removeItem(key)
  if (key.startsWith(PREFIX)) storage.removeItem(LEGACY_PREFIX + key.slice(PREFIX.length))
}
