import { atomWithStorage, createJSONStorage } from 'jotai/utils'
import type { SyncStorage } from 'jotai/vanilla/utils/atomWithStorage'

/** 将 DutyDeck 新 key 映射到旧 Proma key，仅用于迁移读取。 */
export function legacyStorageKey(key: string): string {
  return key.replace(/^dutydeck([_-])/, 'proma$1')
}

/** 读取新 key；缺失时读取旧 key 并复制到新 key，解析失败安全返回 null。 */
export function readStorageValue<T>(storage: Storage, key: string, legacyKey: string, parse: (raw: string) => T | null): T | null {
  try {
    const current = storage.getItem(key)
    if (current !== null) return parse(current)
    const legacy = storage.getItem(legacyKey)
    if (legacy === null) return null
    const value = parse(legacy)
    if (value !== null) storage.setItem(key, legacy)
    return value
  } catch {
    return null
  }
}

/** 只向新 key 写入值，保留旧 key 以支持旧版本回退。 */
export function writeStorageValue(storage: Storage, key: string, value: string): void {
  try { storage.setItem(key, value) } catch { /* 存储不可用时忽略 */ }
}

/** 删除新旧 key，供需要清理状态的调用方显式使用。 */
export function removeStorageValue(storage: Storage, key: string, legacyKey: string): void {
  try { storage.removeItem(key); storage.removeItem(legacyKey) } catch { /* 存储不可用时忽略 */ }
}

const stringStorage = (): { getItem: (key: string) => string | null; setItem: (key: string, value: string) => void; removeItem: (key: string) => void } => ({
  getItem: (key) => {
    if (typeof localStorage === 'undefined') return null
    return readStorageValue(localStorage, key, legacyStorageKey(key), (raw) => raw) ?? null
  },
  setItem: (key, value) => {
    if (typeof localStorage !== 'undefined') writeStorageValue(localStorage, key, value)
  },
  removeItem: (key) => {
    if (typeof localStorage !== 'undefined') removeStorageValue(localStorage, key, legacyStorageKey(key))
  },
})

/** Jotai JSON storage 适配器：所有新写入走 DutyDeck key，读取兼容 Proma key。 */
export const dutyDeckStorage: SyncStorage<unknown> = createJSONStorage(stringStorage)

/** 使用兼容 storage 创建持久化 atom。 */
export function atomWithDutyDeckStorage<Value>(key: string, initialValue: Value, _legacyStorage?: unknown, options?: { getOnInit?: boolean }) {
  return atomWithStorage<Value>(key, initialValue, dutyDeckStorage as SyncStorage<Value>, options ?? (_legacyStorage as { getOnInit?: boolean } | undefined))
}
