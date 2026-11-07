import { strict as assert } from 'node:assert'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { homedir } from 'node:os'
import { createHash } from 'node:crypto'
import { app } from 'electron'
import type { ExtensionToolContext, ToolDefinition } from '@earendil-works/pi-coding-agent'
import type { DutyDeckPermissionMode, PermissionRequest } from '@dutydeck/shared'
import { normalizeAgentSessionModulePolicy } from '@dutydeck/shared'
import { getChannelsPath, getConfigDir, getMcpOAuthCredentialsPath, getProxySettingsPath } from '../src/main/lib/config-paths'
import { writeJsonFileAtomic } from '../src/main/lib/safe-file'
import { AgentPluginRegistry } from '../src/main/lib/agent-modules/plugin-registry'
import { ModuleRuntimeManager } from '../src/main/lib/agent-plugins/module-runtime-manager'
import { ModuleRuntimePluginService } from '../src/main/lib/agent-plugins/module-runtime-plugin-service'
import { PluginRuntimeSupervisor } from '../src/main/lib/agent-plugins/runtime-supervisor'
import { createPluginExecutionAccess, type PluginExecutionAuthority } from '../src/main/lib/agent-plugins/plugin-execution-authority'
import { createPluginRunBinding } from '../src/main/lib/agent-plugins/plugin-run-binding'
import { createAgentRunIdentity } from '../src/main/lib/agent-run-identity'
import { AgentPermissionService, revalidateSingleApprovalResult } from '../src/main/lib/agent-permission-service'
import { PiAgentAdapter, wrapCustomToolDefinitions } from '../src/main/lib/adapters/pi-agent-adapter'
import { runDshLifecycleSmoke } from './dsh-compat-lifecycle-smoke'

interface Pilot { file: string; hash: string; id: string; input: Record<string, unknown> }
const pilots: Pilot[] = [
  { file: 'dsh-pace-calc-tool-only.ddplugin', hash: '984c3a450114f721018a8d48f8e1080b12725fafab04df1bad292ba107b25ca9', id: 'dutydeck-dsh.pace-calc', input: {} },
  { file: 'dsh-unitverse-tool-only.ddplugin', hash: '313d2179dbe889909b4d8ed4b4d607b798dd4340966b6cfbcaff0bd9888ed409', id: 'dutydeck-dsh.unitverse', input: { value: 1, from: 'km', to: 'm' } },
]
function object(value: unknown): Record<string, unknown> {
  assert.ok(value && typeof value === 'object' && !Array.isArray(value)); return value as Record<string, unknown>
}

/** 只在临时HOME安装精确开发包；真实service/权限工厂/Pi wrapper/utilityProcess，无LLM或生产信任。 */
async function run(): Promise<void> {
  const packageDirectory = process.argv[2]; const root = process.argv[3]
  if (!packageDirectory || !root || process.env.DUTYDECK_DSH_SMOKE_ROOT !== root) throw new Error('DSH_SMOKE_ARGUMENTS_INVALID')
  assert.equal(resolve(homedir()), resolve(root))
  assert.equal(resolve(getConfigDir()), resolve(root, '.DutyDeck'))
  assert.equal(getChannelsPath(), join(root, '.DutyDeck', 'channels.json'))
  assert.equal(getMcpOAuthCredentialsPath(), join(root, '.DutyDeck', 'mcp-oauth-credentials.json'))
  assert.equal(getProxySettingsPath(), join(root, '.DutyDeck', 'proxy-settings.json'))
  assert.equal(existsSync(getChannelsPath()), false)
  assert.equal(existsSync(getMcpOAuthCredentialsPath()), false)
  writeJsonFileAtomic(getProxySettingsPath(), { enabled: false, mode: 'system', manualUrl: '' })
  app.setPath('userData', join(root, 'electron-user-data'))
  app.on('window-all-closed', () => undefined)
  await app.whenReady()
  const session: { id: string; workspaceId: string; permissionMode: DutyDeckPermissionMode; archived: boolean } = { id: 'dsh-smoke-session', workspaceId: 'dsh-smoke-workspace', permissionMode: 'bypassPermissions', archived: false }
  const policy = normalizeAgentSessionModulePolicy({})
  const runIdentity = createAgentRunIdentity(session.id, 1, () => true)
  const supervisors = new Map<string, PluginRuntimeSupervisor>()
  const authority: PluginExecutionAuthority = {
    grants: () => service.grants, getSession: id => id === session.id ? session : undefined,
    getPolicy: () => policy, getActiveRunGeneration: () => 1,
  }
  const manager = new ModuleRuntimeManager({
    moduleRegistry: new AgentPluginRegistry(), assertExecutionAccess: createPluginExecutionAccess(authority),
    createSupervisor: plugin => {
      const supervisor = new PluginRuntimeSupervisor({ onCapabilityRequest: async () => { throw new Error('DSH_SMOKE_NO_CAPABILITIES') } })
      supervisors.set(plugin.manifest.id, supervisor); return supervisor
    },
  })
  const packageRoot = join(root, 'plugin-root'); mkdirSync(packageRoot, { recursive: true })
  const service = new ModuleRuntimePluginService({ root: packageRoot, manager, development: true })
  const permissions = new AgentPermissionService()
  const requests: PermissionRequest[] = []
  let decision: 'allow' | 'deny' | 'plan' | 'cancel' = 'allow'
  let activeController: AbortController | undefined
  let calls = 0
  const wrap = (tools: ToolDefinition[]) => wrapCustomToolDefinitions(tools, async (name, input, options) => {
    const result = await permissions.requestSingleApproval(session.id, name, input, options, request => {
      requests.push(request); assert.equal(request.allowAlways, false)
      queueMicrotask(() => {
        if (decision === 'cancel') activeController?.abort()
        else {
          if (decision === 'plan') session.permissionMode = 'plan'
          permissions.respondToPermission(request.requestId, decision === 'deny' ? 'deny' : 'allow', true)
        }
      })
    })
    return revalidateSingleApprovalResult(result, () => runIdentity.signal.aborted ? { behavior: 'deny', message: '运行已停止' } : undefined, () => session.permissionMode)
  })
  const invoke = async (tool: ToolDefinition, input: Record<string, unknown>, next: typeof decision = 'allow'): Promise<Record<string, unknown>> => {
    decision = next; activeController = new AbortController(); calls++
    const result = await tool.execute(`dsh-smoke-call-${calls}`, input, activeController.signal, undefined, {} as ExtensionToolContext)
    return object(result.details)
  }
  try {
    await service.initialize()
    const identities: Array<{ moduleId: string; moduleVersion: string; packageHash: string; explicit: boolean }> = []
    for (const pilot of pilots) {
      const bytes: Buffer = readFileSync(join(packageDirectory, pilot.file))
      assert.equal(createHash('sha256').update(bytes).digest('hex'), pilot.hash)
      const preview = service.previewBytes(bytes)
      assert.equal(preview.manifest.id, pilot.id)
      const installed = await service.install(preview.token)
      assert.equal(installed.plugins.find(plugin => plugin.manifest.id === pilot.id)?.enabled, false)
      identities.push({ moduleId: `${pilot.id}.tool`, moduleVersion: preview.manifest.version, packageHash: pilot.hash, explicit: true })
      await assert.rejects(service.setEnabled(pilot.id, true, service.snapshot().revision))
      await service.authorize(pilot.id, [], [session.workspaceId], service.snapshot().revision, 0)
      await service.setEnabled(pilot.id, true, service.snapshot().revision)
    }
    const binding = createPluginRunBinding(session.id, identities); binding.bind(runIdentity)
    const buildTools = (overrides: { sessionId?: string; projectId?: string; deadline?: number } = {}) => manager.buildToolsForModules({
      sdk: { defineTool: definition => definition }, moduleIds: identities.map(identity => identity.moduleId),
      context: { sessionId: session.id, projectId: session.workspaceId, runId: binding.current().runId, resolveRun: () => binding.current(), settingsRevision: 0, settings: {}, deadline: Date.now() + 30_000, ...overrides },
    })
    const tools = wrap(await buildTools())
    assert.equal(tools.length, 2)
    assert.equal(manager.approvalToolNames(identities.map(identity => identity.moduleId)).length, 2)
    assert.ok([...supervisors.values()].every(supervisor => supervisor.listHealth().length === 0), '构造工具不能启动上游')
    const pace = tools.find(tool => tool.name.endsWith('_pace_calc'))!
    const unit = tools.find(tool => tool.name.endsWith('_convert'))!
    assert.ok(pace && unit)
    for (const denied of ['deny', 'plan', 'cancel'] as const) {
      await assert.rejects(invoke(pace, {}, denied))
      assert.ok([...supervisors.values()].every(supervisor => supervisor.listHealth().length === 0), `${denied}审批后不能启动上游`)
      session.permissionMode = 'bypassPermissions'
    }
    const rejectDrift = async (pilot: Pilot, tool: ToolDefinition): Promise<void> => {
      const installed = service.snapshot().plugins.find(entry => entry.manifest.id === pilot.id)!
      const path = join(installed.packageRoot, 'runtime/main.mjs')
      const original = readFileSync(path)
      const epoch = supervisors.get(pilot.id)!.listHealth()[0]?.epoch ?? 0
      try {
        // 只追加注释作为自有漂移fixture；必须在装载前拒绝，之后恢复精确受审字节。
        writeFileSync(path, Buffer.concat([original, Buffer.from('\n// 自有smoke漂移标记\n')]))
        await assert.rejects(invoke(tool, pilot.input), /PLUGIN_PACKAGE_MATERIALIZED_MISMATCH/)
        assert.equal(supervisors.get(pilot.id)!.listHealth()[0]?.epoch ?? 0, epoch)
      } finally { writeFileSync(path, original) }
    }
    await rejectDrift(pilots[0]!, pace)
    for (const overrides of [{ sessionId: 'other-session' }, { projectId: 'other-workspace' }]) {
      const wrongContext = wrap(await buildTools(overrides)).find(tool => tool.name === pace.name)!
      await assert.rejects(invoke(wrongContext, {}), /PLUGIN_(CAPABILITY_STALE|GRANT_SCOPE)/)
    }
    const defaultPace = await invoke(pace, {})
    const paceValue = object(object(defaultPace.canonical).output)
    assert.equal(paceValue.distanceKm, 5); assert.equal(paceValue.pace, '6′00″/km'); assert.equal(paceValue.speedKmh, 10)
    assert.equal(object((defaultPace.content as unknown[])[0]).type, 'text')
    const zero = await invoke(pace, { dist: 5, min: 0, sec: 30 })
    assert.equal(object(object(zero.canonical).output).time, '30分30秒')
    assert.equal(object(object((await invoke(pace, { dist: -5 })).canonical).output).speedKmh, -10, '保留上游未限制负距离的行为，不冒称物理约束已实现')
    const rounded = await invoke(pace, { dist: 1, min: 5, sec: 59.6 })
    assert.equal(object(object(rounded.canonical).output).pace, '5′60″/km')
    await assert.rejects(invoke(pace, { dist: 5, min: 1, sec: -60 }))
    await assert.rejects(invoke(pace, { dist: '5' }))
    const length = await invoke(unit, pilots[1]!.input)
    assert.equal(object(length.canonical).result, 1000)
    assert.equal(object((length.content as unknown[])[0]).text, object(length.canonical).summary)
    assert.equal(object((await invoke(unit, { value: 25, from: '°C', to: '°F' })).canonical).result, 77)
    assert.equal(object((await invoke(unit, { value: 10, from: 'Δ°C', to: 'Δ°F' })).canonical).result, 18)
    for (const input of [
      { value: 1e308, from: 'km', to: 'm' }, { value: 1, from: 'unknown', to: 'm' },
      { value: 1, from: 'm', to: 's' }, { value: 10, from: 'Δ°C', to: '°F' },
      { from: 'km', to: 'm' }, { value: '1', from: 'km', to: 'm' },
    ]) await assert.rejects(invoke(unit, input))
    const beforeDenied = requests.length
    await assert.rejects(invoke(unit, pilots[1]!.input, 'deny'))
    assert.equal(requests.length, beforeDenied + 1, '先前批准不能替代下一次确认')
    const supervisor = supervisors.get(pilots[1]!.id)!
    const epoch = supervisor.listHealth()[0]!.epoch
    await supervisor.stop()
    await rejectDrift(pilots[1]!, unit)
    assert.equal(object((await invoke(unit, pilots[1]!.input)).canonical).result, 1000)
    assert.ok(supervisor.listHealth()[0]!.epoch > epoch, '下一次用户调用恢复，不后台无限重试')
    await service.setEnabled(pilots[0]!.id, false, service.snapshot().revision)
    await assert.rejects(invoke(pace, {}))
    await service.setEnabled(pilots[0]!.id, true, service.snapshot().revision)
    const refreshed = wrap(await buildTools()).find(tool => tool.name.endsWith('_pace_calc'))!
    assert.equal(object(object((await invoke(refreshed, {})).canonical).output).speedKmh, 10)
    const expired = wrap(await buildTools({ deadline: Date.now() - 1 })).find(tool => tool.name === pace.name)!
    await assert.rejects(invoke(expired, {}), /PLUGIN_TOOL_DEADLINE_INVALID/)
    await service.revoke(pilots[1]!.id, service.snapshot().plugins.find(plugin => plugin.manifest.id === pilots[1]!.id)!.grant!.revision)
    await assert.rejects(invoke(unit, pilots[1]!.input))
    await service.uninstall(pilots[1]!.id, service.snapshot().revision)
    await assert.rejects(invoke(unit, pilots[1]!.input))
    runIdentity.abort()
    await assert.rejects(invoke(refreshed, {}))
    const ownLifecycleFixture = await runDshLifecycleSmoke(root)
    let providerRequests = 0
    const adapter = new PiAgentAdapter({ streamFunction: () => { providerRequests++; throw new Error('不应调用任何模型') } })
    const conflict = { ...pace, name: 'read' }
    await assert.rejects(async () => {
      for await (const _message of adapter.query({
        sessionId: 'own-collision-session', prompt: '自有冲突验收，不调用模型', cwd: root,
        model: 'gpt-4o', provider: 'openai', baseUrl: 'http://offline.invalid/v1', apiKey: 'offline-fixture-not-a-credential',
        permissionMode: 'bypassPermissions', systemPrompt: '离线fixture', piAgentDir: join(root, 'pi-fixture-agent'), piSessionDir: join(root, 'pi-fixture-sessions'),
        customTools: [conflict],
      }, 'own-collision-query')) { /* 必须在建表时拒绝，不运行provider或工具。 */ }
    }, /PI_TOOL_NAME_CONFLICT:read/)
    assert.equal(providerRequests, 0)
    const evidence = { buildEvidenceSha256: createHash('sha256').update(readFileSync(join(root, 'build-evidence.json'))).digest('hex'), globalToolConflictRejected: true, ownLifecycleFixture, at: new Date().toISOString(), platform: process.platform, arch: process.arch, electron: process.versions.electron, pilots, calls, approvalRequests: requests.length, scope: 'isolated-developer-smoke', realUtilityProcess: true, realPiWrapperAndApprovalService: true, realApprovalWindow: false, llmLoop: false, productionTrust: false }
    writeJsonFileAtomic(join(root, 'result.json'), evidence)
    console.log('[DSH compatibility smoke] PASS ' + JSON.stringify(evidence))
  } finally { runIdentity.abort(); await service.dispose(); app.quit() }
}
void run().catch(error => { console.error('[DSH compatibility smoke] FAIL', error); app.exit(1) })
