import { strict as assert } from 'node:assert'
import { mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { app } from 'electron'
import { isPluginCapabilityId, pluginAgentToolName } from '@dutydeck/plugin-sdk'
import { AgentPluginRegistry } from '../src/main/lib/agent-modules/plugin-registry'
import { CapabilityBroker, PluginCapabilityBrokerError } from '../src/main/lib/agent-plugins/capability-broker'
import { ModuleRuntimeManager } from '../src/main/lib/agent-plugins/module-runtime-manager'
import { ModuleRuntimePluginService } from '../src/main/lib/agent-plugins/module-runtime-plugin-service'
import { PluginRuntimeSupervisor } from '../src/main/lib/agent-plugins/runtime-supervisor'
import { createProjectArtifactCapabilityProviders } from '../src/main/lib/agent-plugins/project-artifact-providers'

const PLUGIN_ID = 'dutydeck.interaction-design-pilot'
const MODULE_ID = `${PLUGIN_ID}.workspace`
const SESSION_ID = 'interaction-pilot-smoke'
const PROJECT_ID = 'interaction-pilot-project'

/** 在真实 Electron utility 进程中运行插件安装、Agent 工具和 Surface 调用。 */
async function run(): Promise<void> {
  const packagePath = process.argv[2]
  const dataRoot = process.argv[3]
  const projectRoot = process.argv[4]
  if (!packagePath || !dataRoot || !projectRoot) throw new Error('SMOKE_ARGUMENTS_INVALID')
  app.setPath('userData', join(dataRoot, 'electron-user-data'))
  app.on('window-all-closed', () => undefined)
  await app.whenReady()
  const packageRoot = join(dataRoot, 'plugin-root')
  mkdirSync(packageRoot, { recursive: true })
  const manager = new ModuleRuntimeManager({
    moduleRegistry: new AgentPluginRegistry(),
    createSupervisor: (plugin) => {
      const broker = new CapabilityBroker({
        providers: createProjectArtifactCapabilityProviders({
          resolveProject: sessionId => sessionId === SESSION_ID
            ? { workspaceId: PROJECT_ID, projectRoot }
            : undefined,
        }),
      })
      let supervisor: PluginRuntimeSupervisor
      supervisor = new PluginRuntimeSupervisor({
        onCapabilityRequest: async request => {
          if (!isPluginCapabilityId(request.capability)) {
            return { ok: false, code: 'PLUGIN_CAPABILITY_NOT_AVAILABLE', message: '未知能力', retryable: false }
          }
          const caller = {
            pluginId: plugin.manifest.id,
            pluginVersion: plugin.manifest.version,
            packageHash: plugin.packageHash,
            moduleId: request.moduleId ?? MODULE_ID,
            sessionId: request.sessionId ?? '',
            projectId: request.projectId,
            runId: request.runId ?? 'smoke-run',
            invocationId: request.invocationId ?? 'smoke-invocation',
            grants: plugin.manifest.capabilities,
            assertCurrent: () => {
              const health = supervisor.listHealth()[0]
              if (!health || health.state !== 'running') throw new Error('stale')
            },
          }
          try {
            return {
              ok: true,
              value: await broker.invoke(caller, { capability: request.capability, input: request.input }),
            }
          } catch (error) {
            return {
              ok: false,
              code: error instanceof PluginCapabilityBrokerError ? error.code : 'PLUGIN_CAPABILITY_FAILED',
              message: '能力调用失败',
              retryable: false,
            }
          }
        },
      })
      return supervisor
    },
  })
  const service = new ModuleRuntimePluginService({ root: packageRoot, manager, development: true })
  try {
    await service.initialize()
    const preview = service.previewBytes(readFileSync(packagePath))
    await service.install(preview.token)
    const tools = await manager.buildToolsForModules({
      sdk: { defineTool: definition => definition },
      moduleIds: [MODULE_ID],
      context: {
        sessionId: SESSION_ID,
        projectId: PROJECT_ID,
        runId: 'smoke-run',
        settingsRevision: 1,
        settings: {},
        deadline: Date.now() + 30_000,
      },
    })
    const tool = (id: string) => {
      const definition = tools.find(item => item.name === pluginAgentToolName(PLUGIN_ID, id))
      assert.ok(definition, `missing tool ${id}`)
      return definition
    }
    const invoke = async (id: string, input: unknown): Promise<Record<string, unknown>> => {
      const result = await tool(id).execute(
        `smoke-${id}`,
        input,
        new AbortController().signal,
        undefined,
        {} as never,
      )
      return result.details as Record<string, unknown>
    }

    const surface = manager.openSurface({
      surfaceId: 'workspace',
      moduleId: MODULE_ID,
      sessionId: SESSION_ID,
      projectId: PROJECT_ID,
      readOnly: false,
    })
    /** 创建入口必须经过真实 Surface bridge，而不是只验证 Agent 工具直调。 */
    const created = await manager.invokeSurface({
      sessionId: SESSION_ID,
      token: surface.token,
      method: 'create',
      input: {
        name: '登录流程',
        platform: 'mobile',
        html: '<main><button data-prototype-element="login">登录</button></main>',
      },
    }) as { artifactRevision?: number }
    assert.equal(created.artifactRevision, 1)
    const proposed = await invoke('propose', {
      baseRevision: 1,
      pageId: 'home',
      name: '首页',
      html: '<main><button data-prototype-element="login">立即登录</button></main>',
      summary: '调整登录按钮',
    })
    assert.equal(proposed.revision, 2)
    const candidate = proposed.candidate as Record<string, unknown>
    const adopted = await invoke('adopt', {
      baseRevision: 2,
      candidateId: candidate.id,
    })
    assert.equal(adopted.artifactRevision, 3)
    const source = await invoke('read-source', { path: 'App.tsx', maxBytes: 4096 })
    assert.equal(source.path, 'App.tsx')

    const loaded = await manager.invokeSurface({
      sessionId: SESSION_ID,
      token: surface.token,
      method: 'load',
      input: {},
    }) as { current?: { prototype?: { pages?: Array<{ html?: string }> } } }
    assert.match(loaded.current?.prototype?.pages?.[0]?.html ?? '', /立即登录/)
    console.log('[Interaction design pilot smoke] PASS')
  } finally {
    await service.dispose()
    app.quit()
  }
}

void run().catch((error) => {
  console.error('[Interaction design pilot smoke] FAIL', error)
  app.exit(1)
})
