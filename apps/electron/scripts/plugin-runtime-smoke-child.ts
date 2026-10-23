import { strict as assert } from 'node:assert'
import { mkdirSync, readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { app } from 'electron'
import { AgentPluginRegistry } from '../src/main/lib/agent-modules/plugin-registry'
import { ModuleRuntimeManager } from '../src/main/lib/agent-plugins/module-runtime-manager'
import { ModuleRuntimePluginService } from '../src/main/lib/agent-plugins/module-runtime-plugin-service'
import { PluginRuntimeSupervisor } from '../src/main/lib/agent-plugins/runtime-supervisor'

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
  const manager = new ModuleRuntimeManager({
    moduleRegistry: registry,
    createSupervisor: () => new PluginRuntimeSupervisor(),
  })
  const service = new ModuleRuntimePluginService({ root: packageRoot, manager, development: true })
  try {
    await service.initialize()
    const preview = service.previewBytes(bytes)
    await service.install(preview.token)
    const tools = await manager.buildToolsForModules({
      sdk: { defineTool: definition => definition },
      moduleIds: ['acme.runtime-fixture.echo'],
      context: {
        sessionId: 'smoke-session',
        projectId: null,
        runId: 'smoke-run',
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
      protocolVersion: 1,
    })
    await new Promise<void>(resolve => setTimeout(resolve, 150))
    const surface = await manager.openSurface({
      surfaceId: 'workspace',
      moduleId: 'acme.runtime-fixture.echo',
      sessionId: 'smoke-session',
      projectId: null,
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
    console.log(`[Plugin runtime smoke] PASS package=${createHash('sha256').update(bytes).digest('hex')}`)
  } finally {
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
