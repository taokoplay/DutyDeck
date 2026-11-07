import { describe, expect, spyOn, test } from 'bun:test'
import * as validationCatalog from './plugin-validation-catalog'
import { mkdtempSync, rmSync, mkdirSync, symlinkSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { createHash, generateKeyPairSync } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createModuleRuntimePluginFiles } from '@dutydeck/plugin-kit'
import { createPluginPackage } from '@dutydeck/plugin-kit/package'
import { AgentPluginRegistry } from '../agent-modules/plugin-registry'
import { ModuleRuntimeManager } from './module-runtime-manager'
import { ModuleRuntimePluginService } from './module-runtime-plugin-service'
import type { PluginV3Manifest } from '@dutydeck/plugin-sdk'

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
function packageBytes(version = '1.0.0', schemaVersion?: number): Uint8Array {
  const files = createModuleRuntimePluginFiles('acme.echo', 'Echo')
  const manifest = JSON.parse(new TextDecoder().decode(files.get('plugin.json'))) as PluginV3Manifest
  manifest.version = version
  if (schemaVersion !== undefined) {
    manifest.artifacts = [{ id: 'report', ownerModuleId: manifest.modules[0]!.id, title: '报告', schemaVersion, mimeTypes: ['application/json'], retention: 'project' }]
    manifest.modules[0]!.artifacts = ['report']
  }
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
  test('When 只读取管理快照 Then 分开显示证据/授权/健康且不启动代码', async () => {
    const first = fixture()
    try {
      const preview = first.service.previewBytes(packageBytes())
      const installed = await first.service.install(preview.token)
      expect(installed.plugins[0]?.management).toMatchObject({ validation: { status: 'unassessed' }, authorization: 'required', health: { state: 'stopped' } })
      await first.service.authorize('acme.echo', preview.manifest.capabilities, ['workspace-1'], installed.revision, 0)
      const enabled = await first.service.setEnabled('acme.echo', true, installed.revision)
      expect(enabled.plugins[0]?.management).toMatchObject({ authorization: 'granted', health: { state: 'idle' } })
      const revoked = await first.service.revoke('acme.echo', 1)
      expect(revoked.plugins[0]?.management).toMatchObject({ authorization: 'revoked', health: { state: 'stopped' } })
    } finally { await first.service.dispose(); rmSync(first.root, { recursive: true, force: true }) }
  })
  test('When 材料诊断被延迟 Then 管理写操作不等待诊断且撤权不受其锁阻碍', async () => {
    const first = fixture()
    let release: () => void = () => undefined
    try {
      const preview = first.service.previewBytes(packageBytes())
      const installed = await first.service.install(preview.token)
      await first.service.authorize('acme.echo', preview.manifest.capabilities, ['workspace-1'], installed.revision, 0)
      const enabled = await first.service.setEnabled('acme.echo', true, installed.revision)
      const gate = new Promise<void>(resolve => { release = resolve })
      const check = spyOn(validationCatalog, 'readPluginValidationEnvironment').mockImplementation(async () => { await gate; return validationCatalog.getPluginValidationEnvironment() })
      try {
        const diagnosis = first.service.validatedSnapshot()
        let finished = false
        const operation = first.service.setEnabled('acme.echo', true, enabled.revision).then(() => { finished = true })
        await new Promise<void>(resolve => setTimeout(resolve, 30))
        expect(finished).toBe(true)
        await first.service.revoke('acme.echo', 1)
        expect(first.service.snapshot().plugins[0]?.management?.authorization).toBe('revoked')
        release(); await operation
        expect((await diagnosis).plugins[0]?.management?.authorization).toBe('revoked')
      } finally { release(); check.mockRestore() }
    } finally { await first.service.dispose(); rmSync(first.root, { recursive: true, force: true }) }
  })
  test('When 确认预览前当前包变化 Then 拒绝旧token避免按过期差异安装', async () => {
    const first = fixture()
    try {
      await first.service.install(first.service.previewBytes(packageBytes('1.0.0')).token)
      const stale = first.service.previewBytes(packageBytes('4.0.0'))
      await first.service.install(first.service.previewBytes(packageBytes('3.0.0')).token)
      await expect(first.service.install(stale.token)).rejects.toThrow('PLUGIN_PREVIEW_BASELINE_CHANGED')
      expect(first.service.snapshot().plugins[0]?.manifest.version).toBe('3.0.0')
    } finally { await first.service.dispose(); rmSync(first.root, { recursive: true, force: true }) }
  })
  test('When 升级改变artifact声明 Then 显示差异且阻止无逆向合同的包降级', async () => {
    const first = fixture()
    try {
      const v1 = first.service.previewBytes(packageBytes('1.0.0', 1))
      await first.service.install(v1.token)
      const v2 = first.service.previewBytes(packageBytes('2.0.0', 2))
      expect(v2.changes?.artifacts).toEqual(expect.arrayContaining([expect.objectContaining({ fromSchema: 1, toSchema: 2 })]))
      expect(v2.changes?.dataCompatibility).toBe('unknown')
      const updated = await first.service.install(v2.token)
      expect(first.service.listVersions('acme.echo').find(version => version.packageHash === v1.packageHash)?.changes?.blockers).toContain('PLUGIN_ARTIFACT_SCHEMA_DOWNGRADE')
      await expect(first.service.rollback('acme.echo', v1.packageHash, updated.revision)).rejects.toThrow('PLUGIN_ARTIFACT_SCHEMA_DOWNGRADE')
      expect(first.service.snapshot().plugins[0]?.manifest.version).toBe('2.0.0')
      const disguised = first.service.previewBytes(packageBytes('3.0.0', 1))
      await expect(first.service.install(disguised.token)).rejects.toThrow('PLUGIN_ARTIFACT_SCHEMA_DOWNGRADE')
    } finally { await first.service.dispose(); rmSync(first.root, { recursive: true, force: true }) }
  })
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
      const pending = await first.service.install(preview.token)
      await first.service.authorize('acme.echo', preview.manifest.capabilities, ['workspace-1'], pending.revision, 0)
      const installed = await first.service.setEnabled('acme.echo', true, pending.revision)
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
      expect(rolledBack.plugins[0]?.enabled).toBe(false)
      await first.service.authorize('acme.echo', v1.manifest.capabilities, ['workspace-1'], rolledBack.revision, 0)
      await first.service.setEnabled('acme.echo', true, rolledBack.revision)
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

describe('Given 安装与执行授权分离', () => {
  test('When 只有安装确认没有独立 grants Then 不注册可执行模块且启用被阻止', async () => {
    const first = fixture()
    try {
      const preview = first.service.previewBytes(packageBytes())
      const installed = await first.service.install(preview.token)
      const registered = first.modules.getModule('acme.echo.assistant')
      expect(installed.plugins[0]?.enabled).toBe(false)
      expect(registered).toBeUndefined()
      await expect(first.service.setEnabled('acme.echo', true, installed.revision)).rejects.toThrow('PLUGIN_GRANT_REQUIRED')
    } finally {
      await first.service.dispose()
      rmSync(first.root, { recursive: true, force: true })
    }
  })
})

describe('Given 未完成的凭据桥接', () => {
  test('When 插件需要 credentialRef Then 授权不使插件误启用', async () => {
    const first = fixture()
    try {
      const files = createModuleRuntimePluginFiles('acme.echo', 'Echo')
      const manifest = JSON.parse(new TextDecoder().decode(files.get('plugin.json'))) as { settings: unknown[] }
      manifest.settings = [{ key: 'token', label: 'Token', type: 'credentialRef', required: true, apply: 'restart-runtime' }]
      files.set('plugin.json', new TextEncoder().encode(JSON.stringify(manifest)))
      files.set('runtime/main.mjs', new TextEncoder().encode('export default { activate() {} }'))
      files.set('surfaces/workspace/index.html', new TextEncoder().encode('<html></html>'))
      const preview = first.service.previewBytes(createPluginPackage(files))
      const installed = await first.service.install(preview.token)
      await first.service.authorize('acme.echo', [], [], installed.revision, 0)
      await expect(first.service.setEnabled('acme.echo', true, installed.revision)).rejects.toThrow('PLUGIN_CREDENTIAL_BRIDGE_UNAVAILABLE')
    } finally { await first.service.dispose(); rmSync(first.root, { recursive: true, force: true }) }
  })
})

describe('Given 旧安装停用迁移', () => {
  test('When 无 grant 的旧 enabled 安装仅重新授权 Then 重启后仍保持停用', async () => {
    const first = fixture()
    const reopened: ModuleRuntimePluginService[] = []
    try {
      const preview = first.service.previewBytes(packageBytes())
      await first.service.install(preview.token)
      const { readJsonFileSafe, writeJsonFileAtomicSecure } = await import('../safe-file')
      const path = join(first.root, 'registry.json')
      const old = readJsonFileSafe<{ revision: number; plugins: Array<{ enabled: boolean }> }>(path)!
      old.plugins[0]!.enabled = true
      writeJsonFileAtomicSecure(path, old)
      const reopen = () => {
        const manager = new ModuleRuntimeManager({ moduleRegistry: new AgentPluginRegistry(), createSupervisor: () => ({ start: async () => ({ pluginId: 'acme.echo', state: 'running', epoch: 1 }), invokeTool: async () => ({}), stop: async () => undefined }) })
        const service = new ModuleRuntimePluginService({ root: first.root, manager, development: true })
        reopened.push(service)
        return service
      }
      const second = reopen()
      const migrated = await second.initialize()
      expect(migrated.plugins[0]?.enabled).toBe(false)
      await second.authorize('acme.echo', preview.manifest.capabilities, ['workspace-1'], migrated.revision, 0)
      const third = reopen()
      expect((await third.initialize()).plugins[0]?.enabled).toBe(false)
    } finally {
      await Promise.all([first.service, ...reopened].map(service => service.dispose()))
      rmSync(first.root, { recursive: true, force: true })
    }
  })
})

test('Given 插件根是符号链接 When 构造服务 Then 在创建 grants/settings 前拒绝且不写目标目录', () => {
  const root = mkdtempSync(join(tmpdir(), 'dutydeck-root-symlink-'))
  const target = join(root, 'target')
  mkdirSync(target)
  const link = join(root, 'plugins')
  symlinkSync(target, link)
  try {
    const manager = new ModuleRuntimeManager({ moduleRegistry: new AgentPluginRegistry(), createSupervisor: () => { throw new Error('not expected') } })
    expect(() => new ModuleRuntimePluginService({ root: link, manager })).toThrow()
    expect(readdirSync(target)).toEqual([])
  } finally { rmSync(root, { recursive: true, force: true }) }
})

describe('Given 已启用但尚未装载的精确插件包', () => {
  test('When 启用后runtime字节漂移 Then 首次调用和进程重启前均拒绝，原字节恢复后仍可调用', async () => {
    const root = mkdtempSync(join(tmpdir(), 'dutydeck-v3-drift-'))
    let starts = 0; let running = false
    const manager = new ModuleRuntimeManager({
      moduleRegistry: new AgentPluginRegistry(),
      createSupervisor: () => ({
        start: async () => { starts++; running = true; return { pluginId: 'acme.echo', state: 'running', epoch: starts } },
        listHealth: () => [{ pluginId: 'acme.echo', state: running ? 'running' : 'stopped', epoch: starts }],
        invokeTool: async () => ({}), stop: async () => { running = false },
      }),
    })
    const service = new ModuleRuntimePluginService({ root, manager, development: true })
    try {
      const preview = service.previewBytes(packageBytes())
      await service.install(preview.token)
      await service.authorize('acme.echo', preview.manifest.capabilities, ['workspace-1'], service.snapshot().revision, 0)
      await service.setEnabled('acme.echo', true, service.snapshot().revision)
      const runtime = join(service.snapshot().plugins[0]!.packageRoot, 'runtime/main.mjs')
      const original = readFileSync(runtime)
      const [tool] = await manager.buildToolsForModules({
        sdk: { defineTool: tool => tool }, moduleIds: [preview.manifest.modules[0]!.id],
        context: { sessionId: 'session-1', projectId: 'workspace-1', runId: 'run-1', settingsRevision: 0, settings: {}, deadline: Date.now() + 5000 },
      })
      expect(tool).toBeDefined()
      for (const previousStarts of [0, 1]) {
        running = false
        writeFileSync(runtime, '// 自有字节漂移fixture，不会执行\n')
        await expect(tool!.execute(`drift-${previousStarts}`, {}, undefined, undefined, {} as never)).rejects.toThrow('PLUGIN_PACKAGE_MATERIALIZED_MISMATCH')
        expect(starts).toBe(previousStarts)
        writeFileSync(runtime, original)
        await tool!.execute(`restored-${previousStarts}`, {}, undefined, undefined, {} as never)
        expect(starts).toBe(previousStarts + 1)
      }
    } finally { await service.dispose(); rmSync(root, { recursive: true, force: true }) }
  })
})
