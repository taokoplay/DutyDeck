import { describe, expect, test } from 'bun:test'
import { readStorageValue, removeStorageValue, writeStorageValue } from './legacy-storage'

/** 创建一个可控的 Storage 夹具，测试迁移边界而不依赖浏览器环境。 */
function createStorage(initial: Record<string, string> = {}): Storage {
  const values = new Map(Object.entries(initial))
  return {
    get length() { return values.size },
    clear: () => values.clear(),
    getItem: (key) => values.get(key) ?? null,
    key: (index) => Array.from(values.keys())[index] ?? null,
    removeItem: (key) => { values.delete(key) },
    setItem: (key, value) => { values.set(key, value) },
  }
}

describe('DutyDeck renderer localStorage 迁移', () => {
  test('新 key 优先读取', () => {
    const storage = createStorage({ 'dutydeck-theme-mode': 'light', 'proma-theme-mode': 'dark' })
    expect(readStorageValue(storage, 'dutydeck-theme-mode', 'proma-theme-mode', (raw) => raw)).toBe('light')
  })

  test('只有旧 key 时读取并复制到新 key', () => {
    const storage = createStorage({ 'proma-theme-mode': 'dark' })
    expect(readStorageValue(storage, 'dutydeck-theme-mode', 'proma-theme-mode', (raw) => raw)).toBe('dark')
    expect(storage.getItem('dutydeck-theme-mode')).toBe('dark')
  })

  test('坏 JSON 或 Storage 异常安全返回 null', () => {
    const storage = createStorage({ bad: '{broken' })
    expect(readStorageValue(storage, 'dutydeck-bad', 'bad', (raw) => {
      try { return JSON.parse(raw) as unknown } catch { return null }
    })).toBeNull()
    const failing = createStorage()
    failing.getItem = () => { throw new Error('blocked') }
    expect(readStorageValue(failing, 'dutydeck-key', 'proma-key', (raw) => raw)).toBeNull()
  })

  test('写入只更新新 key，删除时清理新旧 key', () => {
    const storage = createStorage({ 'proma-input': 'old' })
    writeStorageValue(storage, 'dutydeck-input', 'new')
    expect(storage.getItem('proma-input')).toBe('old')
    expect(storage.getItem('dutydeck-input')).toBe('new')
    removeStorageValue(storage, 'dutydeck-input', 'proma-input')
    expect(storage.getItem('dutydeck-input')).toBeNull()
    expect(storage.getItem('proma-input')).toBeNull()
  })
})
