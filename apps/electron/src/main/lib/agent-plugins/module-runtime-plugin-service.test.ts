import { describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { createHash, generateKeyPairSync } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createModuleRuntimePluginFiles } from '@dutydeck/plugin-kit'
import { createPluginPackage } from '@dutydeck/plugin-kit/package'
import { AgentPluginRegistry } from '../agent-modules/plugin-registry'
import { ModuleRuntimeManager } from './module-runtime-manager'
import { ModuleRuntimePluginService } from './module-runtime-plugin-service'

/** 创建隔离 service 和可观察 manager。 */
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'dutydeck-v3-services-'))
  const modules = new AgentPluginRegistry()
  const manager = new ModuleRuntimeManager({
    moduleRegistry: modules,
    createSupervisor: () => ({
      start: async () => ({ pluginId: 'acme.echo', state: 'running', epoch: 1 }),
      invokeTool: async () => ({}),
      stop: async () => undefined,
    }),
  })
  const service = new ModuleRuntimePluginService({ root, manager, development: true })
  return { root, modules, manager, service }
}

/** 创建可安装的开发包字节。 */
function packageBytes(): Uint8Array {
  const files = createModuleRuntimePluginFiles('acme.echo', 'Echo')
  files.set('runtime/main.mjs', new TextEncoder().encode('export default { activate() {} }'))
  files.set('surfaces/workspace/index.html', new TextEncoder().encode('<!doctype html><html></html>'))
  files.set('surfaces/workspace/main.js', new TextEncoder().encode('export {}'))
  return createPluginPackage(files)
}

/** 生产测试使用进程内临时 Ed25519 密钥。 */
function signedPackageBytes(): { bytes: Uint8Array; keyId: string } {
  const files = createModuleRuntimePluginFiles('acme.echo', 'Echo')
  files.set('runtime/main.mjs', new TextEncoder().encode('export default { activate() {} }'))
  files.set('surfaces/workspace/index.html', new TextEncoder().encode('<!doctype html><html></html>'))
  files.set('surfaces/workspace/main.js', new TextEncoder().encode('export {}'))
  const { privateKey, publicKey } = generateKeyPairSync('ed25519')
  const bytes = createPluginPackage(files, privateKey)
  const keyId = createHash('sha256').update(publicKey.export({ type: 'spki', format: 'der' })).digest('hex')
  return { bytes, keyId }
}

describe('Given V3 plugin management service', () => {
  test('When 开发包安装、重启、停用和卸载 Then 目录与运行注册同步', async () => {
    const first = fixture()
    try {
      const preview = first.service.previewBytes(packageBytes())
      expect(preview.manifest.formatVersion).toBe(3)
      const installed = await first.service.install(preview.token)
      expect(installed.plugins).toHaveLength(1)
      expect(first.modules.getModule('acme.echo.assistant')?.pluginId).toBe('acme.echo')

      const secondModules = new AgentPluginRegistry()
      const secondManager = new ModuleRuntimeManager({
        moduleRegistry: secondModules,
        createSupervisor: () => ({
          start: async () => ({ pluginId: 'acme.echo', state: 'running', epoch: 1 }),
          invokeTool: async () => ({}),
          stop: async () => undefined,
        }),
      })
      const second = new ModuleRuntimePluginService({
        root: first.root,
        manager: secondManager,
        development: true,
      })
      await second.initialize()
      expect(secondModules.getModule('acme.echo.assistant')?.pluginId).toBe('acme.echo')

      const disabled = await first.service.setEnabled('acme.echo', false, installed.revision)
      expect(disabled.plugins[0]?.enabled).toBe(false)
      expect(first.modules.getModule('acme.echo.assistant')).toBeUndefined()

      const removed = await first.service.uninstall('acme.echo', disabled.revision)
      expect(removed.plugins).toEqual([])
    } finally {
      await first.service.dispose()
      rmSync(first.root, { recursive: true, force: true })
    }
  })

  test('When 生产环境未信任发布者 Then 拒绝安装，明确信任后才接收', async () => {
    const root = mkdtempSync(join(tmpdir(), 'dutydeck-v3-signed-'))
    const manager = new ModuleRuntimeManager({
      moduleRegistry: new AgentPluginRegistry(),
      createSupervisor: () => ({
        start: async () => ({ pluginId: 'acme.echo', state: 'running', epoch: 1 }),
        invokeTool: async () => ({}),
        stop: async () => undefined,
      }),
    })
    const service = new ModuleRuntimePluginService({ root, manager })
    try {
      const signed = signedPackageBytes()
      const preview = service.previewBytes(signed.bytes)
      await expect(service.install(preview.token)).rejects.toThrow('PLUGIN_PUBLISHER_UNTRUSTED')
      const retry = service.previewBytes(signed.bytes)
      await expect(service.install(retry.token, signed.keyId)).resolves.toEqual(expect.objectContaining({
        plugins: [expect.objectContaining({ keyId: signed.keyId })],
      }))
    } finally {
      await service.dispose()
      rmSync(root, { recursive: true, force: true })
    }
  })
})
