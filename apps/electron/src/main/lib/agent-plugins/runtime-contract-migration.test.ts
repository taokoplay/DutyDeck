import { describe, expect, test } from 'bun:test'
import { mkdtempSync, mkdirSync, rmSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createModuleRuntimePluginFiles } from '@dutydeck/plugin-kit'
import { createPluginPackage, inspectPluginPackage } from '@dutydeck/plugin-kit/package'
import { writeNewFile } from '@dutydeck/plugin-kit/filesystem'
import { writeJsonFileAtomicSecure } from '../safe-file'
import { AgentPluginRegistry } from '../agent-modules/plugin-registry'
import { ModuleRuntimeManager } from './module-runtime-manager'
import { ModuleRuntimePluginService } from './module-runtime-plugin-service'
import { materializeRuntimePluginPackage } from './runtime-package-materializer'

function legacyBytes(): Uint8Array {
  const files = createModuleRuntimePluginFiles('acme.legacy', '旧协议样本')
  const manifest = JSON.parse(new TextDecoder().decode(files.get('plugin.json'))) as { compatibility: { runtimeProtocol: number } }
  manifest.compatibility.runtimeProtocol = 1
  files.set('plugin.json', new TextEncoder().encode(JSON.stringify(manifest)))
  files.set('runtime/main.mjs', new TextEncoder().encode('throw new Error("旧入口不得执行")'))
  files.set('surfaces/workspace/index.html', new TextEncoder().encode('<!doctype html><html></html>'))
  return createPluginPackage(files)
}
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'dutydeck-contract-migration-'))
  const modules = new AgentPluginRegistry()
  let supervisors = 0
  const manager = new ModuleRuntimeManager({ moduleRegistry: modules, createSupervisor: () => {
    supervisors++
    return { start: async () => ({ pluginId: 'acme.legacy', state: 'running', epoch: 1 }), invokeTool: async () => ({}), stop: async () => undefined }
  } })
  const service = new ModuleRuntimePluginService({ root, manager, development: true })
  return { root, modules, manager, service, supervisors: () => supervisors }
}

describe('Given 已安装 runtime contract 1 的旧包', () => {
  test('When 新安装预览 Then 返回迁移错误且不会加载runtime', async () => {
    const f = fixture()
    try {
      expect(() => f.service.previewBytes(legacyBytes())).toThrow('PLUGIN_RUNTIME_CONTRACT_MIGRATION_REQUIRED')
      expect(f.supervisors()).toBe(0)
    } finally { await f.service.dispose(); rmSync(f.root, { recursive: true, force: true }) }
  })

  test('When 带旧授权和enabled记录重启 Then 持久停用、可管理，禁止重新启用且保留归档与授权', async () => {
    const f = fixture()
    try {
      const bytes = legacyBytes()
      const inspected = inspectPluginPackage(bytes)
      if (inspected.manifest.formatVersion !== 3) throw new Error('fixture必须V3')
      const materialized = materializeRuntimePluginPackage({ root: f.root, manifest: inspected.manifest, packageHash: inspected.packageHash, files: inspected.files })
      const archives = join(f.root, 'archives', inspected.manifest.id)
      mkdirSync(archives, { recursive: true })
      const archive = join(archives, `${inspected.packageHash}.ddplugin`)
      writeNewFile(archive, bytes)
      writeJsonFileAtomicSecure(join(f.root, 'registry.json'), { formatVersion: 1, revision: 1, plugins: [{ manifest: inspected.manifest, packageHash: inspected.packageHash, packageRoot: materialized.packageRoot, enabled: true, installedAt: new Date().toISOString() }] })
      f.service.grants.set({ pluginId: inspected.manifest.id, pluginVersion: inspected.manifest.version, packageHash: inspected.packageHash }, inspected.manifest.capabilities, [], 0)
      const snapshot = await f.service.initialize()
      expect(snapshot.plugins[0]).toMatchObject({ enabled: false, executionBlock: 'PLUGIN_RUNTIME_CONTRACT_MIGRATION_REQUIRED' })
      expect(f.supervisors()).toBe(0)
      expect(f.modules.listModules()).toEqual([])
      const stored = JSON.parse(readFileSync(join(f.root, 'registry.json'), 'utf8')) as { plugins: Array<{ enabled: boolean }> }
      expect(stored.plugins[0]?.enabled).toBe(false)
      await expect(f.service.setEnabled(inspected.manifest.id, true, snapshot.revision)).rejects.toThrow('PLUGIN_RUNTIME_CONTRACT_MIGRATION_REQUIRED')
      expect(f.service.listVersions(inspected.manifest.id)).toHaveLength(1)
      expect(readFileSync(archive)).toEqual(Buffer.from(bytes))
      expect(f.service.grants.get(inspected.manifest.id)?.revoked).toBe(false)
      // 新合同包可正常替换；显式回滚不能再次引入旧执行合同。
      const currentFiles = createModuleRuntimePluginFiles('acme.legacy', '迁移后插件')
      currentFiles.set('runtime/main.mjs', new TextEncoder().encode('export default { activate() {} }'))
      currentFiles.set('surfaces/workspace/index.html', new TextEncoder().encode('<!doctype html><html></html>'))
      const upgraded = await f.service.install(f.service.previewBytes(createPluginPackage(currentFiles)).token)
      await expect(f.service.rollback(inspected.manifest.id, inspected.packageHash, upgraded.revision)).rejects.toThrow('PLUGIN_RUNTIME_CONTRACT_MIGRATION_REQUIRED')
      expect(f.service.snapshot().plugins[0]?.packageHash).toBe(upgraded.plugins[0]?.packageHash)
      const removed = await f.service.uninstall(inspected.manifest.id, upgraded.revision)
      expect(removed.plugins).toEqual([])
    } finally { await f.service.dispose(); rmSync(f.root, { recursive: true, force: true }) }
  })

  test('When 绕过service直接注册旧包 Then manager也拒绝创建supervisor', () => {
    const f = fixture()
    try {
      const inspected = inspectPluginPackage(legacyBytes())
      if (inspected.manifest.formatVersion !== 3) throw new Error('fixture必须V3')
      const manifest = inspected.manifest
      expect(() => f.manager.register({ manifest, packageHash: inspected.packageHash, packageRoot: f.root, prompts: { 'acme.legacy/prompts/workflow': '测试流程' } })).toThrow('PLUGIN_RUNTIME_CONTRACT_MIGRATION_REQUIRED')
      expect(f.supervisors()).toBe(0)
    } finally { rmSync(f.root, { recursive: true, force: true }) }
  })
})
