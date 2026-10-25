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
function fixture(isBusy: () => boolean = () => false) {
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
  const service = new ModuleRuntimePluginService({ root, manager, development: true, isBusy })
  return { root, modules, manager, service }
}

/** 创建可安装的开发包字节。 */
function packageBytes(version = '1.0.0'): Uint8Array {
  const files = createModuleRuntimePluginFiles('acme.echo', 'Echo')
  const manifest = JSON.parse(new TextDecoder().decode(files.get('plugin.json'))) as { version: string }
  manifest.version = version
  files.set('plugin.json', new TextEncoder().encode(`${JSON.stringify(manifest)}\n`))
  const authorPackage = JSON.parse(new TextDecoder().decode(files.get('package.json'))) as { version: string }
  authorPackage.version = version
  files.set('package.json', new TextEncoder().encode(`${JSON.stringify(authorPackage)}\n`))
  files.set('CHANGELOG.md', new TextEncoder().encode(`# 版本记录\n\n## ${version}\n\n测试版本。\n`))
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
  test('When Agent 忙碌时同一预览等待后重试 Then 首次不写目录且预览仍可使用', async () => {
    let busy = true
    const first = fixture(() => busy)
    try {
      const preview = first.service.previewBytes(packageBytes())
      await expect(first.service.install(preview.token)).rejects.toThrow('AGENT_BUSY')
      expect(first.service.snapshot().plugins).toEqual([])
      busy = false
      await expect(first.service.install(preview.token)).resolves.toEqual(expect.objectContaining({
        plugins: [expect.objectContaining({ manifest: expect.objectContaining({ id: 'acme.echo' }) })],
      }))
    } finally {
      await first.service.dispose()
      rmSync(first.root, { recursive: true, force: true })
    }
  })

  test('When 插件 Host API 与当前宿主不兼容 Then 预览阶段拒绝', () => {
    const first = fixture()
    try {
      const files = createModuleRuntimePluginFiles('acme.echo', 'Echo')
      files.set('runtime/main.mjs', new TextEncoder().encode('export default { activate() {} }'))
      files.set('surfaces/workspace/index.html', new TextEncoder().encode('<!doctype html><html></html>'))
      const manifest = JSON.parse(new TextDecoder().decode(files.get('plugin.json'))) as {
        compatibility: { hostApi: string }
      }
      manifest.compatibility.hostApi = '^2.0.0'
      files.set('plugin.json', new TextEncoder().encode(`${JSON.stringify(manifest)}\n`))
      expect(() => first.service.previewBytes(createPluginPackage(files))).toThrow('PLUGIN_HOST_API_UNSUPPORTED')
    } finally {
      void first.service.dispose()
      rmSync(first.root, { recursive: true, force: true })
    }
  })

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

  test('When 安装新版本后显式回滚 Then 注册切回不可变历史包', async () => {
    const first = fixture()
    try {
      const v1 = first.service.previewBytes(packageBytes('1.0.0'))
      const installed = await first.service.install(v1.token)
      const v2 = first.service.previewBytes(packageBytes('1.0.1'))
      const updated = await first.service.install(v2.token)
      expect(updated.plugins[0]?.manifest.version).toBe('1.0.1')
      expect(first.service.listVersions('acme.echo').map(item => item.version)).toEqual(['1.0.1', '1.0.0'])
      const rolledBack = await first.service.rollback('acme.echo', v1.packageHash, installed.revision + 1)
      expect(rolledBack.plugins[0]?.manifest.version).toBe('1.0.0')
      expect(rolledBack.plugins[0]?.packageHash).toBe(v1.packageHash)
      expect(first.modules.getModule('acme.echo.assistant')?.version).toBe('1.0.0')
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
