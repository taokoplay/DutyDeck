import { describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { migrateLegacySafeStorage, type LegacySafeStorageSnapshot } from './safe-storage-migration'

function createBackend(getPrefix: () => string): Parameters<typeof migrateLegacySafeStorage>[0]['safeStorage'] {
  return {
    backend: {
      isEncryptionAvailable: () => true,
      encryptString: (value: string) => Buffer.from(`${getPrefix()}:${value}`),
      decryptString: (value: Buffer) => {
        const text = value.toString()
        const prefix = 'legacy:'
        if (!text.startsWith(prefix)) throw new Error('wrong key')
        return text.slice(prefix.length)
      },
    },
  }.backend
}

describe('Safe Storage 身份迁移', () => {
  test('Given 旧密文配置 When 迁移 Then 原子改写为新密文并写入完成标记', () => {
    const root = mkdtempSync(join(tmpdir(), 'dutydeck-safe-storage-'))
    mkdirSync(join(root, 'nested'))
    writeFileSync(join(root, 'channels.json'), JSON.stringify({ apiKey: Buffer.from('legacy:key').toString('base64'), label: 'plain' }))
    writeFileSync(join(root, 'nested', 'other.json'), JSON.stringify({ secret: Buffer.from('legacy:token').toString('base64') }))
    let currentName = 'legacy'
    const backend = createBackend(() => currentName)
    const result = migrateLegacySafeStorage({
      dataRoot: root,
      currentName: 'new',
      legacyName: 'legacy',
      setAppName: (name) => { currentName = name },
      safeStorage: backend,
    })

    expect(result).toEqual({ status: 'completed', scannedFiles: 2, migratedValues: 2 })
    expect(JSON.parse(readFileSync(join(root, 'channels.json'), 'utf8')).apiKey)
      .toBe(Buffer.from('new:key').toString('base64'))
    expect(currentName).toBe('new')
  })

  test('Given 上次启动迁移数量为 0 When 旧密文仍存在 Then 本次启动重新迁移', () => {
    const root = mkdtempSync(join(tmpdir(), 'dutydeck-safe-storage-retry-'))
    writeFileSync(join(root, '.dutydeck-safe-storage-migration.json'), JSON.stringify({
      version: 1,
      migratedAt: 1,
      migratedValues: 0,
    }))
    writeFileSync(join(root, 'channels.json'), JSON.stringify({ apiKey: Buffer.from('legacy:key').toString('base64') }))
    let currentName = 'legacy'
    const result = migrateLegacySafeStorage({
      dataRoot: root,
      currentName: 'new',
      legacyName: 'legacy',
      setAppName: (name) => { currentName = name },
      safeStorage: createBackend(() => currentName),
    })

    expect(result).toMatchObject({ status: 'completed', migratedValues: 1 })
    expect(JSON.parse(readFileSync(join(root, 'channels.json'), 'utf8')).apiKey)
      .toBe(Buffer.from('new:key').toString('base64'))
  })

  test('Given 独立旧身份 helper 返回快照 When 迁移 Then 当前进程只负责新密钥重加密', () => {
    const root = mkdtempSync(join(tmpdir(), 'dutydeck-safe-storage-helper-'))
    const filePath = join(root, 'channels.json')
    writeFileSync(filePath, JSON.stringify({ apiKey: 'placeholder' }))
    const snapshot: LegacySafeStorageSnapshot = {
      scannedFiles: 1,
      candidateValues: 1,
      migratedValues: 1,
      files: [{
        path: filePath,
        value: { apiKey: { kind: 'encrypted', plaintext: 'legacy:key' } },
        migratedValues: 1,
      }],
    }
    const appNames: string[] = []
    const result = migrateLegacySafeStorage({
      dataRoot: root,
      currentName: 'new',
      legacyName: 'legacy',
      setAppName: (name) => { appNames.push(name) },
      safeStorage: createBackend(() => 'new'),
      readLegacySnapshot: () => snapshot,
    })

    expect(result).toMatchObject({ status: 'completed', scannedFiles: 1, migratedValues: 1 })
    expect(appNames).toEqual(['new'])
    expect(JSON.parse(readFileSync(filePath, 'utf8')).apiKey)
      .toBe(Buffer.from('new:legacy:key').toString('base64'))
  })

  test('Given helper 仍无法解密旧候选值 When 本次启动迁移 Then 不写完成标记以便下次重试', () => {
    const root = mkdtempSync(join(tmpdir(), 'dutydeck-safe-storage-pending-'))
    const markerPath = join(root, '.dutydeck-safe-storage-migration.json')
    writeFileSync(markerPath, JSON.stringify({ version: 1, migratedAt: 1, migratedValues: 0 }))
    const snapshot: LegacySafeStorageSnapshot = {
      scannedFiles: 1,
      candidateValues: 1,
      migratedValues: 0,
      files: [],
    }
    const result = migrateLegacySafeStorage({
      dataRoot: root,
      currentName: 'new',
      legacyName: 'legacy',
      setAppName: () => undefined,
      safeStorage: createBackend(() => 'new'),
      readLegacySnapshot: () => snapshot,
    })

    expect(result).toMatchObject({ status: 'skipped', migratedValues: 0 })
    expect(JSON.parse(readFileSync(markerPath, 'utf8')).migratedValues).toBe(0)
  })

  test('Given 配置已是新身份密文 When 旧 helper 无法解密 Then 写入新版本完成标记避免重复扫描', () => {
    const root = mkdtempSync(join(tmpdir(), 'dutydeck-safe-storage-current-'))
    const markerPath = join(root, '.dutydeck-safe-storage-migration.json')
    const filePath = join(root, 'channels.json')
    writeFileSync(markerPath, JSON.stringify({ version: 1, migratedAt: 1, migratedValues: 0 }))
    writeFileSync(filePath, JSON.stringify({ apiKey: Buffer.from('new:key-with-long-value').toString('base64') }))
    const currentBackend: Parameters<typeof migrateLegacySafeStorage>[0]['safeStorage'] = {
      isEncryptionAvailable: () => true,
      encryptString: (value) => Buffer.from(`new:${value}`),
      decryptString: (value) => {
        const text = value.toString()
        if (!text.startsWith('new:')) throw new Error('wrong key')
        return text.slice(4)
      },
    }
    const result = migrateLegacySafeStorage({
      dataRoot: root,
      currentName: 'new',
      legacyName: 'legacy',
      setAppName: () => undefined,
      safeStorage: currentBackend,
      readLegacySnapshot: () => ({ scannedFiles: 1, candidateValues: 1, migratedValues: 0, files: [] }),
    })

    expect(result).toMatchObject({ status: 'completed', migratedValues: 0 })
    expect(JSON.parse(readFileSync(markerPath, 'utf8'))).toMatchObject({ version: 2, status: 'completed' })
  })
})
