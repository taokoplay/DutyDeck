import { describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { migrateLegacySafeStorage } from './safe-storage-migration'

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
})
