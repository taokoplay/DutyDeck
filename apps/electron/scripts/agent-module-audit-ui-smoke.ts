import { strict as assert } from 'node:assert'
import { spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { BrowserWindow } from 'electron'
import { AGENT_IPC_CHANNELS } from '@dutydeck/shared'
import type { AgentModuleRunAudit, AgentModuleRunAuditQuery } from '@dutydeck/shared'

/** 独立 Electron 子进程标志，避免加载真实应用入口。 */
const CHILD_ENV = 'DUTYDECK_AUDIT_UI_SMOKE_CHILD'

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


/** 构造长列表与多模块事实；只有 IPC 返回值是夹具，UI 和 preload 均为生产代码。 */
function makeAudit(runId: string): AgentModuleRunAudit {
  return {
    sessionId: 'audit-a', runId, policyMode: 'available', policyRevision: 3,
    startedAt: 1792370603338, status: 'completed', truncated: true,
    modules: ['interaction-design', 'canvas'].map((moduleId, index) => ({
      moduleId, displayName: index === 0 ? '交互设计' : '画布', moduleVersion: '1.0.0',
      mode: 'available', invocationMode: 'invoke', skillRefs: [`${moduleId}-skill`], promptRefs: [`${moduleId}.system.v1`],
      declaredCapabilities: [`${moduleId}.read`, `${moduleId}.propose`], activatedAt: 1792370603338,
      sessionId: 'audit-a', policyRevision: 3,
    })),
    unavailable: [],
    activatedSkills: ['interaction-design', 'canvas'].map(moduleId => ({ slug: `${moduleId}-skill`, moduleId, moduleVersion: '1.0.0', activationMode: 'invoke' })),
    tools: Array.from({ length: 128 }, (_, index) => ({
      toolUseId: `tool-${index}`, toolName: index < 100 ? 'Bash' : 'prototype_read',
      status: index === 0 ? 'failed' : index === 1 ? 'started' : 'completed',
    })),
  }
}

/** 等待有限动画结束后检查真实弹层边界，并留下可人工审阅的截图。 */
async function verifyLayout(window: BrowserWindow, dataRoot: string, name: string): Promise<void> {
  await window.webContents.executeJavaScript(`Promise.all(document.getAnimations().filter(animation=>Number.isFinite(animation.effect?.getComputedTiming().endTime)).map(animation=>animation.finished.catch(()=>undefined)))`)
  assert.equal(await window.webContents.executeJavaScript(`(()=>{const dialog=document.querySelector('[role="dialog"]');const rect=dialog.getBoundingClientRect();return rect.left>=0 && rect.right<=innerWidth+1 && rect.top>=0 && rect.bottom<=innerHeight+1 && dialog.scrollWidth<=dialog.clientWidth+1})()`), true, '长记录弹窗不可越界或横向溢出')
  writeFileSync(join(dataRoot, `${name}.png`), (await window.webContents.capturePage()).toPNG())
}

/** 验证真实 Electron 弹窗；只模拟一个审计 IPC，不读取业务数据或运行模型。 */
async function runSmoke(dataRoot: string, buildDir: string, htmlName: string): Promise<void> {
  const { app, BrowserWindow, ipcMain } = require('electron') as typeof import('electron')
  app.setPath('userData', join(dataRoot, 'electron-user-data'))
  app.on('window-all-closed', () => undefined)
  await app.whenReady()
  /** 可控错误/刷新/迟到响应用来验证同一真实组件的数据生命周期。 */
  let fail = true
  let delay = false
  let release: (() => void) | undefined
  const reads: string[] = []
  ipcMain.handle(AGENT_IPC_CHANNELS.GET_AGENT_MODULE_RUN_AUDITS, (_event, query: AgentModuleRunAuditQuery) => {
    reads.push(query.sessionId)
    if (fail) throw new Error('SMOKE_AUDIT_FAILURE')
    const rows = query.sessionId === 'audit-a' ? [makeAudit('latest-run'), { ...makeAudit('old-run'), status: 'failed' as const, modules: [], activatedSkills: [], tools: [], unavailable: [{ moduleId: 'missing-plugin', reason: 'AGENT_MODULE_SKILL_UNAVAILABLE' }] }] : []
    if (delay && query.sessionId === 'audit-a') return new Promise<AgentModuleRunAudit[]>(resolve => { release = () => resolve(rows) })
    return rows
  })
  const window = new BrowserWindow({ width: 1080, height: 820, show: true, webPreferences: {
    preload: join(buildDir, 'preload/index.js'), contextIsolation: true, nodeIntegration: false, sandbox: true,
  } })
  const errors: string[] = []
  window.webContents.on('console-message', (_event, level, message) => { if (level >= 3 && !message.includes('SMOKE_')) errors.push(message) })
  try {
    await window.loadFile(join(buildDir, 'ui', htmlName))
    await waitFor(window, `document.querySelector('[data-testid="open-audit"]')`)
    assert.equal(reads.length, 0, '未打开弹窗不得预读')
    await click(window, '[data-testid="open-audit"]')
    await waitFor(window, `document.querySelector('[role="alert"]')`)
    fail = false
    await clickText(window, '刷新')
    await waitFor(window, `document.querySelector('[aria-label="运行 latest-run"]')`)
    assert.equal(await window.webContents.executeJavaScript(`document.querySelector('[aria-label="运行 latest-run"] button[aria-expanded]').getAttribute('aria-expanded')`), 'true')
    assert.equal(await window.webContents.executeJavaScript(`document.querySelector('[aria-label="运行 old-run"] button[aria-expanded]').getAttribute('aria-expanded')`), 'false')
    assert.equal(await window.webContents.executeJavaScript(`['交互设计','画布','interaction-design-skill','canvas-skill'].every(text=>document.querySelector('[aria-label="运行 latest-run"]').innerText.includes(text))`), true)
    assert.equal(await window.webContents.executeJavaScript(`document.querySelectorAll('[data-testid="audit-tool-summary"]').length`), 2, '128 次工具调用应汇总为两项')
    await waitFor(window, `[...document.querySelectorAll('[data-testid="audit-tool-summary"]')].some(node=>node.innerText.includes('Bash') && node.innerText.includes('98') && node.innerText.includes('未收到结果'))`)
    await verifyLayout(window, dataRoot, 'audit-wide-light')
    await window.webContents.executeJavaScript(`document.documentElement.classList.add('dark')`)
    await verifyLayout(window, dataRoot, 'audit-wide-dark')
    await window.webContents.executeJavaScript(`document.documentElement.classList.remove('dark')`)
    await clickText(window, '只看失败')
    await waitFor(window, `document.querySelector('button[aria-pressed="true"]')`)
    assert.equal(await window.webContents.executeJavaScript(`document.querySelectorAll('[data-testid="audit-tool-summary"]').length`), 1)
    await clickText(window, '只看失败')
    /** 原生折叠用真实鼠标点击，验证明细与诊断在长内容中仍可达。 */
    for (const text of ['查看调用明细', '诊断']) {
      await window.webContents.executeJavaScript(`[...document.querySelectorAll('[aria-label="运行 latest-run"] summary')].find(node=>node.textContent.includes(${JSON.stringify(text)})).setAttribute('data-smoke-summary','target')`)
      await click(window, '[data-smoke-summary="target"]')
      assert.equal(await window.webContents.executeJavaScript(`document.querySelector('[data-smoke-summary="target"]').parentElement.open`), true)
      await verifyLayout(window, dataRoot, text === '诊断' ? 'audit-diagnostics' : 'audit-details')
      await click(window, '[data-smoke-summary="target"]')
      await window.webContents.executeJavaScript(`document.querySelector('[data-smoke-summary="target"]').removeAttribute('data-smoke-summary')`)
    }
    await click(window, '[aria-label="运行 old-run"] button[aria-expanded]')
    await waitFor(window, `document.querySelector('[aria-label="运行 old-run"] button[aria-expanded]').getAttribute('aria-expanded')==='true'`)
    await click(window, '[aria-label="运行 old-run"] button[aria-expanded]')
    await window.webContents.executeJavaScript(`document.querySelector('[data-testid="agent-module-run-audit"]').scrollTop=0`)
    window.setSize(420, 680)
    for (const dark of [false, true]) {
      await window.webContents.executeJavaScript(`document.documentElement.classList.toggle('dark', ${dark})`)
      await verifyLayout(window, dataRoot, dark ? 'audit-narrow-dark' : 'audit-narrow-light')
    }
    delay = true
    await clickText(window, '刷新')
    await waitFor(window, `document.querySelector('[data-testid="agent-module-run-audit"]').getAttribute('aria-busy')==='true'`)
    await window.webContents.executeJavaScript(`window.dispatchEvent(new Event('smoke-switch-session'))`)
    await waitFor(window, `document.querySelector('[data-testid="session-id"]').textContent==='audit-b' && document.body.innerText.includes('暂无调用记录')`)
    assert.ok(release, '旧会话读取必须处于等待中')
    release()
    await window.webContents.executeJavaScript(`new Promise(resolve=>setTimeout(resolve,100))`)
    assert.equal(await window.webContents.executeJavaScript(`Boolean(document.querySelector('[aria-label="运行 latest-run"]'))`), false, '迟到数据不能污染新会话')
    window.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Escape' })
    window.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Escape' })
    await waitFor(window, `!document.querySelector('[role="dialog"]') && document.activeElement?.getAttribute('data-testid')==='open-audit'`)
    assert.deepEqual(errors, [])
    assert.deepEqual(reads, ['audit-a', 'audit-a', 'audit-a', 'audit-b'])
    console.log('[Agent module audit UI smoke] PASS: 长列表聚合、多模块/Skill、失败筛选、历史折叠、明细/诊断、错误刷新、空状态、跨会话迟到隔离、Escape 焦点及深浅色窄窗；仅使用隔离 IPC 夹具，无真实模型调用')
  } finally {
    window.destroy()
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
  const dataRoot = mkdtempSync(join(realpathSync(parentRoot), 'dutydeck-module-audit-ui-'))
  const buildDir = mkdtempSync(join(tmpdir(), 'dutydeck-module-audit-ui-build-'))
  const htmlName = `.agent-module-audit-smoke-${process.pid}.html`
  const fixtureHtml = join(process.cwd(), 'scripts', htmlName)
  try {
    writeFileSync(fixtureHtml, '<!doctype html><html lang="zh-CN"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Agent module smoke</title></head><body><div id="root"></div><script type="module" src="./agent-module-audit-ui-smoke-renderer.tsx"></script></body></html>')
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
