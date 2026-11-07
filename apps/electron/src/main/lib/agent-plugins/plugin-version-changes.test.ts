import { expect, test } from 'bun:test'
import { createModuleRuntimePluginFiles } from '@dutydeck/plugin-kit'
import type { PluginV3Manifest } from '@dutydeck/plugin-sdk'
import { pluginVersionChanges } from './plugin-version-changes'

test('Given 已声明schema2产物 When 中间版本移除声明 Then 拒绝无迁移合同的删除，不能经空声明再降级', () => {
  const files = createModuleRuntimePluginFiles('acme.echo', '测试')
  const before = JSON.parse(new TextDecoder().decode(files.get('plugin.json'))) as PluginV3Manifest
  before.artifacts = [{ id: 'report', ownerModuleId: 'echo', title: '报告', schemaVersion: 2, mimeTypes: ['application/json'], retention: 'project' }]
  const after = { ...before, artifacts: [] }
  expect(pluginVersionChanges({ manifest: before, packageHash: 'a'.repeat(64) }, after).blockers).toContain('PLUGIN_ARTIFACT_REMOVAL_UNSUPPORTED')
  expect(pluginVersionChanges({ manifest: before, packageHash: 'a'.repeat(64) }, before).blockers).toEqual([])
})
