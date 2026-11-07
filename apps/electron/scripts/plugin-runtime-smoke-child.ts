import { strict as assert } from 'node:assert'
import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { app } from 'electron'
import { AgentPluginRegistry } from '../src/main/lib/agent-modules/plugin-registry'
import { ModuleRuntimeManager } from '../src/main/lib/agent-plugins/module-runtime-manager'
import { ModuleRuntimePluginService } from '../src/main/lib/agent-plugins/module-runtime-plugin-service'
import { PluginRuntimeSupervisor } from '../src/main/lib/agent-plugins/runtime-supervisor'
import { CapabilityBroker } from '../src/main/lib/agent-plugins/capability-broker'
import { createCoreCapabilityProviders } from '../src/main/lib/agent-plugins/core-capability-providers'
import { createPluginCapabilityHandler, createPluginExecutionAccess, type PluginExecutionAuthority } from '../src/main/lib/agent-plugins/plugin-execution-authority'
import { createProjectArtifactCapabilityProviders } from '../src/main/lib/agent-plugins/project-artifact-providers'
import { createPluginRunBinding } from '../src/main/lib/agent-plugins/plugin-run-binding'
import { createAgentRunIdentity } from '../src/main/lib/agent-run-identity'
import { normalizeAgentSessionModulePolicy } from '@dutydeck/shared'
import { PluginStateStore } from '../src/main/lib/agent-plugins/plugin-state-store'

/** 子进程只使用传入的临时包和临时数据根。 */
async function run(): Promise<void> {
  const packagePath = process.argv[2]
  const dataRoot = process.argv[3]
  if (!packagePath || !dataRoot) throw new Error('PLUGIN_SMOKE_ARGUMENTS_INVALID')
  app.setPath('userData', join(dataRoot, 'electron-user-data'))
  app.on('window-all-closed', () => undefined)
  await app.whenReady()
  const bytes = readFileSync(packagePath)
  const packageRoot = join(dataRoot, 'plugin-root')
  mkdirSync(packageRoot, { recursive: true })
  const registry = new AgentPluginRegistry()
  const state = new PluginStateStore(join(dataRoot, 'state'))
  let pauseWrite = false
  let entered: (() => void) | undefined
  let resume: (() => void) | undefined
  let committed: (() => void) | undefined
  const projectRoot = join(dataRoot, 'project')
  mkdirSync(projectRoot, { recursive: true })
  const session = { id: 'smoke-session', workspaceId: 'smoke-workspace', permissionMode: 'default', archived: false }
  const moduleId = 'acme.runtime-fixture.echo'
  let policy = normalizeAgentSessionModulePolicy({})
  const runIdentity = createAgentRunIdentity(session.id, 1, () => true)
  const authority: PluginExecutionAuthority = {
    grants: () => service.grants, getSession: id => id === session.id ? session : undefined,
    getPolicy: () => policy, getActiveRunGeneration: () => 1,
  }
  const providers = new Map([
    ...createCoreCapabilityProviders({ state, getSession: () => session }),
    ...createProjectArtifactCapabilityProviders({ resolveProject: () => ({ workspaceId: session.workspaceId, projectRoot }) }),
  ])
  for (const capability of ['plugin.state.write', 'artifact.write'] as const) {
    const write = providers.get(capability)!
    providers.set(capability, async input => {
      if (pauseWrite) {
        entered?.()
        await new Promise<void>(resolve => { resume = resolve })
      }
      try { return await write(input) } finally { committed?.() }
    })
  }
  const broker = new CapabilityBroker({ providers })
  const identities: Array<string | null> = []
  const manager = new ModuleRuntimeManager({
    moduleRegistry: registry,
    approveSurface: async () => true,
    assertExecutionAccess: createPluginExecutionAccess(authority),
    createSupervisor: plugin => {
      const handler = createPluginCapabilityHandler(plugin, broker, authority)
      return new PluginRuntimeSupervisor({ onCapabilityRequest: async request => {
        identities.push(request.sessionId)
        return handler(request)
      } })
    },
  })
  const service = new ModuleRuntimePluginService({ root: packageRoot, manager, development: true })
  try {
    await service.initialize()
    const preview = service.previewBytes(bytes)
    const installed = await service.install(preview.token)
    assert.equal(installed.plugins[0]?.enabled, false)
    const capabilities = ['plugin.state.read', 'plugin.state.write', 'artifact.read', 'artifact.write'] as const
    await service.authorize(preview.manifest.id, [...capabilities], [session.workspaceId], installed.revision, 0)
    const module = { moduleId, moduleVersion: preview.manifest.version, packageHash: createHash('sha256').update(bytes).digest('hex') }
    const binding = createPluginRunBinding(session.id, [{ ...module, explicit: true }])
    binding.bind(runIdentity)
    await service.setEnabled(preview.manifest.id, true, installed.revision)
    const tools = await manager.buildToolsForModules({
      sdk: { defineTool: definition => definition },
      moduleIds: ['acme.runtime-fixture.echo'],
      context: {
        sessionId: 'smoke-session',
        projectId: session.workspaceId,
        runId: binding.current().runId,
        settingsRevision: 1,
        settings: {},
        deadline: Date.now() + 30_000,
      },
    })
    assert.equal(tools.length, 1)
    const result = await tools[0]!.execute(
      'smoke-tool',
      { message: 'hello' },
      new AbortController().signal,
      undefined,
      {} as never,
    )
    assert.deepEqual(result.details, {
      pluginId: 'acme.runtime-fixture',
      message: 'hello',
      // 这是示例业务结果字段，不是宿主RPC信封版本。
      protocolVersion: 1,
    })
    assert.deepEqual(identities, [null, 'smoke-session', 'smoke-session'])
    assert.equal(state.read('acme.runtime-fixture', 'smoke-counter', 1)?.revision, 1)
    // 工具本轮explicit不要求长期附着；Surface写入必须另有精确长期绑定。
    policy = normalizeAgentSessionModulePolicy({ enabledModuleIds: [moduleId], moduleBindings: [module] })
    await new Promise<void>(resolve => setTimeout(resolve, 150))
    const surface = await manager.openSurface({
      surfaceId: 'workspace',
      moduleId: 'acme.runtime-fixture.echo',
      sessionId: 'smoke-session',
      projectId: session.workspaceId,
      readOnly: false,
    })
    const surfaceMetadata = manager.getSurface('workspace', 'acme.runtime-fixture.echo')
    assert.ok(surfaceMetadata)
    assert.match(`dutydeck-plugin://${surface.token}/${surfaceMetadata.entry}`, /^dutydeck-plugin:\/\//)
    await expectSurface(() => manager.invokeSurface({
      sessionId: 'smoke-session',
      token: surface.token,
      method: 'loadContext',
      input: {},
    }))
    const positive = await manager.invokeSurface({ sessionId: session.id, token: surface.token, method: 'writeArtifact', input: { key: 'positive' } })
    assert.equal((positive as { revision: number }).revision, 1)
    const artifactPath = (key: string): string => join(projectRoot, '.dutydeck/plugin-artifacts/acme.runtime-fixture', `${key}.json`)
    assert.equal(JSON.parse(readFileSync(artifactPath('positive'), 'utf8')).value.committed, true)
    manager.closeSurface(surface.token)
    // 在真实provider入口暂停，覆盖真实utility租约与生产权限回调；rename内部边界由组合测试单独注入。
    for (const action of ['close', 'cancel', 'revoke'] as const) {
      for (const method of ['writeState', 'writeArtifact'] as const) {
        const opened = manager.openSurface({ surfaceId: 'workspace', moduleId, sessionId: session.id, projectId: session.workspaceId, readOnly: false })
        const reached = new Promise<void>(resolve => { entered = resolve })
        const drained = new Promise<void>(resolve => { committed = resolve })
        const cancel = new AbortController()
        const key = `pending-${action}-${method === 'writeState' ? 'state' : 'artifact'}`
        pauseWrite = true
        const pending = manager.invokeSurface({ sessionId: session.id, token: opened.token, method, input: { key }, signal: cancel.signal }).then(() => null, error => error)
        await reached
        if (action === 'close') manager.closeSurface(opened.token)
        else if (action === 'cancel') cancel.abort()
        else await service.revoke(preview.manifest.id, service.snapshot().plugins[0]!.grant!.revision)
        resume?.()
        await drained
        assert.ok(await pending instanceof Error, `${action}必须拒绝在途调用`)
        assert.equal(state.read(preview.manifest.id, key, 1), null, `${action}后state不能落盘`)
        assert.equal(existsSync(artifactPath(key)), false, `${action}后artifact不能落盘`)
        pauseWrite = false
        manager.closeSurface(opened.token)
        if (action === 'revoke') {
          const snapshot = service.snapshot()
          await service.authorize(preview.manifest.id, [...capabilities], [session.workspaceId], snapshot.revision, snapshot.plugins[0]!.grant!.revision)
          await service.setEnabled(preview.manifest.id, true, service.snapshot().revision)
        }
      }
    }
    console.log(`[Plugin runtime smoke] PASS package=${createHash('sha256').update(bytes).digest('hex')}；共用生产权限工厂+真实run binding；真实Surface→utility→broker→state/artifact提交前close/cancel/revoke均拒绝且未落盘`)

  } finally {
    runIdentity.abort()
    await service.dispose()
    app.quit()
  }
}

/** 等待真实 Surface runtime 返回固定示例摘要。 */
async function expectSurface(invoke: () => Promise<unknown>): Promise<void> {
  assert.deepEqual(await invoke(), {
    pluginId: 'acme.runtime-fixture',
    title: '运行底座示例',
  })
}

void run().catch((error) => {
  console.error('[Plugin runtime smoke] FAIL', error)
  app.exit(1)
})
