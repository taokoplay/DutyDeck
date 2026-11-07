import { describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type { PluginV3Manifest } from '@dutydeck/plugin-sdk'
import { createModuleRuntimePluginFiles } from '@dutydeck/plugin-kit'
import { PluginSettingsStore } from './plugin-settings-store'

function manifest(): PluginV3Manifest {
  const result = JSON.parse(new TextDecoder().decode(createModuleRuntimePluginFiles('acme.echo', 'Echo').get('plugin.json'))) as PluginV3Manifest
  result.settings = [
    { key: 'title', type: 'text', label: '标题', required: true, maxLength: 16, apply: 'restart-runtime' },
    { key: 'count', type: 'integer', label: '数量', minimum: 1, maximum: 5, defaultValue: 2, apply: 'next-run' },
    { key: 'enabled', type: 'boolean', label: '启用', defaultValue: true, apply: 'next-run' },
    { key: 'mode', type: 'enum', label: '模式', enumValues: ['a', 'b'], apply: 'next-run' },
  ]
  return result
}

describe('Given 普通设置的 revision 与 schema', () => {
  test('When 设置缺失或类型越界 Then 明确阻止启用/保存；有效保存可重启读取', () => {
    const root = mkdtempSync(join(tmpdir(), 'plugin-settings-'))
    try {
      const store = new PluginSettingsStore(root)
      const spec = manifest()
      const hash = 'a'.repeat(64)
      expect(store.read(spec, hash).values).toEqual({ count: 2, enabled: true })
      expect(() => store.assertReady(spec, hash)).toThrow('PLUGIN_SETTINGS_REQUIRED')
      for (const values of [{ title: 'ok', count: 6 }, { title: 'ok', mode: 'c' }, { title: 'ok', enabled: 'true' }, { title: 'ok', unknown: 1 }]) {
        expect(() => store.save(spec, hash, values, 0)).toThrow('PLUGIN_SETTINGS_INVALID')
      }
      const saved = store.save(spec, hash, { title: 'ok', mode: 'a' }, 0)
      saved.values.title = 'mutated'
      expect(new PluginSettingsStore(root).assertReady(spec, hash)).toEqual({ revision: 1, values: { title: 'ok', mode: 'a', count: 2, enabled: true } })
      expect(() => store.save(spec, hash, { title: 'changed' }, 0)).toThrow('PLUGIN_SETTINGS_REVISION_CONFLICT')
      expect(store.read(spec, 'b'.repeat(64)).revision).toBe(0)
    } finally { rmSync(root, { recursive: true, force: true }) }
  })
})
