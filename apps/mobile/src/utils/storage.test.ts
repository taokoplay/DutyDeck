import { describe, expect, test } from 'bun:test'
import { readStorageWithLegacy, writeStorage, type StorageLike } from './storage'

function fakeStorage(initial: Record<string, string> = {}): StorageLike {
  const values = new Map(Object.entries(initial))
  return {
    getItem: key => values.get(key) ?? null,
    setItem: (key, value) => { values.set(key, value) },
    removeItem: key => { values.delete(key) },
  }
}

describe('移动端 localStorage 迁移', () => {
  test('新 key 存在时优先读取新 key', () => {
    const storage = fakeStorage({ dutydeck_mobile_host: 'new-host', proma_mobile_host: 'old-host' })
    expect(readStorageWithLegacy(storage, 'dutydeck_mobile_host', 'proma_mobile_host', '')).toBe('new-host')
  })

  test('只有旧 key 时读取旧值并写入新 key', () => {
    const storage = fakeStorage({ proma_mobile_host: 'old-host' })
    expect(readStorageWithLegacy(storage, 'dutydeck_mobile_host', 'proma_mobile_host', '')).toBe('old-host')
    expect(storage.getItem('dutydeck_mobile_host')).toBe('old-host')
  })

  test('新写入只写 DutyDeck key，不删除旧 key', () => {
    const storage = fakeStorage({ proma_mobile_token: 'old-token' })
    writeStorage(storage, 'dutydeck_mobile_token', 'new-token')
    expect(storage.getItem('proma_mobile_token')).toBe('old-token')
    expect(storage.getItem('dutydeck_mobile_token')).toBe('new-token')
  })
})
