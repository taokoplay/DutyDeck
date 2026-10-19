import { strict as assert } from 'node:assert'
import { spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { BrowserWindow } from 'electron'
import { AGENT_IPC_CHANNELS } from '@dutydeck/shared'
import { listBuiltinAgentModules } from '../src/main/lib/agent-modules/module-registry'

/** 独立 Electron 子进程标志，避免加载真实应用入口。 */
const CHILD_ENV = 'DUTYDECK_PROFESSIONAL_UI_SMOKE_CHILD'

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


/** 检查真实弹层边界并保存截图。 */
async function verifyLayout(window: BrowserWindow, dataRoot: string, name: string): Promise<void> {
  await window.webContents.executeJavaScript(`Promise.all(document.getAnimations().filter(animation=>Number.isFinite(animation.effect?.getComputedTiming().endTime)).map(animation=>animation.finished.catch(()=>undefined)))`)
  assert.equal(await window.webContents.executeJavaScript(`(()=>{const rect=document.querySelector('[role="dialog"]').getBoundingClientRect();return rect.left>=0 && rect.right<=innerWidth+1 && rect.top>=0 && rect.bottom<=innerHeight+1 && document.documentElement.scrollWidth<=innerWidth+1})()`), true, '模块菜单和页面不可越界')
  writeFileSync(join(dataRoot, `${name}.png`), (await window.webContents.capturePage()).toPNG())
}

/** 真实组件与 preload，只模拟目录和策略 IPC，不读取真实业务数据。 */
async function runSmoke(dataRoot: string, buildDir: string, htmlName: string): Promise<void> {
  const { app, BrowserWindow, ipcMain } = require('electron') as typeof import('electron')
  app.setPath('userData', join(dataRoot, 'electron-user-data'))
  app.on('window-all-closed', () => undefined)
  await app.whenReady()
  /** 使用源码目录并加入未来插件，验证默认手动分类。 */
  const modules = listBuiltinAgentModules()
  modules.push({ ...modules[0]!, id: 'vendor.custom', displayName: '已安装专业插件', source: 'installed', pluginId: 'vendor.custom' })
  ipcMain.handle(AGENT_IPC_CHANNELS.GET_AGENT_MODULES, () => modules)
  ipcMain.handle(AGENT_IPC_CHANNELS.GET_AGENT_PLUGIN_HEALTH, () => [])
  ipcMain.handle(AGENT_IPC_CHANNELS.GET_SESSION_MODULE_POLICY, () => ({ mode: 'auto', enabledModuleIds: ['browser', 'terminal'], disabledModuleIds: [], pinnedModuleIds: [], revision: 1, updatedAt: 1 }))
  const window = new BrowserWindow({ width: 980, height: 800, show: true, webPreferences: {
    preload: join(buildDir, 'preload/index.js'), contextIsolation: true, nodeIntegration: false, sandbox: true,
  } })
  /** 不允许页面可见但组件后台报错的假通过。 */
  const errors: string[] = []
  window.webContents.on('console-message', (_event, level, message) => { if (level >= 3) { errors.push(message); console.error('[renderer]', message) } })
  try {
    await window.loadFile(join(buildDir, 'ui', htmlName))
    await waitFor(window, `document.querySelector('.tiptap')`)
    await click(window, '[aria-label="选择模块"]')
    await waitFor(window, `document.querySelector('[data-module-id="capability-factory"]')`)
    assert.deepEqual(await window.webContents.executeJavaScript(`[...document.querySelectorAll('[data-module-id]')].map(node=>node.dataset.moduleId)`), ['canvas', 'visual-production', 'interaction-design', 'server-ops', 'api-workbench', 'capability-factory', 'vendor.custom'])
    assert.equal(await window.webContents.executeJavaScript(`document.body.innerText.includes('浏览器') || document.body.innerText.includes('终端')`), false)
    await verifyLayout(window, dataRoot, 'professional-wide-light')
    await click(window, '[data-module-id="interaction-design"]')
    await click(window, '[data-module-id="api-workbench"]')
    await waitFor(window, `document.querySelectorAll('[data-mention-reference-type="module"]').length===2`)
    assert.equal(await window.webContents.executeJavaScript(`document.querySelector('[data-testid="message-draft"]').textContent`), '/module:interaction-design /module:api-workbench 请检查当前项目')
    assert.equal(await window.webContents.executeJavaScript(`document.querySelector('.tiptap').textContent.startsWith('交互设计')`), true)
    await click(window, '[data-module-id="interaction-design"]')
    await waitFor(window, `document.querySelectorAll('[data-mention-reference-type="module"]').length===1`)
    assert.equal(await window.webContents.executeJavaScript(`document.querySelector('[data-testid="message-draft"]').textContent`), '/module:api-workbench 请检查当前项目')
    window.setSize(420, 680)
    await waitFor(window, `innerWidth <= 420`)
    await window.webContents.executeJavaScript(`new Promise(resolve=>setTimeout(resolve,250))`)
    // Radix 在窗口缩放导致失焦时可以关闭菜单，重新打开后再验证布局。
    if (!await window.webContents.executeJavaScript(`Boolean(document.querySelector('[role="dialog"]'))`)) await click(window, '[aria-label="选择模块"]')
    await waitFor(window, `document.querySelector('[role="dialog"]')`)
    for (const dark of [false, true]) {
      await window.webContents.executeJavaScript(`document.documentElement.classList.toggle('dark', ${dark})`)
      await verifyLayout(window, dataRoot, dark ? 'professional-narrow-dark' : 'professional-narrow-light')
    }
    window.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Escape' })
    window.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Escape' })
    await waitFor(window, `!document.querySelector('[role="dialog"]')`)
    await click(window, '[data-testid="switch-session"]')
    await waitFor(window, `document.querySelector('[data-testid="session-id"]').textContent==='professional-b' && document.querySelectorAll('[data-mention-reference-type="module"]').length===0`)
    await click(window, '[aria-label="选择模块"]')
    await waitFor(window, `document.querySelector('[data-module-id="api-workbench"]')`)
    assert.equal(await window.webContents.executeJavaScript(`document.querySelectorAll('[data-module-id][aria-pressed="true"]').length`), 0)
    await click(window, '[data-module-id="vendor.custom"]')
    await waitFor(window, `document.querySelector('[data-testid="message-draft"]').textContent==='/module:vendor.custom 新会话要求'`)
    assert.deepEqual(errors, [])
    console.log('[Professional module UI smoke] PASS: 六类专业模块、已安装插件、无浏览器/终端、多选前置 chip、取消选择、跨会话隔离、深浅主题及窄屏；生产组件/preload，无真实模型或业务数据')
  } catch (cause) {
    writeFileSync(join(dataRoot, 'failure.png'), (await window.webContents.capturePage()).toPNG())
    console.error('页面诊断', await window.webContents.executeJavaScript('document.body.innerText'))
    console.error('证据目录', dataRoot)
    throw cause
  } finally { window.destroy() }
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
  const dataRoot = mkdtempSync(join(realpathSync(parentRoot), 'dutydeck-professional-module-ui-'))
  const buildDir = mkdtempSync(join(tmpdir(), 'dutydeck-professional-module-ui-build-'))
  const htmlName = `.agent-professional-module-smoke-${process.pid}.html`
  const fixtureHtml = join(process.cwd(), 'scripts', htmlName)
  try {
    writeFileSync(fixtureHtml, '<!doctype html><html lang="zh-CN"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Agent module smoke</title></head><body><div id="root"></div><script type="module" src="./agent-professional-module-ui-smoke-renderer.tsx"></script></body></html>')
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
