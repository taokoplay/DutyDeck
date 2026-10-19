import { strict as assert } from 'node:assert'
import { spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { BrowserWindow } from 'electron'
import { AGENT_IPC_CHANNELS, normalizeAgentSessionModulePolicy } from '@dutydeck/shared'
import type { AgentModuleCommand, AgentModuleCommandInput, AgentSessionModulePolicy, AgentSessionModulePolicyUpdateInput } from '@dutydeck/shared'
import { AgentPluginHost } from '../src/main/lib/agent-modules/plugin-host'
import { createBuiltinAgentPluginRegistrations } from '../src/main/lib/agent-modules/builtin-plugin-adapters'
import { AgentPluginRegistry } from '../src/main/lib/agent-modules/plugin-registry'
import { listBuiltinAgentModules } from '../src/main/lib/agent-modules/module-registry'
import { AgentModuleCommandBus } from '../src/main/lib/agent-modules/module-command-bus'
import { AgentModuleCommandDispatcher } from '../src/main/lib/agent-modules/module-command-dispatcher'
import { AgentModuleCommandStore } from '../src/main/lib/agent-modules/module-command-store'
import { buildNextSessionModulePolicy } from '../src/main/lib/agent-modules/module-policy'
import { AgentPluginManagementService } from '../src/main/lib/agent-modules/plugin-management-service'
import { AgentRunRecoveryService } from '../src/main/lib/agent-run-recovery'
import { buildAgentModuleRunAudits } from '../src/main/lib/agent-modules/module-run-audit'
import type { AgentRunRecoveryInput, AgentRunRecoveryPlan, AgentModuleRunAuditQuery } from '@dutydeck/shared'
import { AgentRunJournalStore } from '../src/main/lib/agent-run-journal'
import { writeJsonFileAtomic } from '../src/main/lib/safe-file'

/** 只由本脚本消费的子进程标记。 */
const CHILD_ENV = 'DUTYDECK_MODULE_UI_SMOKE_CHILD'

/** 等待真实 DOM 状态，超时报告页面内容。 */
async function waitFor(window: BrowserWindow, expression: string): Promise<void> {
  const deadline = Date.now() + 12_000
  while (Date.now() < deadline) {
    if (await window.webContents.executeJavaScript(`Boolean(${expression})`)) return
    await new Promise<void>((resolve) => setTimeout(resolve, 50))
  }
  throw new Error(`等待失败：${expression}\n${await window.webContents.executeJavaScript('document.body.innerText.slice(0, 2500)')}`)
}

/** 真实鼠标点击覆盖 Radix pointerdown 和 Portal 接线。 */
async function click(window: BrowserWindow, selector: string): Promise<void> {
  const query = `document.querySelector(${JSON.stringify(selector)})`
  await waitFor(window, `${query} && !${query}.disabled`)
  const point: { x: number; y: number } = await window.webContents.executeJavaScript(`(async()=>{
    const node=${query};node.scrollIntoView({block:'nearest'});
    await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));
    const rect=node.getBoundingClientRect();return {x:Math.round(rect.x+rect.width/2),y:Math.round(rect.y+rect.height/2)};
  })()`)
  window.webContents.sendInputEvent({ type: 'mouseDown', ...point, button: 'left', clickCount: 1 })
  window.webContents.sendInputEvent({ type: 'mouseUp', ...point, button: 'left', clickCount: 1 })
}

/** 定位可读按钮标签后通过真实鼠标点击。 */
async function clickText(window: BrowserWindow, text: string): Promise<void> {
  await waitFor(window, `[...document.querySelectorAll('button')].some(node=>node.textContent.trim()===${JSON.stringify(text)})`)
  await window.webContents.executeJavaScript(`[...document.querySelectorAll('button')].find(node=>node.textContent.trim()===${JSON.stringify(text)}).setAttribute('data-smoke-click','target')`)
  await click(window, '[data-smoke-click="target"]')
  await window.webContents.executeJavaScript(`document.querySelector('[data-smoke-click="target"]')?.removeAttribute('data-smoke-click')`)
}

/** 生产组件/preload/域服务集成；IPC adapter 和执行队列为隔离夹具，未运行 Pi 或模型。 */
async function runSmoke(dataRoot: string, buildDir: string, htmlName: string): Promise<void> {
  const { app, BrowserWindow, ipcMain } = require('electron') as typeof import('electron')
  app.setPath('userData', join(dataRoot, 'electron-user-data'))
  app.on('window-all-closed', () => undefined)
  await app.whenReady()
  const pluginRoot = join(dataRoot, 'agent-plugins')
  const sessionRoot = join(dataRoot, 'agent-sessions')
  mkdirSync(join(pluginRoot, 'example.plugin'), { recursive: true })
  mkdirSync(join(pluginRoot, 'legacy.plugin'), { recursive: true })
  mkdirSync(sessionRoot, { recursive: true })
  // 插件只声明受管 Skill，不包含可执行第三方代码。
  writeJsonFileAtomic(join(pluginRoot, 'example.plugin', 'plugin.json'), {
    id: 'example.plugin', version: '1.0.0', apiVersion: 1, displayName: '示例插件', description: 'smoke 插件', entry: { kind: 'manifest-only' },
    modules: [{ id: 'example', version: '1.0.0', apiVersion: 1, displayName: '示例模块', description: 'smoke 模块', icon: 'terminal', scope: 'session', contributions: ['skill'], skillRefs: ['canvas-production'], promptRefs: [], toolRefs: [], artifactTypes: [], surfaceIds: [], requiredPermissions: [] }],
  })
  writeJsonFileAtomic(join(pluginRoot, 'legacy.plugin', 'plugin.json'), { id: 'legacy.plugin', entry: { kind: 'native' } })
  const registry = new AgentPluginRegistry()
  registry.registerBuiltinModules(listBuiltinAgentModules())
  const diagnostics = registry.loadInstalledPlugins(pluginRoot)
  assert.equal(diagnostics.find((entry) => entry.pluginId === 'example.plugin')?.status, 'loaded')
  assert.equal(diagnostics.find((entry) => entry.pluginId === 'legacy.plugin')?.status, 'rejected')
  /** 文件选择器路径固定，实际预览和安装使用生产服务。 */
  const management = new AgentPluginManagementService(registry, pluginRoot)
  const candidatePath = join(dataRoot, 'candidate.json')
  writeJsonFileAtomic(candidatePath, {
    id: 'smoke.installed', version: '1.0.0', apiVersion: 1, displayName: '本地安装验收', description: '纯文本提示插件', entry: { kind: 'manifest-only' },
    prompts: { 'smoke.installed.guide': '按模块执行任务。' },
    modules: [{ id: 'smoke-installed', version: '1.0.0', apiVersion: 1, displayName: '新安装模块', description: '依赖验收', icon: 'terminal', scope: 'session', contributions: ['skill', 'prompt'], skillRefs: ['canvas-production', 'disabled-skill', 'missing-skill'], promptRefs: ['smoke.installed.guide'], toolRefs: [], artifactTypes: [], surfaceIds: [], requiredPermissions: [] }],
  })
  // 独立会话策略经生产原子文件封装持久化。
  const policies = new Map<string, AgentSessionModulePolicy>([
    ['smoke-a', normalizeAgentSessionModulePolicy(undefined)],
    ['smoke-b', buildNextSessionModulePolicy(undefined, { mode: 'available', enabledModuleIds: ['browser'], disabledModuleIds: ['canvas'] })],
  ])
  const policyReads: string[] = []
  const getPolicy = (sessionId: string): AgentSessionModulePolicy => {
    const policy = policies.get(sessionId)
    if (!policy) throw new Error('SMOKE_SESSION_NOT_FOUND')
    return policy
  }
  const store = new AgentModuleCommandStore({ resolvePath: (sessionId) => join(sessionRoot, `${sessionId}.module-commands.json`) })
  const bus = new AgentModuleCommandBus({ getModule: (id) => registry.getModule(id), getPolicy, store })
  // 确定性队列只验证派发、撤销与身份，不冒充实际 Agent 执行。
  const queued = new Set<string>()
  const dispatched: AgentModuleCommand[] = []
  let rejectCancel = true
  const dispatcher = new AgentModuleCommandDispatcher({ bus, cancelQueued: (_sessionId, commandId) => !rejectCancel && queued.delete(commandId) })
  const journal = new AgentRunJournalStore({ resolvePath: (sessionId) => join(sessionRoot, `${sessionId}.run-journal.jsonl`) })
  journal.append({ sessionId: 'smoke-a', runId: 'unfinished-run', branchId: 'smoke-branch', eventType: 'user_turn' })
  journal.append({ sessionId: 'smoke-a', runId: 'unfinished-run', branchId: 'smoke-branch', eventType: 'tool_started', payload: { replaySafe: false, toolName: 'write' } })
  /** 生产 Journal 审计事实。 */
  journal.append({ sessionId: 'smoke-a', runId: 'audit-run', branchId: 'audit', eventType: 'checkpoint', payload: { stage: 'module-context', sessionId: 'smoke-a', policyMode: 'pinned', policyRevision: 4, modules: [{ moduleId: 'canvas', moduleVersion: '1.2.3', mode: 'pinned', skillRefs: ['canvas-production'], promptRefs: [], declaredCapabilities: ['canvas.document'], sessionId: 'smoke-a', policyRevision: 4, activatedAt: 1 }], unavailable: [] } })
  journal.append({ sessionId: 'smoke-a', runId: 'audit-run', branchId: 'audit', eventType: 'run_completed' })
  /** 缺少 artifact 的运行只能弃置；真实续接由 utility smoke 验证。 */
  const recovery = new AgentRunRecoveryService({ journal, isBusy: () => false, getSession: () => null, validateContinuation: () => { throw new Error('不得续接无 artifact 运行') }, assertContextCurrent: () => undefined })
  let failApply = true
  let recoveryApplies = 0
  const host = new AgentPluginHost()
  const lifecycle: string[] = []
  for (const registration of createBuiltinAgentPluginRegistrations(listBuiltinAgentModules(), {
    canvas: { start: () => { lifecycle.push('start') }, stop: () => { lifecycle.push('stop') }, dispose: () => { lifecycle.push('dispose') } },
  })) await host.register(registration)
  await host.start()
  assert.ok(host.listHealth().every((health) => health.state === 'running'))
  let failCatalog = true
  let failRecovery = true
  /** 延迟旧会话读取，用于验证切会话后的过期响应不会污染新会话。 */
  let delayRecoveryRead = false
  let releaseRecoveryRead: (() => void) | undefined
  ipcMain.handle(AGENT_IPC_CHANNELS.GET_AGENT_MODULES, () => { if (failCatalog) throw new Error('SMOKE_CATALOG_UNAVAILABLE'); return registry.listModules() })
  ipcMain.handle(AGENT_IPC_CHANNELS.GET_AGENT_PLUGIN_CATALOG, () => management.snapshot())
  ipcMain.handle(AGENT_IPC_CHANNELS.PREVIEW_AGENT_PLUGIN, () => management.preview(candidatePath))
  ipcMain.handle(AGENT_IPC_CHANNELS.INSTALL_AGENT_PLUGIN, (_event, token: string) => management.install(token))
  ipcMain.handle(AGENT_IPC_CHANNELS.REFRESH_AGENT_PLUGINS, () => management.refresh())
  ipcMain.handle(AGENT_IPC_CHANNELS.UNINSTALL_AGENT_PLUGIN, (_event, pluginId: string) => management.uninstall(pluginId))
  ipcMain.handle(AGENT_IPC_CHANNELS.GET_AGENT_MODULE_RUN_AUDITS, (_event, query: AgentModuleRunAuditQuery) => buildAgentModuleRunAudits(query.sessionId, journal.read(query.sessionId), query))
  ipcMain.handle(AGENT_IPC_CHANNELS.APPLY_AGENT_RUN_RECOVERY, (_event, input: AgentRunRecoveryInput) => {
    recoveryApplies += 1
    if (failApply) throw new Error('SMOKE_APPLY_UNAVAILABLE')
    return recovery.apply(input, async () => { throw new Error('不得调用模型') })
  })
  ipcMain.handle(AGENT_IPC_CHANNELS.GET_AGENT_PLUGIN_HEALTH, () => host.listHealth())
  ipcMain.handle(AGENT_IPC_CHANNELS.GET_SESSION_MODULE_POLICY, (_event, sessionId: string) => { policyReads.push(sessionId); return getPolicy(sessionId) })
  ipcMain.handle(AGENT_IPC_CHANNELS.SET_SESSION_MODULE_POLICY, (_event, input: AgentSessionModulePolicyUpdateInput) => {
    const next = buildNextSessionModulePolicy(getPolicy(input.sessionId), input.policy, { expectedRevision: input.expectedRevision })
    writeJsonFileAtomic(join(sessionRoot, `${input.sessionId}.policy.json`), next)
    policies.set(input.sessionId, next)
    return next
  })
  ipcMain.handle(AGENT_IPC_CHANNELS.SUBMIT_AGENT_MODULE_COMMAND, (_event, input: AgentModuleCommandInput) => dispatcher.submit(input, async (command) => {
    dispatched.push(command); queued.add(command.commandId)
  }))
  ipcMain.handle(AGENT_IPC_CHANNELS.GET_AGENT_MODULE_COMMANDS, (_event, input: { sessionId: string }) => bus.list(input.sessionId))
  ipcMain.handle(AGENT_IPC_CHANNELS.CANCEL_AGENT_MODULE_COMMAND, (_event, input: { sessionId: string; commandId: string }) => dispatcher.cancel(input))
  ipcMain.handle(AGENT_IPC_CHANNELS.GET_AGENT_RUN_RECOVERY_PLANS, (_event, sessionId: string) => {
    if (failRecovery) throw new Error('SMOKE_RECOVERY_UNAVAILABLE')
    const plans = recovery.list(sessionId)
    if (delayRecoveryRead && sessionId === 'smoke-a') return new Promise<AgentRunRecoveryPlan[]>((resolve) => {
      releaseRecoveryRead = () => resolve(plans)
    })
    return plans
  })
  const window = new BrowserWindow({ width: 1080, height: 820, show: true, webPreferences: {
    preload: join(buildDir, 'preload', 'index.js'), contextIsolation: true, nodeIntegration: false, sandbox: true,
  } })
  const rendererErrors: string[] = []
  window.webContents.on('console-message', (_event, level, message) => { if (level >= 3 && !message.includes('SMOKE_')) rendererErrors.push(message) })
  try {
    await window.loadFile(join(buildDir, 'ui', htmlName))
    await waitFor(window, `document.body.textContent.includes('重试模块加载') && document.body.textContent.includes('重试模块目录')`)
    failCatalog = false
    await clickText(window, '重试模块加载')
    await clickText(window, '重试模块目录')
    await waitFor(window, `document.querySelectorAll('article').length===6 && !document.querySelector('[aria-label="正在加载模块"]')`)
    await clickText(window, '画布')
    await waitFor(window, `document.querySelector('[data-testid="agent-module-bar"] button')?.getAttribute('aria-pressed')==='true'`)
    assert.deepEqual(getPolicy('smoke-a').enabledModuleIds, ['canvas'])
    assert.equal(dispatched.length, 0, '启用模块不能自动派发命令')
    await click(window, '[data-testid="switch-session"]')
    await waitFor(window, `document.querySelector('[data-testid="session-id"]').textContent==='smoke-b' && !document.querySelector('[aria-label="正在加载模块"]')`)
    assert.ok(policyReads.includes('smoke-b'))
    assert.equal(await window.webContents.executeJavaScript(`document.querySelector('[data-testid="agent-module-bar"] button').getAttribute('aria-pressed')`), 'false')
    await clickText(window, '画布')
    await waitFor(window, `!document.querySelector('[aria-label="正在加载模块"]') && document.querySelector('[data-testid="agent-module-bar"] button').getAttribute('aria-pressed')==='true'`)
    assert.ok(!getPolicy('smoke-b').disabledModuleIds.includes('canvas'))
    assert.deepEqual(getPolicy('smoke-a').enabledModuleIds, ['canvas'])
    assert.deepEqual(JSON.parse(readFileSync(join(sessionRoot, 'smoke-b.policy.json'), 'utf8')).enabledModuleIds, ['browser', 'canvas'])
    await click(window, '[aria-label="显示全部模块"]')
    await waitFor(window, `document.querySelector('[role="dialog"]')?.textContent.includes('示例模块')`)
    window.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Escape' })
    window.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Escape' })
    await waitFor(window, `!document.querySelector('[role="dialog"]')`)
    await click(window, '[data-testid="submit-command"]')
    await waitFor(window, `document.querySelector('[data-testid="submit-result"]').dataset.count==='1'`)
    await waitFor(window, `document.querySelector('[data-testid="agent-module-command-receipt"]')?.textContent.includes('已排队')`)
    assert.equal(dispatched.length, 1)
    assert.equal(dispatched[0]?.requestSummary, '创建节点')
    await click(window, '[data-testid="submit-command"]')
    await waitFor(window, `document.querySelector('[data-testid="submit-result"]').dataset.count==='2'`)
    assert.equal(dispatched.length, 1)
    await click(window, '[aria-label="取消模块命令"]')
    await waitFor(window, `document.querySelector('[data-testid="agent-module-command-error"]')?.textContent.includes('取消失败')`)
    assert.equal(queued.size, 1)
    assert.equal(bus.list('smoke-b')[0]?.status, 'queued')
    rejectCancel = false
    await clickText(window, '重试取消')
    await waitFor(window, `document.querySelector('[data-testid="agent-module-command-receipt"]')?.textContent.includes('已取消')`)
    assert.equal(queued.size, 0)
    // 重建总线验证持久化的幂等键不会重新派发。
    const reopened = new AgentModuleCommandDispatcher({ bus: new AgentModuleCommandBus({ getModule: (id) => registry.getModule(id), getPolicy, store }), cancelQueued: () => false })
    await reopened.submit(dispatched[0]!, async () => { throw new Error('不得重新派发') })
    await click(window, '[data-testid="switch-session"]')
    await waitFor(window, `document.querySelector('[data-testid="agent-run-recovery-error"]')`)
    failRecovery = false
    await clickText(window, '重新检查运行记录')
    await waitFor(window, `document.querySelector('[data-testid="agent-run-recovery-notice"]')?.textContent.includes('未完成运行')`)
    assert.equal(await window.webContents.executeJavaScript(`document.body.textContent.includes('重新发送上一条消息')`), false)
    await click(window, '[data-testid="toggle-running"]')
    await waitFor(window, `!document.querySelector('[data-testid="agent-run-recovery-notice"]')`)
    await click(window, '[data-testid="toggle-running"]')
    await waitFor(window, `document.querySelector('[data-testid="agent-run-recovery-notice"]')`)
    // 发起旧会话请求后切换，释放旧响应不能把旧运行显示到新会话。
    delayRecoveryRead = true
    await clickText(window, '重新检查运行记录')
    await waitFor(window, `document.body.textContent.includes('正在检查未完成运行')`)
    assert.ok(releaseRecoveryRead)
    await click(window, '[data-testid="switch-session"]')
    await waitFor(window, `document.querySelector('[data-testid="session-id"]').textContent==='smoke-b' && !document.body.textContent.includes('正在检查未完成运行')`)
    releaseRecoveryRead()
    delayRecoveryRead = false
    await window.webContents.executeJavaScript(`new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))`)
    assert.equal(await window.webContents.executeJavaScript(`Boolean(document.querySelector('[data-testid="agent-run-recovery-notice"]'))`), false)
    await click(window, '[data-testid="switch-session"]')
    await waitFor(window, `document.querySelector('[data-testid="agent-run-recovery-notice"]')`)
    // 二次确认前不提交，失败后重新检查，以真实 CAS 弃置确切运行。
    await clickText(window, '保留日志并放弃此运行')
    assert.equal(recoveryApplies, 0)
    await clickText(window, '确认放弃此运行')
    await waitFor(window, `document.body.textContent.includes('操作未完成')`)
    assert.equal(journal.scanRecovery('smoke-a').length, 1)
    failApply = false
    await clickText(window, '重新检查运行记录')
    await waitFor(window, `document.querySelector('[data-testid="agent-run-recovery-notice"]')`)
    await clickText(window, '确认放弃此运行')
    await waitFor(window, `!document.querySelector('[data-testid="agent-run-recovery-notice"]')`)
    assert.equal(recoveryApplies, 2)
    assert.equal(journal.scanRecovery('smoke-a').length, 0)
    await clickText(window, '模块与工具审计')
    await waitFor(window, `document.querySelector('[aria-label="运行 audit-run"]')?.textContent.includes('canvas @1.2.3')`)
    await clickText(window, '模块与工具审计')
    await clickText(window, '安装本地插件')
    await waitFor(window, `document.querySelector('[role="dialog"]')?.textContent.includes('Skill 文件不会随清单安装')`)
    assert.equal(registry.getModule('smoke-installed'), undefined)
    await clickText(window, '确认安装')
    await waitFor(window, `document.querySelectorAll('article').length===7 && !document.querySelector('[role="dialog"]')`)
    assert.ok(registry.getModule('smoke-installed'))
    await window.webContents.executeJavaScript(`[...document.querySelectorAll('article')].find(node=>node.textContent.includes('新安装模块')).setAttribute('data-smoke-plugin','installed')`)
    await click(window, '[data-smoke-plugin="installed"] summary')
    await waitFor(window, `document.querySelector('[data-smoke-plugin="installed"]').innerText.includes('canvas-production：可用') && document.querySelector('[data-smoke-plugin="installed"]').innerText.includes('disabled-skill：已禁用') && document.querySelector('[data-smoke-plugin="installed"]').innerText.includes('missing-skill：缺失')`)
    await clickText(window, '刷新插件目录')
    await click(window, '[data-smoke-plugin="installed"] button')
    assert.ok(registry.getModule('smoke-installed'))
    await clickText(window, '确认卸载')
    await waitFor(window, `document.querySelectorAll('article').length===6`)
    assert.equal(registry.getModule('smoke-installed'), undefined)
    window.webContents.send(AGENT_IPC_CHANNELS.AGENT_PLUGIN_HEALTH_CHANGED, { ...host.listHealth()[0], state: 'failed' })
    await waitFor(window, `document.body.textContent.includes('启动失败') && document.body.textContent.includes('1 个模块需要处理')`)
    window.setSize(420, 820)
    await window.webContents.executeJavaScript(`document.documentElement.classList.add('dark')`)
    await click(window, '[aria-label="显示全部模块"]')
    await waitFor(window, `document.querySelector('[role="dialog"]')?.textContent.includes('终端')`)
    await window.webContents.executeJavaScript(`Promise.all(document.getAnimations().filter(animation=>Number.isFinite(animation.effect?.getComputedTiming().endTime)).map(animation=>animation.finished.catch(()=>undefined))).then(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))))`)
    assert.equal(await window.webContents.executeJavaScript(`document.querySelector('[data-testid="agent-module-bar"]').scrollWidth <= document.querySelector('[data-testid="agent-module-bar"]').clientWidth`), true, '窄窗口模块栏溢出')
    writeFileSync(join(dataRoot, 'module-ui-dark.png'), (await window.webContents.capturePage()).toPNG())
    assert.deepEqual(rendererErrors, [])
    console.log('[Agent module UI smoke] PASS: 生产组件/preload、目录重试、会话策略、输入解析、幂等派发、队列夹具取消、回执刷新、真实安装/刷新/卸载、依赖诊断、Journal 审计、恢复失败重试及二次确认弃置、健康事件与 Popover；文件选择器和队列为夹具，未调用 Pi/模型')
  } finally {
    window.destroy()
    await host.dispose()
    assert.deepEqual(lifecycle, ['start', 'stop', 'dispose'])
  }
}

/** 启动有界子进程，退出后才允许清理目录。 */
async function runChild(command: string, arguments_: string[], env: NodeJS.ProcessEnv): Promise<void> {
  const child = spawn(command, arguments_, { cwd: process.cwd(), env, stdio: 'inherit' })
  await new Promise<void>((resolve, reject) => {
    let timedOut = false
    const timeout = setTimeout(() => { timedOut = true; child.kill('SIGKILL') }, 90_000)
    child.once('error', (error) => { clearTimeout(timeout); reject(error) })
    child.once('exit', (code) => { clearTimeout(timeout); code === 0 && !timedOut ? resolve() : reject(new Error(`smoke 子进程退出 ${code}，超时=${timedOut}`)) })
  })
}

/** 构建当前源码，以 file:// 加载，无需端口或真实用户配置。 */
async function orchestrate(): Promise<void> {
  const parentRoot = process.argv.find((argument) => argument.startsWith('--data-root='))?.slice('--data-root='.length) ?? tmpdir()
  mkdirSync(parentRoot, { recursive: true })
  const dataRoot = mkdtempSync(join(realpathSync(parentRoot), 'dutydeck-module-ui-'))
  const buildDir = mkdtempSync(join(tmpdir(), 'dutydeck-module-ui-build-'))
  const htmlName = `.agent-module-smoke-${process.pid}.html`
  const fixtureHtml = join(process.cwd(), 'scripts', htmlName)
  try {
    writeFileSync(fixtureHtml, '<!doctype html><html lang="zh-CN"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Agent module smoke</title></head><body><div id="root"></div><script type="module" src="./agent-module-plugin-smoke-renderer.tsx"></script></body></html>')
    const { build: buildVite } = await import('vite')
    await buildVite({ configFile: join(process.cwd(), 'vite.config.ts'), root: join(process.cwd(), 'scripts'), build: { outDir: join(buildDir, 'ui'), rollupOptions: { input: fixtureHtml }, emptyOutDir: true } })
    const mainBuild = await Bun.build({ entrypoints: [__filename], outdir: join(buildDir, 'main'), target: 'node', format: 'cjs', external: ['electron', 'vite'] })
    const preloadBuild = await Bun.build({ entrypoints: [join(process.cwd(), 'src/preload/index.ts')], outdir: join(buildDir, 'preload'), target: 'node', format: 'cjs', external: ['electron'] })
    if (!mainBuild.success || !preloadBuild.success || !mainBuild.outputs[0]) throw new Error(`smoke 构建失败：${[...mainBuild.logs, ...preloadBuild.logs].join('\n')}`)
    const env: NodeJS.ProcessEnv = { ...process.env, [CHILD_ENV]: '1', DUTYDECK_MODULE_SMOKE_ROOT: dataRoot, DUTYDECK_MODULE_SMOKE_BUILD: buildDir, DUTYDECK_MODULE_SMOKE_HTML: htmlName }
    delete env.ELECTRON_RUN_AS_NODE
    await runChild(process.env.PROMA_ELECTRON_PATH ?? join(process.cwd(), 'node_modules/.bin/electron'), [mainBuild.outputs[0].path], env)
    console.log(`[Agent module UI smoke] 证据目录：${dataRoot}`)
  } finally {
    rmSync(fixtureHtml, { force: true })
    rmSync(buildDir, { recursive: true, force: true })
  }
}

if (process.env[CHILD_ENV] === '1') {
  const { app } = require('electron') as typeof import('electron')
  const { DUTYDECK_MODULE_SMOKE_ROOT: dataRoot, DUTYDECK_MODULE_SMOKE_BUILD: buildDir, DUTYDECK_MODULE_SMOKE_HTML: htmlName } = process.env
  if (!dataRoot || !buildDir || !htmlName) throw new Error('缺少 smoke 隔离路径')
  void runSmoke(dataRoot, buildDir, htmlName).then(() => app.quit()).catch((cause: unknown) => { console.error(cause); app.exit(1) })
} else {
  void orchestrate().catch((cause: unknown) => { console.error(cause); process.exitCode = 1 })
}
