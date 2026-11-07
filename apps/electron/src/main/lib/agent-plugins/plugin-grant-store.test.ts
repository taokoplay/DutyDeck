import { writeJsonFileAtomicSecure } from '../safe-file'
import { describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { PluginGrantStore } from './plugin-grant-store'

const identity = { pluginId: 'acme.echo', pluginVersion: '1.0.0', packageHash: 'a'.repeat(64) }

describe('Given 用户独立签发的插件 grants', () => {
  test('When 没有授权、版本或工作区不匹配 Then 不继承清单权限', () => {
    const root = mkdtempSync(join(tmpdir(), 'plugin-grants-'))
    try {
      const store = new PluginGrantStore(root)
      expect(store.get(identity.pluginId)).toBeNull()
      expect(() => store.assertGranted(identity, 'workspace-1')).toThrow('PLUGIN_GRANT_REQUIRED')
      const grant = store.set(identity, ['session.read'], ['workspace-1'], 0)
      expect(new PluginGrantStore(root).assertGranted(identity, 'workspace-1')).toEqual(grant)
      expect(() => store.assertGranted({ ...identity, packageHash: 'b'.repeat(64) }, 'workspace-1')).toThrow('PLUGIN_GRANT_REQUIRED')
      expect(() => store.assertGranted(identity, 'workspace-2')).toThrow('PLUGIN_GRANT_SCOPE')
      expect(() => store.set(identity, [], [], 0)).toThrow('PLUGIN_GRANT_REVISION_CONFLICT')
    } finally { rmSync(root, { recursive: true, force: true }) }
  })

  test('When 撤权或修改 grants Then 旧 revision 失效且不能随重启复活', () => {
    const root = mkdtempSync(join(tmpdir(), 'plugin-grants-'))
    try {
      const store = new PluginGrantStore(root)
      store.set(identity, ['plugin.state.read'], [], 0)
      store.revoke(identity.pluginId, 1)
      expect(() => new PluginGrantStore(root).assertGranted(identity, null)).toThrow('PLUGIN_GRANT_REQUIRED')
      expect(store.get(identity.pluginId)?.revision).toBe(2)
    } finally { rmSync(root, { recursive: true, force: true }) }
  })
})

test('Given 撤权主文件损坏且旧授权备份存在 When 读取 Then 不从旧备份恢复执行权限', () => {
  const root = mkdtempSync(join(tmpdir(), 'plugin-grants-corrupt-'))
  try {
    const store = new PluginGrantStore(root)
    const grant = store.set(identity, ['plugin.state.read'], [], 0)
    store.revoke(identity.pluginId, 1)
    writeJsonFileAtomicSecure(join(root, `${identity.pluginId}.json.bak`), grant)
    writeJsonFileAtomicSecure(join(root, `${identity.pluginId}.json`), { corrupted: true })
    expect(() => store.assertGranted(identity)).toThrow()
  } finally { rmSync(root, { recursive: true, force: true }) }
})
