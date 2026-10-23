import { describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PluginStateStore } from './plugin-state-store'

describe('Given plugin private state store', () => {
  test('When 写入与读取 Then schema 与 revision 持久化且插件隔离', () => {
    const root = mkdtempSync(join(tmpdir(), 'dutydeck-plugin-state-'))
    try {
      const store = new PluginStateStore(root)
      expect(store.read('acme.echo', 'settings', 1)).toBeNull()
      expect(store.write('acme.echo', 'settings', 1, { theme: 'dark' })).toEqual({ revision: 1 })
      expect(store.read('acme.echo', 'settings', 1)).toEqual({
        schemaVersion: 1,
        revision: 1,
        value: { theme: 'dark' },
      })
      expect(store.read('other.echo', 'settings', 1)).toBeNull()
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test('When CAS 过期 Then 拒绝覆盖并保留旧值', () => {
    const root = mkdtempSync(join(tmpdir(), 'dutydeck-plugin-state-'))
    try {
      const store = new PluginStateStore(root)
      store.write('acme.echo', 'settings', 1, { value: 1 })
      expect(() => store.write('acme.echo', 'settings', 1, { value: 2 }, 0))
        .toThrow('PLUGIN_STATE_REVISION_CONFLICT')
      expect(store.read('acme.echo', 'settings', 1)?.value).toEqual({ value: 1 })
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})
