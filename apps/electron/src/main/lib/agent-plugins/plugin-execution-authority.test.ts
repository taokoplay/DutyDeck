import { describe, expect, spyOn, test } from 'bun:test'
import * as safeFile from '../safe-file'
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { normalizeAgentSessionModulePolicy } from '@dutydeck/shared'
import { createModuleRuntimePluginFiles } from '@dutydeck/plugin-kit'
import { parsePluginManifestV3, type PluginCapabilityId } from '@dutydeck/plugin-sdk'
import { createAgentRunIdentity } from '../agent-run-identity'
import { createPluginRunBinding } from './plugin-run-binding'
import { PluginGrantStore } from './plugin-grant-store'
import { PluginStateStore } from './plugin-state-store'
import { CapabilityBroker, type HostCapabilityProvider } from './capability-broker'
import { createCoreCapabilityProviders } from './core-capability-providers'
import { createProjectArtifactCapabilityProviders } from './project-artifact-providers'
import { createPluginCapabilityHandler, createPluginExecutionAccess, type PluginExecutionAuthority } from './plugin-execution-authority'
import type { ManagedRuntimePlugin } from './module-runtime-manager'
import type { PluginRuntimeSupervisorDependencies } from './runtime-supervisor'

type CapabilityRequest = Parameters<NonNullable<PluginRuntimeSupervisorDependencies['onCapabilityRequest']>>[0]
let generationCounter = 100
function fixture(explicit = true) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'dutydeck-production-authority-')))
  const files = createModuleRuntimePluginFiles('acme.authority', '生产权限fixture')
  const parsed = parsePluginManifestV3(JSON.parse(new TextDecoder().decode(files.get('plugin.json'))))
  if (!parsed.ok) throw new Error('fixture')
  const capabilities: PluginCapabilityId[] = ['plugin.state.read', 'plugin.state.write', 'artifact.read', 'artifact.write', 'artifact.migrate']
  const plugin: ManagedRuntimePlugin = { manifest: { ...parsed.value, capabilities }, packageHash: 'a'.repeat(64), packageRoot: root, prompts: {} }
  const module = { moduleId: 'acme.authority.assistant', moduleVersion: '1.0.0', packageHash: plugin.packageHash }
  const grants = new PluginGrantStore(join(root, 'grants'))
  const grantIdentity = { pluginId: plugin.manifest.id, pluginVersion: plugin.manifest.version, packageHash: plugin.packageHash }
  grants.set(grantIdentity, capabilities, ['workspace'], 0)
  const state = new PluginStateStore(join(root, 'state'))
  const session = { workspaceId: 'workspace', archived: false, permissionMode: 'default' }
  let generation = ++generationCounter
  let policy = normalizeAgentSessionModulePolicy(explicit ? {} : { enabledModuleIds: [module.moduleId], moduleBindings: [module] })
  const run = createAgentRunIdentity('session', generation, () => generation === run.generation)
  const binding = createPluginRunBinding('session', [{ ...module, explicit }])
  binding.bind(run)
  const authority: PluginExecutionAuthority = { grants: () => grants, getSession: () => session, getPolicy: () => policy, getActiveRunGeneration: () => generation }
  const providers = new Map<PluginCapabilityId, HostCapabilityProvider['invoke']>([
    ...createCoreCapabilityProviders({ state, getSession: () => ({ id: 'session', ...session }) }),
    ...createProjectArtifactCapabilityProviders({ resolveProject: () => ({ workspaceId: 'workspace', projectRoot: root }) }),
  ])
  const broker = new CapabilityBroker({ providers })
  const handler = createPluginCapabilityHandler(plugin, broker, authority)
  const controller = new AbortController()
  const request = (capability: PluginCapabilityId, input: unknown): CapabilityRequest => ({
    ...grantIdentity, capability, input, invocationId: 'invoke', moduleId: module.moduleId, sessionId: 'session', projectId: 'workspace', runId: binding.current().runId,
    epoch: 1, deadline: Date.now() + 5000, readOnly: null, signal: controller.signal,
    assertCurrent: () => { if (controller.signal.aborted) throw new Error('PLUGIN_CAPABILITY_STALE') },
  })
  return { root, plugin, grants, state, session, providers, broker, handler, request, controller, run, authority, module,
    nextGeneration: () => { generation++ }, detach: () => { policy = normalizeAgentSessionModulePolicy({}) },
    disable: () => { policy = normalizeAgentSessionModulePolicy({ disabledModuleIds: [module.moduleId] }) },
    replaceHash: () => { policy = normalizeAgentSessionModulePolicy({ enabledModuleIds: [module.moduleId], moduleBindings: [{ ...module, packageHash: 'b'.repeat(64) }] }) },
    cleanup: () => { run.abort(); rmSync(root, { recursive: true, force: true }) },
  }
}

/** 在真实provider前暂停，不伪称停在atomic rename内部。 */
function pause(f: ReturnType<typeof fixture>, capability: PluginCapabilityId) {
  const original = f.providers.get(capability)!
  let entered!: () => void
  let resume!: () => void
  const ready = new Promise<void>(resolve => { entered = resolve })
  const gate = new Promise<void>(resolve => { resume = resolve })
  f.providers.set(capability, async (input) => { entered(); await gate; return original(input) })
  return { ready, resume }
}

describe('Given 与生产IPC共用的权限组合工厂', () => {
  test('When 单轮explicit调用成功但下一代不再选择 Then 状态真实落盘且旧轮不可复用', async () => {
    const f = fixture()
    try {
      const request = f.request('plugin.state.write', { key: 'counter', value: 1, schemaVersion: 1 })
      expect(await f.handler(request)).toMatchObject({ ok: true, value: { revision: 1 } })
      expect(f.state.read(f.plugin.manifest.id, 'counter', 1)?.value).toBe(1)
      f.nextGeneration()
      expect(await f.handler({ ...request, input: { key: 'counter', value: 2, schemaVersion: 1 } })).toMatchObject({ ok: false, code: 'PLUGIN_CAPABILITY_STALE' })
      expect(f.state.read(f.plugin.manifest.id, 'counter', 1)?.value).toBe(1)
    } finally { f.cleanup() }
  })

  test('When 生产组合写入400KB请求却产生超限磁盘记录 Then 拒绝且不回退原revision', async () => {
    const f = fixture()
    try {
      expect(await f.handler(f.request('plugin.state.write', { key: 'large', value: 'before', schemaVersion: 1 }))).toMatchObject({ ok: true, value: { revision: 1 } })
      const request = f.request('plugin.state.write', { key: 'large', value: Array<number>(200_000).fill(0), schemaVersion: 1, expectedRevision: 1 })
      expect(Buffer.byteLength(JSON.stringify(request.input))).toBeLessThan(1024 * 1024)
      expect(await f.handler(request)).toMatchObject({ ok: false, code: 'PLUGIN_STATE_TOO_LARGE' })
      expect(await f.handler(f.request('plugin.state.read', { key: 'large', schemaVersion: 1 }))).toMatchObject({ ok: true, value: { revision: 1, value: 'before' } })
    } finally { f.cleanup() }
  })

  for (const mode of ['revoke', 'archive', 'workspace', 'disable', 'detach', 'hash', 'plan', 'abort', 'generation'] as const) {
    test(`When artifact写入等待期间${mode} Then 恢复真实provider后不能提交`, async () => {
      const f = fixture(false)
      try {
        const request = f.request('artifact.write', { artifactId: 'report', schemaVersion: 1, value: { unauthorized: true } })
        const wait = pause(f, 'artifact.write')
        const pending = f.handler(request)
        await wait.ready
        if (mode === 'revoke') f.grants.revoke(f.plugin.manifest.id, 1)
        else if (mode === 'archive') f.session.archived = true
        else if (mode === 'workspace') f.session.workspaceId = 'other'
        else if (mode === 'disable') f.disable()
        else if (mode === 'detach') f.detach()
        else if (mode === 'hash') f.replaceHash()
        else if (mode === 'plan') f.session.permissionMode = 'plan'
        else if (mode === 'abort') f.controller.abort()
        else f.nextGeneration()
        wait.resume()
        expect(await pending).toMatchObject({ ok: false })
        expect(existsSync(join(f.root, '.dutydeck/plugin-artifacts/acme.authority/report.json'))).toBe(false)
      } finally { f.cleanup() }
    })
  }

  test('When artifact迁移期间撤权 Then 原schema/revision/正文保持不变', async () => {
    const f = fixture()
    try {
      expect(await f.handler(f.request('artifact.write', { artifactId: 'report', schemaVersion: 1, value: 'before' }))).toMatchObject({ ok: true })
      const path = join(f.root, '.dutydeck/plugin-artifacts/acme.authority/report.json')
      const before = readFileSync(path)
      const wait = pause(f, 'artifact.migrate')
      const pending = f.handler(f.request('artifact.migrate', { artifactId: 'report', fromSchemaVersion: 1, toSchemaVersion: 2, expectedRevision: 1, value: 'after' }))
      await wait.ready
      f.grants.revoke(f.plugin.manifest.id, 1)
      wait.resume()
      expect(await pending).toMatchObject({ ok: false })
      expect(readFileSync(path)).toEqual(before)
    } finally { f.cleanup() }
  })

  for (const capability of ['plugin.state.write', 'artifact.write', 'artifact.migrate'] as const) {
    test(`When ${capability}已写临时文件且rename前撤权 Then 不覆盖原内容`, async () => {
      const f = fixture()
      try {
        const isState = capability === 'plugin.state.write'
        const initial = isState
          ? f.request('plugin.state.write', { key: 'final', schemaVersion: 1, value: 'before' })
          : f.request('artifact.write', { artifactId: 'final', schemaVersion: 1, value: 'before' })
        expect(await f.handler(initial)).toMatchObject({ ok: true })
        const path = isState ? join(f.root, 'state/acme.authority/v1/final.json') : join(f.root, '.dutydeck/plugin-artifacts/acme.authority/final.json')
        const before = readFileSync(path)
        const secureWrite = safeFile.writeJsonFileAtomicSecure
        const plainWrite = safeFile.writeJsonFileAtomic
        let revoked = false
        const revoke = (): void => { revoked = true; f.grants.revoke(f.plugin.manifest.id, 1) }
        const secure = spyOn(safeFile, 'writeJsonFileAtomicSecure').mockImplementation((file, data, options) => secureWrite(file, data,
          file === path ? { ...options, beforeRename: temp => { revoke(); options?.beforeRename?.(temp) } } : options))
        // 旧state实现没有rename钩子；同样在最后一次权限检查之后、真正写入之前注入撤权。
        const plain = spyOn(safeFile, 'writeJsonFileAtomic').mockImplementation((file, ...args) => { if (file === path) revoke(); return plainWrite(file, ...args) })
        try {
          const input = capability === 'artifact.migrate'
            ? { artifactId: 'final', fromSchemaVersion: 1, toSchemaVersion: 2, expectedRevision: 1, value: 'after' }
            : { ...(isState ? { key: 'final' } : { artifactId: 'final' }), schemaVersion: 1, expectedRevision: 1, value: 'after' }
          const result = await f.handler(f.request(capability, input))
          expect(revoked).toBe(true)
          expect(result).toMatchObject({ ok: false })
          expect(readFileSync(path)).toEqual(before)
        } finally { secure.mockRestore(); plain.mockRestore() }
      } finally { f.cleanup() }
    })
  }

  test('When Surface只读或用户进入计划模式 Then 读允许、写拒绝且Node启动门禁拒绝计划模式', async () => {
    const f = fixture()
    try {
      const read = { ...f.request('plugin.state.read', { key: 'missing', schemaVersion: 1 }), runId: 'surface-1', readOnly: true }
      expect(await f.handler(read)).toMatchObject({ ok: true, value: null })
      expect(await f.handler({ ...read, capability: 'plugin.state.write', input: { key: 'missing', value: {}, schemaVersion: 1 } })).toMatchObject({ ok: false, code: 'PLUGIN_CAPABILITY_READ_ONLY' })
      const access = createPluginExecutionAccess(f.authority)
      const context = { sessionId: 'session', projectId: 'workspace', moduleId: f.module.moduleId, readOnly: false, runId: f.run.sessionId + ':' + f.run.generation }
      expect(() => access(f.plugin, context)).not.toThrow()
      f.session.permissionMode = 'plan'
      expect(() => access(f.plugin, context)).toThrow('PLUGIN_CAPABILITY_READ_ONLY')
    } finally { f.cleanup() }
  })
})
