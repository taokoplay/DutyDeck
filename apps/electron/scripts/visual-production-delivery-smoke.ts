import { strict as assert } from 'node:assert'
import { spawn } from 'node:child_process'
import { mkdtemp, rm, writeFile, readFile } from 'node:fs/promises'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { BrowserWindow, DownloadItem } from 'electron'
import { VISUAL_PRODUCTION_CHANNELS } from '@dutydeck/shared'
import type { VisualProductionInputs, VisualProductionMethod, VisualProductionResults } from '@dutydeck/shared'
import { createVisualProductionAccess } from '../src/main/lib/visual-production/access'
import { registerVisualProductionIpc } from '../src/main/lib/visual-production/ipc'
import { VisualProductionService } from '../src/main/lib/visual-production/store'

/** 记录各测试窗口的指针位置，悬浮测试沿真实路径移动，避免跨过 Radix 的过渡判断。 */
const pointerPositions = new WeakMap<BrowserWindow, { x: number; y: number }>()

/** 获取临时端口，避免触及正在运行的开发实例。 */
async function port(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer()
    server.on('error', reject)
    server.listen(0, '127.0.0.1', () => { const address = server.address(); if (!address || typeof address === 'string') return reject(new Error('端口分配失败')); server.close(error => error ? reject(error) : resolve(address.port)) })
  })
}
/** 给单次渲染器执行加主进程截止时间，超时报告步骤以定位失去响应的位置。 */
async function bounded<T>(step: string, operation: Promise<T>): Promise<T> {
  /** 操作结束即清理计时器，不延长测试进程生命周期。 */
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([operation, new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new Error(`渲染器步骤超时：${step}`)), 12000) })])
  } catch (cause) {
    throw new Error(`渲染器步骤失败：${step}`, { cause })
  } finally { if (timer) clearTimeout(timer) }
}
/** DOM 等待有界并输出失败证据。 */
async function wait(window: BrowserWindow, expression: string): Promise<void> {
  const deadline = Date.now() + 12000
  while (Date.now() < deadline) {
    if (await bounded(expression, window.webContents.executeJavaScript(`Boolean(${expression})`))) return
    await new Promise(resolve => setTimeout(resolve, 50))
  }
  throw new Error(`等待失败 ${expression}\n${await bounded('读取失败页面', window.webContents.executeJavaScript('document.body.innerText'))}`)
}
/** 真实 Chromium 鼠标事件，覆盖 Radix 焦点与遮罩。 */
async function click(window: BrowserWindow, selector: string): Promise<void> {
  await wait(window, selector)
  /** 从主进程轮询动画状态，避免窗口被遮挡时依赖未调度的 rAF 挂起。 */
  await wait(window, `!document.getAnimations().some(animation=>Number.isFinite(animation.effect?.getComputedTiming().endTime) && animation.playState === 'running')`)
  await bounded(`滚动到点击目标 ${selector}`, window.webContents.executeJavaScript(`(${selector}).scrollIntoView({block:'nearest'})`))
  /** 等待 Chromium 提交可见帧，防止重载后 DOM 已就绪、鼠标仍命中上一帧。 */
  await bounded(`绘制点击目标 ${selector}`, window.webContents.capturePage())
  await wait(window, `(()=>{const node=${selector};if(!node)return false;const b=node.getBoundingClientRect();return b.width>0 && b.height>0 && node.contains(document.elementFromPoint(b.x+b.width/2,b.y+b.height/2))})()`)
  const point = await bounded(`定位点击目标 ${selector}`, window.webContents.executeJavaScript(`(()=>{const node=${selector};node.scrollIntoView({block:'nearest'});const b=node.getBoundingClientRect();return{x:b.x+b.width/2,y:b.y+b.height/2}})()`))
  window.webContents.debugger.attach('1.3')
  try {
    /** 与交互设计烟测一致，显式同步指针位置与按键状态，避免弹出菜单误判释放事件。 */
    await window.webContents.debugger.sendCommand('Input.dispatchMouseEvent', { type: 'mouseMoved', ...point })
    await window.webContents.debugger.sendCommand('Input.dispatchMouseEvent', { type: 'mousePressed', ...point, button: 'left', buttons: 1, clickCount: 1 })
    await window.webContents.debugger.sendCommand('Input.dispatchMouseEvent', { type: 'mouseReleased', ...point, button: 'left', buttons: 0, clickCount: 1 })
    pointerPositions.set(window, point)
  } finally { window.webContents.debugger.detach() }
}
/** 与鼠标共用 CDP 投递真实按键，避免原生窗口焦点把 Escape 交给外层弹窗。 */
async function pressKey(window: BrowserWindow, key: string, keyCode: number): Promise<void> {
  /** CDP 的 code 使用物理键名，空格的 key 值仍保留真实空白字符。 */
  const code = key === ' ' ? 'Space' : key
  window.webContents.debugger.attach('1.3')
  try {
    await window.webContents.debugger.sendCommand('Input.dispatchKeyEvent', { type: 'keyDown', key, code, windowsVirtualKeyCode: keyCode, ...(key === 'Enter' ? { text: '\r' } : {}) })
    await window.webContents.debugger.sendCommand('Input.dispatchKeyEvent', { type: 'keyUp', key, code, windowsVirtualKeyCode: keyCode })
  } finally { window.webContents.debugger.detach() }
}

/** 按用户可见文字找到按钮。 */
function button(label: string): string { return `[...document.querySelectorAll('button')].find(node=>node.textContent.trim()===${JSON.stringify(label)})` }
/** 按无障碍名称定位操作，不依赖内部媒体 ID。 */
function named(label: string): string { return `document.querySelector('button[aria-label=${JSON.stringify(label)}]')` }
/** 运行真实工作台、IPC 和临时项目；绝不读取用户作品。 */
async function runChild(): Promise<void> {
  const { app, BrowserWindow: Window, ipcMain } = require('electron') as typeof import('electron')
  const root = process.env.VISUAL_SMOKE_DIR!
  app.setPath('userData', join(root, 'user-data'))
  app.on('window-all-closed', () => undefined)
  await app.whenReady()
  const window = new Window({ width: 1000, height: 800, show: true, webPreferences: { preload: join(root, 'visual-production-ui-smoke-preload.js'), backgroundThrottling: false } })
  const errors: string[] = []
  window.webContents.on('console-message', event => { if (event.level === 'error') errors.push(event.message) })
  const service = new VisualProductionService({ projectRoot: join(root, 'project'), workspaceId: 'smoke-project' })
  const reads = new Map<string, number>()
  let failMedia = false
  const access = (assertCaller?: () => void) => createVisualProductionAccess('smoke-session', { resolveSession: () => ({ workspaceId: 'smoke-project', projectRoot: join(root, 'project') }), assertCaller, acquireWriteLease: () => () => undefined, createService: () => ({
    async invoke<M extends VisualProductionMethod>(method: M, input: VisualProductionInputs[M]): Promise<VisualProductionResults[M]> {
      if (method === 'mediaContent') {
        const mediaId = (input as VisualProductionInputs['mediaContent']).mediaId
        reads.set(mediaId, (reads.get(mediaId) ?? 0) + 1)
        if (failMedia) { failMedia = false; throw new Error('测试素材读取失败') }
      }
      return service.invoke(method, input)
    },
  }), onChanged: event => window.webContents.send(VISUAL_PRODUCTION_CHANNELS.CHANGED, event) })
  registerVisualProductionIpc({ ipc: ipcMain, isAuthorizedSender: event => event.sender.id === window.webContents.id, createAccess: (_sessionId, assertCaller) => access(assertCaller) })
  const sessionId = 'smoke-session'
  const created = await access().execute('create', { sessionId, title: '素材导出验收', kind: 'comic' })
  const productionId = created.document.id
  const image = await access().execute('importFile', { sessionId, productionId, relativePath: 'frame.png' })
  const portrait = await access().execute('importFile', { sessionId, productionId, relativePath: 'portrait.png' })
  const clip = await access().execute('importFile', { sessionId, productionId, relativePath: 'clip.mp4' })
  const { schemaVersion: _schema, id: _id, revision, createdAt: _created, updatedAt: _updated, ...draft } = created.document
  draft.shots = [
    { id: 'opening', episodeId: draft.episodes[0]!.id, title: '刑场醒来', duration: 3, scene: '', motion: '', dialogue: '', assetIds: [], mediaId: image.id },
    { id: 'moving', episodeId: draft.episodes[0]!.id, title: '追逐片段', duration: 2, scene: '', motion: '', dialogue: '', assetIds: [], mediaId: clip.id },
    { id: 'reuse', episodeId: draft.episodes[0]!.id, title: '重复引用画面', duration: 3, scene: '', motion: '', dialogue: '', assetIds: [], mediaId: image.id },
  ]
  draft.assets = [{ id: 'portrait', name: '角色正面参考', type: '角色', description: '', locked: false, mediaId: portrait.id }, { id: 'hero', name: '主角定妆', type: '角色', description: '', locked: false, mediaId: image.id }]
  await access().execute('save', { sessionId, productionId, baseRevision: revision, draft })
  /** 真正接收浏览器下载并核对文件名和字节，下载只写隔离目录。 */
  const downloads: { name: string; bytes: Buffer }[] = []
  window.webContents.session.on('will-download', (_event, item: DownloadItem) => {
    const name = item.getFilename()
    const path = join(root, `download-${downloads.length}-${name}`)
    item.setSavePath(path)
    item.once('done', (_event, state) => { if (state === 'completed') void readFile(path).then(bytes => downloads.push({ name, bytes })) })
  })
  try {
    await window.loadURL(process.env.VISUAL_SMOKE_URL!)
    await wait(window, button('素材导出'))
    await click(window, button('素材导出'))
    await wait(window, `document.querySelectorAll('.vp-delivery-item').length === 3`)
    assert.equal(await window.webContents.executeJavaScript(`document.querySelector('.vp-delivery').textContent.includes(${JSON.stringify(image.id)})`), false, 'UUID 不得用作业务标题')
    assert.ok(await window.webContents.executeJavaScript(`document.querySelector('.vp-delivery').textContent.includes('项目资产')`))
    await wait(window, `document.querySelector('.vp-delivery-item img')?.naturalWidth > 0`)
    assert.equal(reads.get(clip.id) ?? 0, 0, '视频默认不能读取')
    const title = await window.webContents.executeJavaScript(`document.querySelector('.vp-delivery-item button[aria-label^="预览："]').getAttribute('aria-label').slice(3)`)
    await click(window, named(`预览：${title}`))
    await wait(window, `document.querySelector('[role="dialog"] img')?.naturalWidth > 0`)
    assert.equal(await window.webContents.executeJavaScript(`document.querySelector('[role="dialog"] img').alt`), title)
    await pressKey(window, 'Escape', 27)
    await wait(window, `!document.querySelector('[role="dialog"]')`)
    assert.equal(await window.webContents.executeJavaScript(`document.activeElement?.getAttribute('aria-label')`), `预览：${title}`, '关闭预览后归还键盘焦点')
    failMedia = true
    await click(window, named(`下载：${title}`))
    await wait(window, `document.querySelector('.vp-error') && !(${named(`下载：${title}`)}).disabled`)
    assert.equal(downloads.length, 0, '读取失败不得触发下载')
    await click(window, named(`下载：${title}`))
    for (let attempt = 0; attempt < 60 && downloads.length < 1; attempt++) await new Promise(resolve => setTimeout(resolve, 50))
    assert.equal(downloads.length, 1)
    assert.ok(downloads[0]!.name.includes('刑场醒来'))
    assert.ok(downloads[0]!.name.endsWith('.png'))
    assert.equal(await window.webContents.executeJavaScript(`Boolean(document.querySelector('.vp-error'))`), false, '成功重试清除旧错误')
    assert.deepEqual(downloads[0]!.bytes, await readFile(join(root, 'project', 'frame.png')))
    await click(window, button('导出制作清单'))
    for (let attempt = 0; attempt < 60 && downloads.length < 2; attempt++) await new Promise(resolve => setTimeout(resolve, 50))
    assert.equal(downloads.length, 2)
    assert.ok(downloads[1]!.name.endsWith('.json'))
    assert.ok(JSON.parse(downloads[1]!.bytes.toString()))
    assert.equal(await window.webContents.executeJavaScript(`getComputedStyle(document.querySelector('.vp-delivery-source')).display`), 'block')
    assert.deepEqual(await window.webContents.executeJavaScript(`(()=>{const b=document.querySelector('.vp-delivery-preview').getBoundingClientRect();return [b.width,b.height]})()`), [88,68])
    await writeFile('/private/tmp/dutydeck-delivery-light.png', (await window.webContents.capturePage()).toPNG())
    window.setSize(460, 760)
    await window.webContents.executeJavaScript("document.documentElement.classList.add('dark')")
    await wait(window, `innerWidth === 460 && !document.getAnimations().some(animation=>Number.isFinite(animation.effect?.getComputedTiming().endTime) && animation.playState === 'running')`)
    assert.equal(await window.webContents.executeJavaScript('document.documentElement.scrollWidth > innerWidth'), false)
    assert.deepEqual(await window.webContents.executeJavaScript(`(()=>{const b=document.querySelector('.vp-delivery-preview').getBoundingClientRect();return [b.width,b.height]})()`), [64,56])
    await writeFile('/private/tmp/dutydeck-delivery-narrow-dark.png', (await window.webContents.capturePage()).toPNG())
    const videoTitle = await window.webContents.executeJavaScript(`[...document.querySelectorAll('.vp-delivery-item')].find(node=>node.textContent.includes('追逐片段')).querySelector('button[aria-label^="预览："]').getAttribute('aria-label').slice(3)`)
    failMedia = true
    await click(window, named(`预览：${videoTitle}`))
    await wait(window, `document.querySelector('[role="dialog"]')?.textContent.includes('媒体读取失败')`)
    await pressKey(window, 'Escape', 27)
    await wait(window, `!document.querySelector('[role="dialog"]')`)
    await click(window, named(`预览：${videoTitle}`))
    await wait(window, `document.querySelector('[role="dialog"] video')?.readyState >= 2`)
    await pressKey(window, 'Escape', 27)
    await wait(window, `!document.querySelector('[role="dialog"]')`)
    await click(window, named('查看来源：角色 · 角色正面参考'))
    await wait(window, `document.querySelector('[role="dialog"]')?.textContent.includes('角色正面参考')`)
    await pressKey(window, 'Escape', 27)
    await wait(window, `!document.querySelector('[role="dialog"]')`)
    await click(window, button('素材导出'))
    await click(window, `document.querySelector('button[aria-label^="查看来源："]')`)
    await wait(window, `!document.querySelector('.vp-delivery') && document.querySelector('.vp-player')`)
    const empty = await access().execute('create', { sessionId, title: '空素材作品', kind: 'image' })
    await window.webContents.executeJavaScript(`window.__visualSmoke.select(${JSON.stringify(empty.document.id)})`)
    await wait(window, `document.querySelector('.vp-top')?.textContent.includes('空素材作品')`)
    await click(window, button('素材导出'))
    await wait(window, `document.querySelector('.vp-delivery')?.textContent.includes('还没有可导出的素材')`)
    assert.deepEqual(errors, [])
    console.log('PASS: delivery business names, deduplication, lazy video, image/video preview and Escape, error recovery, true image/JSON downloads, shot/asset source navigation, failure recovery, focus return, empty state, light/dark 460px. Isolated project; no model calls.')
  } finally { window.destroy() }
}
/** Bun 负责隔离目录和子进程清理，Electron 只操作测试项目。 */
async function orchestrate(): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'dutydeck-visual-smoke-'))
  const fixtureHtml = join(process.cwd(), 'scripts', `.visual-smoke-${process.pid}.html`)
  const fixtureConfig = join(process.cwd(), 'scripts', `.visual-smoke-${process.pid}.ts`)
  const listenPort = await port()
  const url = `http://127.0.0.1:${listenPort}/@fs${fixtureHtml}`
  const { mkdir } = await import('node:fs/promises')
  await mkdir(join(root, 'project'))
  await writeFile(join(root, 'project', 'frame.png'), Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64'))
  await writeFile(join(root, 'project', 'portrait.png'), Buffer.concat([await readFile(join(root, 'project', 'frame.png')), Buffer.from([0])]))
  /** 本机生成两秒色卡测试视频，不下载素材或调用生成服务。 */
  await new Promise<void>((resolve, reject) => {
    const encoder = spawn('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'color=c=blue:s=160x90:d=2', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', join(root, 'project', 'clip.mp4')])
    encoder.once('error', reject)
    encoder.once('exit', code => code === 0 ? resolve() : reject(new Error('测试视频生成失败，需要本机 ffmpeg')))
  })
  await writeFile(fixtureHtml, '<html lang="zh-CN"><head><meta charset="utf-8"></head><body><div id="root"></div><script type="module">import RefreshRuntime from "/@react-refresh";RefreshRuntime.injectIntoGlobalHook(window);window.$RefreshReg$=()=>{};window.$RefreshSig$=()=>type=>type;</script><script type="module" src="./visual-production-ui-smoke-renderer.tsx"></script></body></html>')
  await writeFile(fixtureConfig, "import config from '../vite.config';export default {...config,server:{...config.server,hmr:false,watch:null}}")
  const vite = spawn(process.execPath, [join(process.cwd(), 'node_modules/vite/bin/vite.js'), '--config', fixtureConfig, '--host', '127.0.0.1', '--port', String(listenPort), '--strictPort'], { stdio: 'inherit' })
  try {
    for (let count = 0; count < 100; count++) { try { if ((await fetch(url)).ok) break } catch { /* 等待 Vite 启动。 */ } await new Promise(resolve => setTimeout(resolve, 100)) }
    const build = await Bun.build({ entrypoints: ['scripts/visual-production-delivery-smoke.ts', 'scripts/visual-production-ui-smoke-preload.ts'], outdir: root, target: 'node', format: 'cjs', external: ['electron'] })
    if (!build.success) throw new Error(build.logs.join('\n'))
    const child = spawn(join(process.cwd(), 'node_modules/.bin/electron'), [join(root, 'visual-production-delivery-smoke.js')], { env: { ...process.env, VISUAL_SMOKE_CHILD: '1', VISUAL_SMOKE_DIR: root, VISUAL_SMOKE_URL: url }, stdio: 'inherit' })
    const code = await new Promise<number>((resolve, reject) => {
      const timeout = setTimeout(() => { console.error('影像 UI smoke 超过100秒，终止测试子进程'); child.kill('SIGKILL') }, 100000)
      child.once('error', error => { clearTimeout(timeout); reject(error) })
      child.once('exit', (code, signal) => { clearTimeout(timeout); if (signal) reject(new Error(`影像 UI smoke 被信号终止：${signal}`)); else resolve(code ?? 1) })
    })
    assert.equal(code, 0)
  } finally {
    vite.kill('SIGTERM')
    await rm(fixtureHtml, { force: true }); await rm(fixtureConfig, { force: true }); await rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 })
  }
}
if (process.env.VISUAL_SMOKE_CHILD === '1') void runChild().then(() => (require('electron') as typeof import('electron')).app.quit()).catch(error => { console.error(error); (require('electron') as typeof import('electron')).app.exit(1) })
else void orchestrate().catch(error => { console.error(error); process.exitCode = 1 })
