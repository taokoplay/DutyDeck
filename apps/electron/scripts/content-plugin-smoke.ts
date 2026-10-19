import { strict as assert } from 'node:assert'
import { spawn } from 'node:child_process'
import { generateKeyPairSync } from 'node:crypto'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { BrowserWindow } from 'electron'
import { AGENT_IPC_CHANNELS, normalizeAgentSessionModulePolicy } from '@dutydeck/shared'
import { createStandardPluginFiles, createPluginPackage } from '@dutydeck/plugin-kit'
import { AgentPluginRegistry } from '../src/main/lib/agent-modules/plugin-registry'
import { listBuiltinAgentModules } from '../src/main/lib/agent-modules/module-registry'
import { DataRootInstanceLeaseRegistry } from '../src/main/lib/data-root-instance-lease'

/** 子进程只加载临时构建与临时数据。 */
const CHILD_ENV = 'DUTYDECK_CONTENT_UI_SMOKE_CHILD'

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


/** 生产组件、preload、IPC 和管理器集成，只有文件选择结果为夹具。 */
async function runSmoke(dataRoot: string, buildDir: string, htmlName: string): Promise<void> {
  const { app, BrowserWindow, ipcMain } = require('electron') as typeof import('electron')
  app.setPath('userData', join(dataRoot, 'electron-user-data'))
  app.on('window-all-closed', () => undefined)
  await app.whenReady()
  /** 使用真实协议但隔离用户目录。 */
  const registry = new AgentPluginRegistry()
  registry.registerBuiltinModules(listBuiltinAgentModules())
  const leases = new DataRootInstanceLeaseRegistry({ homeDir: dataRoot })
  let selectedVersion = '1.0.0'
  let busy = false
  /** 只对隔离目录注入读取故障，验证页面真实重试流程。 */
  let failCatalogReads = false
  const { registerContentPluginIpc } = await import('../src/main/lib/agent-plugins/content-plugin-ipc')
  ipcMain.handle(AGENT_IPC_CHANNELS.GET_AGENT_MODULES, () => {
    if (failCatalogReads) throw new Error('内置目录读取故障验收')
    return registry.listModules()
  })
  ipcMain.handle(AGENT_IPC_CHANNELS.GET_AGENT_PLUGIN_HEALTH, () => [])
  ipcMain.handle(AGENT_IPC_CHANNELS.GET_SESSION_MODULE_POLICY, () => normalizeAgentSessionModulePolicy(undefined))
  const window = new BrowserWindow({ width: 1000, height: 850, show: true, webPreferences: { preload: join(buildDir, 'preload', 'index.js'), contextIsolation: true, nodeIntegration: false, sandbox: true } })
  /** 捕获未预期的页面异常。 */
  const errors: string[] = []
  window.webContents.on('console-message', (_event, level, message) => { if (level >= 3) errors.push(message) })
  /** 键盘关闭必须经过真实事件。 */
  const escape = (): void => {
    window.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Escape' })
    window.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Escape' })
  }
  /** 菜单必须反映变更广播后的目录。 */
  const checkMenu = async (present: boolean): Promise<void> => {
    await click(window, '[aria-label="选择模块"]')
    await waitFor(window, `document.querySelector('[role="dialog"]') && document.querySelector('[role="dialog"]').textContent.includes('内容验收模块')===${present}`)
    escape()
    await waitFor(window, `!document.querySelector('[role="dialog"]')`)
  }
  try {
    await window.loadFile(join(buildDir, 'ui', htmlName))
    /** 模拟旧主进程缺少新接口：读取失败必须结束加载，且不能伪装成空目录。 */
    await waitFor(window, `document.querySelector('[role="alert"]')`)
    assert.equal(await window.webContents.executeJavaScript(`document.body.textContent.includes('正在读取插件')`), false)
    assert.equal(await window.webContents.executeJavaScript(`document.body.textContent.includes('尚未安装内容插件')`), false)
    assert.match(await window.webContents.executeJavaScript(`document.querySelector('[role="alert"]').textContent`), /重启应用/)
    assert.equal(await window.webContents.executeJavaScript(`[...document.querySelectorAll('button')].find(node=>node.textContent==='从本地包安装 / 更新').disabled`), true)
    /** 接回生产处理器后，通过页面刷新恢复；旧错误必须清除。 */
    registerContentPluginIpc(registry, () => busy, { root: join(dataRoot, 'packages'), leases, selectPackage: async () => join(dataRoot, `${selectedVersion}.ddplugin`) })
    await clickText(window, '刷新')
    await waitFor(window, `document.body.textContent.includes('尚未安装内容插件')`)
    assert.equal(await window.webContents.executeJavaScript(`document.querySelector('[role="alert"]')===null`), true)
    /** 内置清单来自真实注册表，基础自动能力不作为可管理插件展示。 */
    await waitFor(window, `document.querySelectorAll('[aria-labelledby="builtin-plugins-title"] article').length===6`)
    assert.deepEqual(await window.webContents.executeJavaScript(`[...document.querySelectorAll('[aria-labelledby="builtin-plugins-title"] article')].map(node=>node.getAttribute('aria-label'))`), ['画布', '影像创作', '交互设计', '服务器运维', '接口工作台', '编排工厂'])
    assert.equal(await window.webContents.executeJavaScript(`document.querySelector('[aria-labelledby="builtin-plugins-title"]').querySelectorAll('button,[role="switch"]').length`), 0)
    await click(window, '[aria-labelledby="builtin-plugins-title"] article[aria-label="交互设计"] summary')
    await waitFor(window, `document.querySelector('article[aria-label="交互设计"] details').open`)
    assert.match(await window.webContents.executeJavaScript(`document.querySelector('article[aria-label="交互设计"]').innerText`), /interaction-design.system.v1/)
    /** macOS 鼠标点击不保证键盘焦点；聚焦原生 summary 后验证空格折叠，不改变消息选择。 */
    await window.webContents.executeJavaScript(`document.querySelector('article[aria-label="交互设计"] summary').focus()`)
    assert.equal(await window.webContents.executeJavaScript(`document.activeElement===document.querySelector('article[aria-label="交互设计"] summary')`), true)
    window.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Space' })
    window.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Space' })
    await waitFor(window, `!document.querySelector('article[aria-label="交互设计"] details').open`)
    assert.equal(await window.webContents.executeJavaScript(`document.querySelector('[data-testid="draft"]').textContent`), '')
    window.setSize(420, 820)
    for (const dark of [false, true]) {
      await window.webContents.executeJavaScript(`document.documentElement.classList.toggle('dark', ${dark}); document.querySelector('#builtin-plugins-title').scrollIntoView({block:'start'}); Promise.all(document.getAnimations().filter(animation=>Number.isFinite(animation.effect?.getComputedTiming().endTime)).map(animation=>animation.finished.catch(()=>undefined)))`)
      assert.equal(await window.webContents.executeJavaScript(`document.documentElement.scrollWidth<=innerWidth`), true)
      writeFileSync(join(dataRoot, dark ? 'builtin-plugins-dark.png' : 'builtin-plugins-light.png'), (await window.webContents.capturePage()).toPNG())
    }
    window.setSize(1000, 850)
    await checkMenu(false)
    await clickText(window, '从本地包安装 / 更新')
    await waitFor(window, `document.querySelector('[role="dialog"]')?.textContent.includes('签名校验通过')`)
    assert.equal(await window.webContents.executeJavaScript(`[...document.querySelectorAll('button')].find(node=>node.textContent==='信任并安装').disabled`), true)
    assert.equal(registry.listModules().filter(module => module.source === 'installed').length, 0)
    await click(window, '[role="dialog"] input[type="checkbox"]')
    await clickText(window, '信任并安装')
    await waitFor(window, `!document.querySelector('[role="dialog"]') && document.querySelector('[aria-labelledby="content-plugins-title"] article')?.textContent.includes('v1.0.0')`)
    assert.equal(registry.listModules().filter(module => module.source === 'installed').length, 1)
    await checkMenu(true)
    await click(window, '[aria-label="选择模块"]')
    await clickText(window, '内容验收模块')
    escape()
    await waitFor(window, `document.querySelector('[data-testid="draft"]').textContent.includes('smoke.content.assistant')`)
    busy = true
    await clickText(window, '关闭插件')
    await waitFor(window, `document.querySelector('[role="alert"]')?.textContent.includes('正在运行')`)
    assert.equal(registry.listModules().filter(module => module.source === 'installed').length, 1)
    busy = false
    /** 第二个真实 lease 使用同一隔离 home，校验多实例写入屏障。 */
    const otherLease = new DataRootInstanceLeaseRegistry({ homeDir: dataRoot })
    await otherLease.acquire(join(dataRoot, 'packages'))
    try {
      await clickText(window, '关闭插件')
      await waitFor(window, `document.querySelector('[role="alert"]')?.textContent.includes('其他 DutyDeck')`)
      assert.equal(registry.listModules().filter(module => module.source === 'installed').length, 1)
    } finally { otherLease.release() }
    await clickText(window, '关闭插件')
    await waitFor(window, `document.querySelector('[aria-labelledby="content-plugins-title"] article')?.textContent.includes('已关闭')`)
    await checkMenu(false)
    await clickText(window, '启用插件')
    await waitFor(window, `document.querySelector('[aria-labelledby="content-plugins-title"] article')?.textContent.includes('可选择')`)
    await checkMenu(true)
    selectedVersion = '1.1.0'
    await clickText(window, '从本地包安装 / 更新')
    await waitFor(window, `document.querySelector('[role="dialog"]')?.textContent.includes('1.0.0 → 1.1.0')`)
    assert.equal(await window.webContents.executeJavaScript(`document.querySelector('[role="dialog"] input').checked`), false)
    window.setSize(420, 820)
    for (const dark of [false, true]) {
      await window.webContents.executeJavaScript(`document.documentElement.classList.toggle('dark', ${dark}); Promise.all(document.getAnimations().filter(animation=>Number.isFinite(animation.effect?.getComputedTiming().endTime)).map(animation=>animation.finished.catch(()=>undefined)))`)
      assert.equal(await window.webContents.executeJavaScript(`(()=>{const rect=document.querySelector('[role="dialog"]').getBoundingClientRect();return rect.left>=0 && rect.right<=innerWidth && rect.top>=0 && rect.bottom<=innerHeight})()`), true)
      writeFileSync(join(dataRoot, dark ? 'plugin-preview-dark.png' : 'plugin-preview-light.png'), (await window.webContents.capturePage()).toPNG())
    }
    await click(window, '[role="dialog"] input[type="checkbox"]')
    await clickText(window, '确认更新')
    await waitFor(window, `!document.querySelector('[role="dialog"]') && document.querySelector('[aria-labelledby="content-plugins-title"] article')?.textContent.includes('v1.1.0')`)
    await clickText(window, '刷新')
    await waitFor(window, `document.querySelector('[aria-labelledby="content-plugins-title"] article')?.textContent.includes('v1.1.0')`)
    assert.match(await window.webContents.executeJavaScript(`window.electronAPI.setContentPluginEnabled('smoke.content','yes',0).then(()=>'',error=>error.message)`), /插件开关无效/)
    await clickText(window, '卸载')
    await waitFor(window, `document.querySelector('[role="dialog"]')?.textContent.includes('卸载插件')`)
    escape()
    await waitFor(window, `!document.querySelector('[role="dialog"]')`)
    assert.equal(registry.listModules().filter(module => module.source === 'installed').length, 1)
    await clickText(window, '卸载')
    await clickText(window, '确认卸载')
    await waitFor(window, `!document.querySelector('[role="dialog"]') && document.body.textContent.includes('尚未安装内容插件')`)
    await checkMenu(false)
    assert.equal(registry.listModules().filter(module => module.source === 'installed').length, 0)
    assert.equal(registry.listModules().filter(module => module.source === 'builtin').length, 8)
    /** 页面重开后目录首次读取失败，不得假装无内置模块，恢复后重试应重新展示。 */
    failCatalogReads = true
    await window.loadFile(join(buildDir, 'ui', htmlName))
    await waitFor(window, `document.querySelector('[aria-labelledby="builtin-plugins-title"] [role="alert"]')`)
    assert.equal(await window.webContents.executeJavaScript(`document.querySelector('[aria-labelledby="builtin-plugins-title"]').textContent.includes('正在读取内置模块')`), false)
    assert.equal(await window.webContents.executeJavaScript(`document.querySelector('[aria-labelledby="builtin-plugins-title"]').textContent.includes('暂无内置专业模块')`), false)
    await waitFor(window, `document.querySelector('[aria-labelledby="content-plugins-title"]').textContent.includes('尚未安装内容插件')`)
    failCatalogReads = false
    await clickText(window, '重试读取内置模块')
    await waitFor(window, `document.querySelectorAll('[aria-labelledby="builtin-plugins-title"] article').length===6 && !document.querySelector('[aria-labelledby="builtin-plugins-title"] [role="alert"]')`)
    writeFileSync(join(dataRoot, 'plugin-uninstalled.png'), (await window.webContents.capturePage()).toPNG())
    assert.deepEqual(errors, [])
    console.log('[Content plugin UI smoke] PASS: 六个内置模块及资源详情/键盘折叠/真实 preload/IPC/读取失败重试/签名安装与信任门禁/消息模块选择/忙时拒绝/关闭启用广播/版本更新/刷新/非法参数拒绝/卸载与Escape取消/浅深色窄窗；未调用模型，文件选择结果为夹具。')
  } finally { window.destroy(); leases.release() }
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
  const dataRoot = mkdtempSync(join(realpathSync(parentRoot), 'dutydeck-content-ui-'))
  const buildDir = mkdtempSync(join(tmpdir(), 'dutydeck-content-ui-build-'))
  const htmlName = `.content-plugin-smoke-${process.pid}.html`
  const fixtureHtml = join(process.cwd(), 'scripts', htmlName)
  try {
    /** 同一发布密钥签署两个版本，升级必须通过正式包校验。 */
    const { privateKey } = generateKeyPairSync('ed25519')
    for (const version of ['1.0.0', '1.1.0']) {
      const files = createStandardPluginFiles('smoke.content', '内容插件验收')
      const manifest = JSON.parse(Buffer.from(files.get('plugin.json')!).toString())
      manifest.version = version
      manifest.modules[0].displayName = '内容验收模块'
      files.set('plugin.json', Buffer.from(JSON.stringify(manifest)))
      writeFileSync(join(dataRoot, `${version}.ddplugin`), createPluginPackage(files, privateKey))
    }
    writeFileSync(fixtureHtml, '<!doctype html><html lang="zh-CN"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Agent module smoke</title></head><body><div id="root"></div><script type="module" src="./content-plugin-smoke-renderer.tsx"></script></body></html>')
    const { build: buildVite } = await import('vite')
    await buildVite({ configFile: join(process.cwd(), 'vite.config.ts'), root: join(process.cwd(), 'scripts'), build: { outDir: join(buildDir, 'ui'), rollupOptions: { input: fixtureHtml }, emptyOutDir: true } })
    const mainBuild = await Bun.build({ entrypoints: [__filename], outdir: join(buildDir, 'main'), target: 'node', format: 'cjs', external: ['electron', 'vite'] })
    const preloadBuild = await Bun.build({ entrypoints: [join(process.cwd(), 'src/preload/index.ts')], outdir: join(buildDir, 'preload'), target: 'node', format: 'cjs', external: ['electron'] })
    if (!mainBuild.success || !preloadBuild.success || !mainBuild.outputs[0]) throw new Error(`smoke 构建失败：${[...mainBuild.logs, ...preloadBuild.logs].join('\n')}`)
    const env: NodeJS.ProcessEnv = { ...process.env, [CHILD_ENV]: '1', DUTYDECK_CONTENT_SMOKE_ROOT: dataRoot, DUTYDECK_CONTENT_SMOKE_BUILD: buildDir, DUTYDECK_CONTENT_SMOKE_HTML: htmlName }
    delete env.ELECTRON_RUN_AS_NODE
    await runChild(process.env.PROMA_ELECTRON_PATH ?? join(process.cwd(), 'node_modules/.bin/electron'), [mainBuild.outputs[0].path], env)
    console.log(`[Content plugin UI smoke] 证据目录：${dataRoot}`)
  } finally {
    rmSync(fixtureHtml, { force: true })
    rmSync(buildDir, { recursive: true, force: true })
  }
}

if (process.env[CHILD_ENV] === '1') {
  const { app } = require('electron') as typeof import('electron')
  const { DUTYDECK_CONTENT_SMOKE_ROOT: dataRoot, DUTYDECK_CONTENT_SMOKE_BUILD: buildDir, DUTYDECK_CONTENT_SMOKE_HTML: htmlName } = process.env
  if (!dataRoot || !buildDir || !htmlName) throw new Error('缺少 smoke 隔离路径')
  void runSmoke(dataRoot, buildDir, htmlName).then(() => app.quit()).catch((cause: unknown) => { console.error(cause); app.exit(1) })
} else {
  void orchestrate().catch((cause: unknown) => { console.error(cause); process.exitCode = 1 })
}
