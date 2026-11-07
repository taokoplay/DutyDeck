import { describe, expect, test } from 'bun:test'
import { parsePluginManifestV3 } from '@dutydeck/plugin-sdk'
import { AgentPluginRegistry } from '../agent-modules/plugin-registry'
import { ModuleRuntimeManager } from './module-runtime-manager'

/** 构造 V3 清单和对应提示。 */
function fixture() {
  const parsed = parsePluginManifestV3({
    formatVersion: 3,
    apiVersion: '1.0.0',
    id: 'acme.echo',
    publisherId: 'acme',
    version: '1.0.0',
    displayName: 'Echo',
    description: 'echo',
    license: 'MIT',
    profile: 'module-runtime',
    compatibility: { hostApi: '^1.0.0', runtimeProtocol: 2, platforms: ['darwin'], architectures: ['arm64'] },
    runtime: { entry: 'runtime/main.mjs', format: 'module-esm' },
    modules: [{
      id: 'assistant', displayName: 'Echo', description: 'echo', icon: 'package', activation: 'session-toggle',
      skillRefs: [], promptRefs: ['workflow'], tools: ['inspect'], surfaces: ['workspace'], services: [], artifacts: [],
    }],
    tools: [{
      id: 'inspect', ownerModuleId: 'assistant', title: 'Inspect', description: 'inspect',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      annotations: { readOnly: true, destructive: false, idempotent: true, openWorld: false },
      approval: 'none', timeoutMs: 1000,
    }],
    surfaces: [{
      id: 'workspace', ownerModuleId: 'assistant', title: 'Echo', entry: 'surfaces/workspace/index.html',
      apiVersion: 1, defaultPlacement: 'right-panel', methods: ['load'],
    }],
    services: [], artifacts: [],
    prompts: [{ id: 'workflow', version: '1.0.0', kind: 'workflow', path: 'prompts/workflow.md' }],
    settings: [], capabilities: ['session.read'], dependencies: [], exports: [],
  })
  if (!parsed.ok) throw new Error(JSON.stringify(parsed.issues))
  return parsed.value
}

describe('Given module runtime manager', () => {
  test('When 注册插件 Then 模块、提示、贡献和 Surface 同时发布', () => {
    const modules = new AgentPluginRegistry()
    const manager = new ModuleRuntimeManager({
      moduleRegistry: modules,
      createSupervisor: () => ({
        start: async () => ({ pluginId: 'acme.echo', state: 'running', epoch: 1 }),
        invokeTool: async () => ({}),
        stop: async () => undefined,
      }),
    })
    manager.register({
      manifest: fixture(),
      packageHash: 'a'.repeat(64),
      packageRoot: '/private/tmp/acme.echo/1.0.0',
      prompts: { 'acme.echo/prompts/workflow': '只执行声明工具。' },
    })
    expect(modules.getModule('acme.echo.assistant')?.pluginId).toBe('acme.echo')
    expect(modules.getPromptCatalog()['acme.echo/prompts/workflow']).toBe('只执行声明工具。')
    expect(manager.getSurface('workspace', 'acme.echo.assistant')?.pluginId).toBe('acme.echo')
  })

  test('When 激活模块并执行工具 Then 审批前不启动且实际调用复用一次 runtime', async () => {
    let starts = 0
    const manager = new ModuleRuntimeManager({
      moduleRegistry: new AgentPluginRegistry(),
      createSupervisor: () => ({
        start: async () => {
          starts += 1
          return { pluginId: 'acme.echo', state: 'running', epoch: 1 }
        },
        invokeTool: async () => ({ echoed: true }),
        stop: async () => undefined,
      }),
    })
    manager.register({
      manifest: fixture(),
      packageHash: 'a'.repeat(64),
      packageRoot: '/private/tmp/acme.echo/1.0.0',
      prompts: { 'acme.echo/prompts/workflow': '只执行声明工具。' },
    })
    const tools = await manager.buildToolsForModules({
      sdk: { defineTool: tool => tool },
      moduleIds: ['acme.echo.assistant', 'acme.echo.assistant'],
      context: {
        sessionId: 'session-1', projectId: 'project-1', runId: 'run-1', settingsRevision: 1, settings: {}, deadline: Date.now() + 5000,
      },
    })
    expect(starts).toBe(0)
    await tools[0]!.execute('call-1', {}, undefined, undefined, {} as never)
    expect(starts).toBe(1)
    expect(tools.map(tool => tool.name)).toEqual(['plugin_acme_echo_inspect'])
    expect(await manager.buildToolsForModules({
      sdk: { defineTool: tool => tool },
      moduleIds: ['acme.echo.assistant'],
      context: {
        sessionId: 'session-1', projectId: 'project-1', runId: 'run-2', settingsRevision: 1, settings: {}, deadline: Date.now() + 5000,
      },
    })).toHaveLength(1)
    expect(starts).toBe(1)
  })

  test('When Surface bridge 调用 Then 校验 token 并转发到所属 runtime', async () => {
    let observedMethod = ''
    const manager = new ModuleRuntimeManager({
      moduleRegistry: new AgentPluginRegistry(),
      approveSurface: async () => true,
      createSupervisor: () => ({
        start: async () => ({ pluginId: 'acme.echo', state: 'running', epoch: 1 }),
        invokeTool: async () => ({}),
        invokeSurface: async (input) => {
          observedMethod = input.method
          return { loaded: true }
        },
        stop: async () => undefined,
      }),
    })
    manager.register({
      manifest: fixture(),
      packageHash: 'a'.repeat(64),
      packageRoot: '/private/tmp/acme.echo/1.0.0',
      prompts: { 'acme.echo/prompts/workflow': '只执行声明工具。' },
    })
    const surface = manager.openSurface({
      surfaceId: 'workspace', moduleId: 'acme.echo.assistant', sessionId: 'session-1', projectId: null, readOnly: true,
    })
    await expect(manager.invokeSurface({
      sessionId: 'session-1', token: surface.token, method: 'load', input: {},
    })).resolves.toEqual({ loaded: true })
    expect(observedMethod).toBe('load')
  })
})

describe('Given 执行前授权边界', () => {
  test('When 仅装配待审批工具 Then 不启动 runtime；执行时才复核工作区与包身份', async () => {
    let starts = 0
    let allowed = false
    const manager = new ModuleRuntimeManager({
      moduleRegistry: new AgentPluginRegistry(),
      assertExecutionAccess: () => { if (!allowed) throw new Error('PLUGIN_GRANT_SCOPE') },
      createSupervisor: () => ({
        start: async () => { starts++; return { pluginId: 'acme.echo', state: 'running', epoch: 1 } },
        invokeTool: async () => ({}), stop: async () => undefined,
      }),
    })
    manager.register({ manifest: fixture(), packageHash: 'a'.repeat(64), packageRoot: '/tmp/acme.echo', prompts: { 'acme.echo/prompts/workflow': '只执行声明工具。' } })
    const tools = await manager.buildToolsForModules({
      sdk: { defineTool: tool => tool }, moduleIds: ['acme.echo.assistant'],
      context: { sessionId: 'session-1', projectId: 'project-1', runId: 'run-1', settingsRevision: 1, settings: {}, deadline: Date.now() + 5000 },
    })
    const startsBefore = starts
    await expect(tools[0]!.execute('call-1', {}, undefined, undefined, {} as never)).rejects.toThrow('PLUGIN_GRANT_SCOPE')
    expect(startsBefore).toBe(0)
    expect(starts).toBe(0)
    allowed = true
    await tools[0]!.execute('call-2', {}, undefined, undefined, {} as never)
    expect(starts).toBe(1)
  })
})

describe('Given Surface 逐次审批与关闭租约', () => {
  function surfaceFixture(approveSurface?: () => Promise<boolean>) {
    let starts = 0
    let calls = 0
    let release!: () => void
    let signal: AbortSignal | undefined
    const manager = new ModuleRuntimeManager({
      moduleRegistry: new AgentPluginRegistry(),
      approveSurface,
      createSupervisor: () => ({
        start: async () => { starts++; return { pluginId: 'acme.echo', state: 'running', epoch: 1 } },
        invokeTool: async () => ({}),
        invokeSurface: async input => { calls++; signal = input.signal; await new Promise<void>(resolve => { release = resolve }); return { saved: true } },
        stop: async () => undefined,
      }),
    })
    manager.register({ manifest: fixture(), packageHash: 'a'.repeat(64), packageRoot: '/tmp/acme.echo', prompts: { 'acme.echo/prompts/workflow': '只执行声明工具。' } })
    const opened = manager.openSurface({ surfaceId: 'workspace', moduleId: 'acme.echo.assistant', sessionId: 'session-1', projectId: null, readOnly: true })
    return { manager, opened, startCount: () => starts, callCount: () => calls, signal: () => signal, release: () => release?.(), invoke: () => manager.invokeSurface({ sessionId: 'session-1', token: opened.token, method: 'load', input: {} }) }
  }
  test('When 没有逐次审批通道或用户拒绝 Then 不加载 Node 代码', async () => {
    for (const approve of [undefined, async () => false]) {
      const f = surfaceFixture(approve)
      const pending = f.invoke().catch(error => error)
      await new Promise(resolve => setTimeout(resolve, 0))
      f.release()
      expect(await pending).toBeInstanceOf(Error)
      expect(f.startCount()).toBe(0)
    }
  })
  test('When 等待审批时关闭 Surface Then 审批的迟到同意不启动 runtime', async () => {
    let approve!: (value: boolean) => void
    const f = surfaceFixture(() => new Promise(resolve => { approve = resolve }))
    const pending = f.invoke().catch(error => error)
    await new Promise(resolve => setTimeout(resolve, 0))
    f.manager.closeSurface(f.opened.token)
    approve?.(true)
    f.release()
    expect(await pending).toBeInstanceOf(Error)
    expect(f.startCount()).toBe(0)
  })
  test('When 调用期间关闭 Surface Then 真实信号取消且拒绝迟到结果', async () => {
    const f = surfaceFixture(async () => true)
    const pending = f.invoke().catch(error => error)
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(f.callCount()).toBe(1)
    f.manager.closeSurface(f.opened.token)
    f.release()
    expect(f.signal()?.aborted).toBe(true)
    expect(await pending).toBeInstanceOf(Error)
  })
})

test('Given 启动失败或运行进程退出 When 用户再次调用 Then 清理旧实例并重建且并发只启动一次', async () => {
  let starts = 0
  let stops = 0
  let running = false
  const manager = new ModuleRuntimeManager({
    moduleRegistry: new AgentPluginRegistry(),
    createSupervisor: () => ({
      start: async () => { starts++; if (starts === 1) throw new Error('PLUGIN_RUNTIME_START_FAILED'); running = true; return { pluginId: 'acme.echo', state: 'running', epoch: starts } },
      invokeTool: async () => { if (!running) throw new Error('PLUGIN_RUNTIME_NOT_RUNNING'); return { ok: true } },
      listHealth: () => [{ pluginId: 'acme.echo', state: running ? 'running' as const : 'failed' as const, epoch: starts }],
      stop: async () => { stops++; running = false },
    }),
  })
  manager.register({ manifest: fixture(), packageHash: 'a'.repeat(64), packageRoot: '/tmp/acme.echo', prompts: { 'acme.echo/prompts/workflow': '只执行声明工具。' } })
  const tools = await manager.buildToolsForModules({ sdk: { defineTool: tool => tool }, moduleIds: ['acme.echo.assistant'], context: { sessionId: 'session-1', projectId: null, runId: 'run-1', settingsRevision: 1, settings: {}, deadline: Date.now() + 5000 } })
  const invoke = () => tools[0]!.execute('call', {}, undefined, undefined, {} as never)
  await expect(invoke()).rejects.toThrow('PLUGIN_RUNTIME_START_FAILED')
  const retry = await Promise.all([invoke(), invoke()]).catch(error => error)
  expect(retry).not.toBeInstanceOf(Error)
  expect(starts).toBe(2)
  expect(stops).toBe(1)
  running = false
  await invoke()
  expect(starts).toBe(3)
  expect(stops).toBe(2)
})
