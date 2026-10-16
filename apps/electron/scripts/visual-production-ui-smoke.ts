import { strict as assert } from 'node:assert'
import { spawn } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { BrowserWindow } from 'electron'
import { VISUAL_PRODUCTION_CHANNELS } from '@proma/shared'
import type { VisualProductionInputs, VisualProductionMethod, VisualProductionResults } from '@proma/shared'
import { createVisualProductionAccess } from '../src/main/lib/visual-production/access'
import { registerVisualProductionIpc } from '../src/main/lib/visual-production/ipc'
import { VisualProductionService } from '../src/main/lib/visual-production/store'

/** 获取临时端口，避免触及正在运行的开发实例。 */
async function port(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer()
    server.on('error', reject)
    server.listen(0, '127.0.0.1', () => { const address = server.address(); if (!address || typeof address === 'string') return reject(new Error('端口分配失败')); server.close(error => error ? reject(error) : resolve(address.port)) })
  })
}
/** DOM 等待有界并输出失败证据。 */
async function wait(window: BrowserWindow, expression: string): Promise<void> {
  const deadline = Date.now() + 12000
  while (Date.now() < deadline) {
    if (await window.webContents.executeJavaScript(`Boolean(${expression})`)) return
    await new Promise(resolve => setTimeout(resolve, 50))
  }
  throw new Error(`等待失败 ${expression}\n${await window.webContents.executeJavaScript('document.body.innerText')}`)
}
/** 真实 Chromium 鼠标事件，覆盖 Radix 焦点与遮罩。 */
async function click(window: BrowserWindow, selector: string): Promise<void> {
  await wait(window, selector)
  const point = await window.webContents.executeJavaScript(`(async()=>{const node=${selector};node.scrollIntoView({block:'nearest'});await new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)));const b=node.getBoundingClientRect();return{x:b.x+b.width/2,y:b.y+b.height/2}})()`)
  window.webContents.debugger.attach('1.3')
  try {
    for (const type of ['mousePressed', 'mouseReleased']) await window.webContents.debugger.sendCommand('Input.dispatchMouseEvent', { type, ...point, button: 'left', clickCount: 1 })
  } finally { window.webContents.debugger.detach() }
}
/** 获取当前弹窗优先的精确按钮，不误点背景相同文案。 */
function button(text: string): string { return `[...(document.querySelector('[role="dialog"]')??document).querySelectorAll('button')].find(n=>n.textContent.trim()===${JSON.stringify(text)})` }
/** 用原生 value setter 驱动 React 受控输入。 */
async function fill(window: BrowserWindow, label: string, value: string): Promise<void> {
  const selector = `[...document.querySelectorAll('[role="dialog"] label')].find(n=>n.textContent.startsWith(${JSON.stringify(label)}))?.querySelector('input,textarea,select')`
  await wait(window, selector)
  await window.webContents.executeJavaScript(`(()=>{const node=${selector};const type=node instanceof HTMLTextAreaElement?HTMLTextAreaElement:node instanceof HTMLSelectElement?HTMLSelectElement:HTMLInputElement;Object.getOwnPropertyDescriptor(type.prototype,'value').set.call(node,${JSON.stringify(value)});node.dispatchEvent(new Event(node instanceof HTMLSelectElement?'change':'input',{bubbles:true}));})()`)
}
/** 从空项目到真实存储/媒体/候选的完整窗口烟测。 */
async function runChild(): Promise<void> {
  const { app, BrowserWindow: Window, ipcMain } = require('electron') as typeof import('electron')
  const root = process.env.VISUAL_SMOKE_DIR!
  app.setPath('userData', join(root, 'user-data'))
  app.on('window-all-closed', () => undefined)
  await app.whenReady()
  const window = new Window({ width: 1000, height: 800, show: true, webPreferences: { preload: join(root, 'visual-production-ui-smoke-preload.js'), backgroundThrottling: false } })
  const errors: string[] = []
  window.webContents.on('console-message', event => { if (event.level === 'error') errors.push(event.message) })
  const projectRoot = join(root, 'project')
  const service = new VisualProductionService({ projectRoot, workspaceId: 'smoke-project' })
  /** 只延迟真实保存响应，复现磁盘已提交但 UI 尚未收到的网络/IPC 时序。 */
  let holdSave = false
  let releaseSave: (() => void) | undefined
  const access = (assertCaller?: () => void) => createVisualProductionAccess('smoke-session', { resolveSession: () => ({ workspaceId: 'smoke-project', projectRoot }), assertCaller, acquireWriteLease: () => () => undefined, createService: () => ({
    async invoke<M extends VisualProductionMethod>(method: M, input: VisualProductionInputs[M]): Promise<VisualProductionResults[M]> {
      const result = await service.invoke(method, input)
      if (method === 'save' && holdSave) { holdSave = false; await new Promise<void>(resolve => { releaseSave = resolve }) }
      return result
    },
  }), onChanged: event => window.webContents.send(VISUAL_PRODUCTION_CHANNELS.CHANGED, event) })
  registerVisualProductionIpc({ ipc: ipcMain, isAuthorizedSender: event => event.sender.id === window.webContents.id, createAccess: (_sessionId, assertCaller) => access(assertCaller) })
  try {
    await window.loadURL(process.env.VISUAL_SMOKE_URL!)
    await wait(window, button('新建影像项目'))
    await click(window, button('新建影像项目')); await fill(window, '作品名称', '影像首版验收'); await click(window, button('创建作品'))
    await wait(window, `document.querySelector('.vp-top')?.textContent.includes('影像首版验收')`)
    await click(window, button('编辑设定')); await fill(window, '作品目标', '用真实媒体验证第一支宣传片'); await click(window, button('保存设置'))
    await wait(window, `!document.querySelector('[role="dialog"]') && document.body.textContent.includes('用真实媒体验证')`)
    await click(window, button('资产')); await click(window, button('新增资产')); await fill(window, '资产名称', '品牌主角'); await fill(window, '描述', '保持形象一致'); await click(window, button('保存设置'))
    await wait(window, `!document.querySelector('[role="dialog"]') && document.body.textContent.includes('品牌主角')`)
    await click(window, button('分镜')); await click(window, button('新增')); await fill(window, '镜头名称', '开场镜头'); await fill(window, '画面描述', '主角出现在画面中央')
    await click(window, `[...document.querySelectorAll('[role="dialog"] label')].find(n=>n.textContent.includes('品牌主角'))?.querySelector('input')`)
    await click(window, button('保存设置')); await wait(window, `!document.querySelector('[role="dialog"]') && document.querySelector('.vp-shot')`)
    const sessionId = 'smoke-session'
    const productionId = (await service.invoke('list', { sessionId }))[0]!.id
    const media = await access().execute('importFile', { sessionId, productionId, relativePath: 'frame.png' })
    await click(window, button('镜头设置')); await fill(window, '采用素材', media.id); await click(window, button('保存设置'))
    await wait(window, `!document.querySelector('[role="dialog"]') && document.querySelector('.vp-player img')?.naturalWidth > 0`)
    await click(window, button('镜头设置')); await fill(window, '画面描述', '尚未保存的描述'); await click(window, button('关闭')); await click(window, button('镜头设置'))
    assert.equal(await window.webContents.executeJavaScript(`document.querySelector('[role="dialog"] textarea').value`), '尚未保存的描述')
    await click(window, button('关闭')); await click(window, button('引用到 Agent'))
    assert.ok(await window.webContents.executeJavaScript(`window.__visualSmoke.prompt().message.includes(${JSON.stringify(productionId)})`))
    const current = await service.invoke('load', { sessionId, productionId })
    const { schemaVersion: _schema, id: _id, revision, createdAt: _created, updatedAt: _updated, ...draft } = current.document
    const job = await access().execute('beginJob', { sessionId, productionId, baseRevision: revision, instruction: '修改开场', shotId: draft.shots[0]!.id })
    draft.shots[0]!.scene = 'Agent 候选中的新画面'
    await access().execute('propose', { sessionId, productionId, baseRevision: revision, jobId: job.id, draft, summary: '更新开场画面' })
    await wait(window, button('采用候选'))
    assert.equal((await service.invoke('load', { sessionId, productionId })).document.shots[0]!.scene, '主角出现在画面中央')
    await click(window, button('预览')); await wait(window, `document.querySelector('[role="dialog"]')?.textContent.includes('Agent 候选中的新画面')`)
    await click(window, button('采用候选'))
    await wait(window, `document.body.textContent.includes('已采用')`)
    assert.equal((await service.invoke('load', { sessionId, productionId })).document.shots[0]!.scene, 'Agent 候选中的新画面')
    await window.loadURL(process.env.VISUAL_SMOKE_URL!)
    await wait(window, `document.querySelector('.vp-top')?.textContent.includes('影像首版验收')`)
    await click(window, button('分镜')); await wait(window, `document.querySelector('.vp-player img')?.naturalWidth > 0`)
    await writeFile('/private/tmp/dutydeck-visual-production-v1-desktop.png', (await window.webContents.capturePage()).toPNG())
    window.setSize(460, 760)
    await click(window, button('镜头设置'))
    await wait(window, button('保存设置'))
    await window.webContents.executeJavaScript('new Promise(resolve=>setTimeout(resolve,200))')
    const geometry = await window.webContents.executeJavaScript(`(()=>{const dialog=document.querySelector('[role="dialog"]');const footer=document.querySelector('.vp-form-footer');return{width:dialog.getBoundingClientRect().width,bottom:footer.getBoundingClientRect().bottom,viewport:innerHeight,overflow:document.documentElement.scrollWidth>innerWidth}})()`)
    assert.ok(geometry.width <= 460 && geometry.bottom <= geometry.viewport && !geometry.overflow, JSON.stringify(geometry))
    await writeFile('/private/tmp/dutydeck-visual-production-v1-dialog.png', (await window.webContents.capturePage()).toPNG())
    await window.webContents.executeJavaScript("document.documentElement.classList.add('dark')")
    await writeFile('/private/tmp/dutydeck-visual-production-v1-dark.png', (await window.webContents.capturePage()).toPNG())
    await click(window, button('关闭'))
    window.setSize(1000, 800)
    /** 两个真实镜头验证实际视频播放、时长截断和后续静帧连续播放。 */
    const clip = await access().execute('importFile', { sessionId, productionId, relativePath: 'clip.mp4' })
    const playback = await service.invoke('load', { sessionId, productionId })
    const { schemaVersion: _ps, id: _pi, revision: playbackRevision, createdAt: _pc, updatedAt: _pu, ...playbackDraft } = playback.document
    playbackDraft.ratio = '9:16'
    playbackDraft.shots[0]!.mediaId = clip.id
    playbackDraft.shots[0]!.duration = 0.5
    playbackDraft.shots.push({ ...playbackDraft.shots[0]!, id: 'second-shot', title: '第二镜头', mediaId: media.id, duration: 0.5 })
    await access().execute('save', { sessionId, productionId, baseRevision: playbackRevision, draft: playbackDraft })
    await wait(window, `document.querySelector('.vp-player video')?.readyState >= 2`)
    /** 竖幅预演必须维持作品比例，不能仅改变文字标签。 */
    const frameRatio = await window.webContents.executeJavaScript(`(()=>{const frame=document.querySelector('.vp-player').getBoundingClientRect();return frame.width/frame.height})()`)
    assert.ok(Math.abs(frameRatio - 9 / 16) < 0.02, `竖幅画框比例错误：${frameRatio}`)
    await click(window, button('连续播放'))
    await wait(window, `document.querySelector('.vp-player video')?.currentTime > 0`)
    await wait(window, `document.querySelector('.vp-shot[aria-pressed="true"]')?.textContent.includes('第二镜头')`)
    await wait(window, button('连续播放'))
    await click(window, `document.querySelector('.vp-shot')`)
    await click(window, button('连续播放'))
    await window.webContents.executeJavaScript('window.__visualSmoke.active(false)')
    await wait(window, `document.querySelector('.vp-player video')?.paused`)
    await window.webContents.executeJavaScript('window.__visualSmoke.active(true)')
    /** A → B → A 的旧保存回流不得清掉新打开的草稿。 */
    const another = await access().execute('create', { sessionId, title: '另一个作品', kind: 'image' })
    await click(window, button('镜头设置'))
    /** 前一阶段关闭保留的草稿基于旧版，显式丢弃后才开始新的时序场景。 */
    if (await window.webContents.executeJavaScript(`Boolean(${button('放弃草稿，读取最新')})`)) {
      await click(window, button('放弃草稿，读取最新'))
      await click(window, button('镜头设置'))
    }
    await fill(window, '画面描述', '延迟响应前的编辑')
    holdSave = true
    await click(window, button('保存设置'))
    for (let count = 0; count < 100 && !releaseSave; count++) await new Promise(resolve => setTimeout(resolve, 30))
    assert.ok(releaseSave, '未进入保存响应延迟')
    await window.webContents.executeJavaScript(`window.__visualSmoke.select(${JSON.stringify(another.document.id)})`)
    await wait(window, `document.querySelector('.vp-top')?.textContent.includes('另一个作品')`)
    await window.webContents.executeJavaScript(`window.__visualSmoke.select(${JSON.stringify(productionId)})`)
    await wait(window, `document.querySelector('.vp-top')?.textContent.includes('影像首版验收')`)
    await click(window, button('编辑设定')); await fill(window, '作品目标', '切回之后继续填写的草稿')
    releaseSave(); releaseSave = undefined
    await new Promise(resolve => setTimeout(resolve, 250))
    assert.equal(await window.webContents.executeJavaScript(`document.querySelector('[role="dialog"] textarea')?.value`), '切回之后继续填写的草稿')
    assert.deepEqual(errors, [])
    console.log('PASS: real IPC + preload + atomic persistence; create/settings/assets/shots/media; draft retention; Agent reference; candidate preview/adopt; reopen; 460px fixed footer; light/dark; MP4 playback/sequence/pause; A→B→A stale save isolation. No model calls or real user data.')
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
    const build = await Bun.build({ entrypoints: ['scripts/visual-production-ui-smoke.ts', 'scripts/visual-production-ui-smoke-preload.ts'], outdir: root, target: 'node', format: 'cjs', external: ['electron'] })
    if (!build.success) throw new Error(build.logs.join('\n'))
    const child = spawn(join(process.cwd(), 'node_modules/.bin/electron'), [join(root, 'visual-production-ui-smoke.js')], { env: { ...process.env, VISUAL_SMOKE_CHILD: '1', VISUAL_SMOKE_DIR: root, VISUAL_SMOKE_URL: url }, stdio: 'inherit' })
    const code = await new Promise<number>((resolve, reject) => {
      const timeout = setTimeout(() => child.kill('SIGKILL'), 100000)
      child.once('error', reject)
      child.once('exit', code => { clearTimeout(timeout); resolve(code ?? 1) })
    })
    assert.equal(code, 0)
  } finally {
    vite.kill('SIGTERM')
    await rm(fixtureHtml, { force: true }); await rm(fixtureConfig, { force: true }); await rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 })
  }
}
if (process.env.VISUAL_SMOKE_CHILD === '1') void runChild().then(() => (require('electron') as typeof import('electron')).app.quit()).catch(error => { console.error(error); (require('electron') as typeof import('electron')).app.exit(1) })
else void orchestrate().catch(error => { console.error(error); process.exitCode = 1 })
