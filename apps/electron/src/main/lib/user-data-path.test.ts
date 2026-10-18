import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, describe, expect, test } from 'bun:test'
import { resolveUserDataPath } from './user-data-path'

const temporaryRoots: string[] = []

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function createRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'dutydeck-user-data-'))
  temporaryRoots.push(root)
  return root
}

function writeLocalStorage(root: string, bytes = 'renderer preference'): void {
  const levelDb = join(root, 'Local Storage', 'leveldb')
  mkdirSync(levelDb, { recursive: true })
  writeFileSync(join(levelDb, '000001.ldb'), bytes)
}

describe('Electron userData 兼容路径', () => {
  test('新安装使用 DutyDeck 目录', () => {
    const root = createRoot()
    const result = resolveUserDataPath(root, '@dutydeck/electron', '@proma/electron')
    expect(result.source).toBe('current')
    expect(result.path).toBe(join(root, '@dutydeck/electron'))
  })

  test('只有旧目录时复用旧目录，保留旧版 renderer 偏好', () => {
    const root = createRoot()
    writeLocalStorage(join(root, '@proma/electron'))
    const result = resolveUserDataPath(root, '@dutydeck/electron', '@proma/electron')
    expect(result.source).toBe('legacy')
    expect(result.path).toBe(join(root, '@proma/electron'))
  })

  test('新目录为空而旧目录有偏好时仍复用旧目录', () => {
    const root = createRoot()
    mkdirSync(join(root, '@dutydeck/electron'), { recursive: true })
    writeLocalStorage(join(root, '@proma/electron'))
    const result = resolveUserDataPath(root, '@dutydeck/electron', '@proma/electron')
    expect(result.source).toBe('legacy')
  })

  test('两个目录都有 renderer 数据时保留当前 DutyDeck 目录', () => {
    const root = createRoot()
    writeLocalStorage(join(root, '@dutydeck/electron'), 'current preference')
    writeLocalStorage(join(root, '@proma/electron'), 'legacy preference')
    const result = resolveUserDataPath(root, '@dutydeck/electron', '@proma/electron')
    expect(result.source).toBe('current')
    expect(result.path).toBe(join(root, '@dutydeck/electron'))
  })
})
