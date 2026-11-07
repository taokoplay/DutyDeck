import { describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PluginStateStore } from './plugin-state-store'

describe('Given plugin private state store', () => {
  test('When 主文件封套schema与路径不一致 Then 拒绝且不提升旧备份', () => {
    const root = mkdtempSync(join(tmpdir(), 'dutydeck-plugin-state-'))
    try {
      const store = new PluginStateStore(root)
      store.write('acme.echo', 'data', 1, 'old')
      const path = join(root, 'acme.echo/v1/data.json')
      writeFileSync(`${path}.bak`, readFileSync(path))
      const invalid = JSON.stringify({ schemaVersion: 2, revision: 1, value: 'current' })
      writeFileSync(path, invalid)
      expect(() => store.read('acme.echo', 'data', 1)).toThrow('PLUGIN_STATE_SCHEMA_MISMATCH')
      expect(readFileSync(path, 'utf8')).toBe(invalid)
    } finally { rmSync(root, { recursive: true, force: true }) }
  })
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

  test('When 紧凑JSON合法但完整格式化记录超限 Then 首次写入拒绝；更新拒绝且主文件和备份不变', () => {
    const root = mkdtempSync(join(tmpdir(), 'dutydeck-plugin-state-'))
    try {
      const store = new PluginStateStore(root)
      const value = Array<number>(200_000).fill(0)
      expect(Buffer.byteLength(JSON.stringify(value))).toBeLessThan(1024 * 1024)
      expect(() => store.write('acme.echo', 'new', 1, value)).toThrow('PLUGIN_STATE_TOO_LARGE')
      expect(existsSync(join(root, 'acme.echo/v1/new.json'))).toBe(false)
      store.write('acme.echo', 'data', 1, 'first')
      store.write('acme.echo', 'data', 1, 'before', 1)
      const path = join(root, 'acme.echo/v1/data.json')
      const before = readFileSync(path); const backup = readFileSync(`${path}.bak`)
      expect(() => store.write('acme.echo', 'data', 1, value, 2)).toThrow('PLUGIN_STATE_TOO_LARGE')
      expect(readFileSync(path)).toEqual(before)
      expect(readFileSync(`${path}.bak`)).toEqual(backup)
      expect(store.read('acme.echo', 'data', 1)).toMatchObject({ revision: 2, value: 'before' })
    } finally { rmSync(root, { recursive: true, force: true }) }
  })
  test('When 完整记录恰好达到1MiB及超过一字节 Then 接受可读边界并在提交前拒绝超限', () => {
    const root = mkdtempSync(join(tmpdir(), 'dutydeck-plugin-state-'))
    try {
      const store = new PluginStateStore(root)
      const overhead = Buffer.byteLength(JSON.stringify({ schemaVersion: 1, revision: 1, value: '' }, null, 2))
      const value = 'x'.repeat(1024 * 1024 - overhead)
      expect(store.write('acme.echo', 'edge', 1, value)).toEqual({ revision: 1 })
      const path = join(root, 'acme.echo/v1/edge.json'); const before = readFileSync(path)
      expect(before.length).toBe(1024 * 1024)
      expect(store.read('acme.echo', 'edge', 1)).toMatchObject({ revision: 1, value })
      expect(() => store.write('acme.echo', 'edge', 1, value + 'x', 1)).toThrow('PLUGIN_STATE_TOO_LARGE')
      expect(readFileSync(path)).toEqual(before)
      expect(store.read('acme.echo', 'edge', 1)?.revision).toBe(1)
    } finally { rmSync(root, { recursive: true, force: true }) }
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
