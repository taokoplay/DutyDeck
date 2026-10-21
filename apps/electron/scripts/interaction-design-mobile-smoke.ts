import { strict as assert } from 'node:assert'
import { spawn } from 'node:child_process'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { BrowserWindow, WebFrameMain } from 'electron'

/** 截图与测量结果保留在临时证据目录，真实数据根不会被访问。 */
const outputDirectory = process.env.DUTYDECK_MOBILE_SMOKE_OUTPUT ?? '/private/tmp/dutydeck-mobile-smoke'
/** 轮询异步断言，成功返回，12 秒后抛出指定场景错误。 */
async function waitFor(check: () => Promise<boolean>, message: string): Promise<void> {
  /** Chromium frame 与 React 提交有界等待。 */
  const deadline = Date.now() + 12_000
  while (Date.now() < deadline) {
    try { if (await check()) return } catch { /* 导航尚未完成，下一轮重试。 */ }
    await new Promise<void>(resolve => setTimeout(resolve, 50))
  }
  throw new Error(message)
}
/** 按状态名称返回真实 Electron 子 frame，不跨源读取 DOM。 */
function getFrame(window: BrowserWindow, stateId = ''): WebFrameMain | undefined {
  return window.webContents.mainFrame.frames.find(frame => frame.name === `prototype-state:home:${stateId}`)
}
/** 等待输入框存在并返回对应隔离 frame。 */
async function readyFrame(window: BrowserWindow, stateId = '', selector = '#entry'): Promise<WebFrameMain> {
  await waitFor(async () => Boolean(await getFrame(window, stateId)?.executeJavaScript(`Boolean(document.querySelector(${JSON.stringify(selector)}))`)), `状态 ${stateId} 正文未加载`)
  return getFrame(window, stateId)!
}
/** 实际布局快照，字段均为浏览器计算后的 CSS 像素或样式。 */
interface Geometry {
  width: number; height: number; safeTop: number; safeBottom: number; safeLeft: number
  shellPaddingTop: number; navTop: number; navHeight: number; navDisplay: string
  bottom: number; sceneTop: number; sceneHeight: number; hudTop: number; hudLeft: number
  layout: string | null; statusDisplay: string; homeColor: string; cutouts: number; chrome: number
}
/** 从真实沙箱收集控件位置和安全区，不复用产品内部计算以避免自证。 */
async function geometry(frame: WebFrameMain): Promise<Geometry> {
  return await frame.executeJavaScript(`(() => {
    const root=document.documentElement,css=getComputedStyle(root),shell=document.querySelector('#shell'),nav=document.querySelector('#nav'),status=document.querySelector('[data-prototype-system-status]');
    const rect=id=>document.querySelector(id)?.getBoundingClientRect();
    return {width:innerWidth,height:innerHeight,safeTop:parseFloat(css.getPropertyValue('--prototype-safe-top'))||0,safeBottom:parseFloat(css.getPropertyValue('--prototype-safe-bottom'))||0,safeLeft:parseFloat(css.getPropertyValue('--prototype-safe-left'))||0,shellPaddingTop:shell?parseFloat(getComputedStyle(shell).paddingTop):0,navTop:rect('#nav')?.top||0,navHeight:rect('#nav')?.height||0,navDisplay:nav?getComputedStyle(nav).display:'missing',bottom:rect('#bottom')?.bottom||0,sceneTop:rect('#scene')?.top||0,sceneHeight:rect('#scene')?.height||0,hudTop:rect('#hud')?.top||0,hudLeft:rect('#hud')?.left||0,layout:root.getAttribute('data-prototype-layout'),statusDisplay:status?getComputedStyle(status).display:'missing',homeColor:document.querySelector('[data-prototype-system-home]')?getComputedStyle(document.querySelector('[data-prototype-system-home]')).backgroundColor:'missing',cutouts:document.querySelectorAll('[data-prototype-system-cutout]').length,chrome:document.querySelectorAll('[data-prototype-system-chrome]').length};
  })()`) as Geometry
}
/** 切换场景允许重建，等待新 frame 身份后返回。 */
async function scene(window: BrowserWindow, name: string): Promise<WebFrameMain> {
  /** 上一场景身份用于排除尚未销毁的旧 frame。 */
  const previous = getFrame(window)?.frameTreeNodeId
  await window.webContents.executeJavaScript(`window.__mobileSmoke.scene(${JSON.stringify(name)})`)
  await waitFor(async () => Boolean(getFrame(window) && getFrame(window)?.frameTreeNodeId !== previous), `场景 ${name} 未切换`)
  return await readyFrame(window, '', name === 'skill' ? '.hud' : '#entry')
}
/** 保存全机身截图，供人工确认物理开孔与导航相对位置。 */
async function screenshot(window: BrowserWindow, name: string): Promise<void> {
  await window.webContents.executeJavaScript('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))')
  await writeFile(join(outputDirectory, `${name}.png`), (await window.webContents.capturePage()).toPNG())
}
/** Given 隔离真实 Electron When 切换机型和全屏 Then 布局、交互现场和离线导出正确。 */
async function runElectronSmoke(app: typeof import('electron').app, Window: typeof import('electron').BrowserWindow): Promise<void> {
  await app.whenReady()
  await mkdir(outputDirectory, { recursive: true })
  /** 测试窗口没有真实 preload 或主应用入口。 */
  const window = new Window({ width: 1100, height: 1000, show: true, webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true } })
  /** 即使失败也保存此前已测得的几何。 */
  const evidence: Record<string, unknown> = {}
  try {
    await window.loadURL(process.env.DUTYDECK_MOBILE_SMOKE_URL!)
    /** 普通页面顶部导航和底部按钮必须落在安全区域。 */
    let frame = await readyFrame(window)
    let measured = await geometry(frame)
    evidence.normal = measured
    assert.equal(measured.layout, 'safe', '普通页未接入安全区合同')
    assert.ok(measured.safeTop > 34, '灵动岛设备顶部安全区过小')
    assert.ok(measured.navTop >= measured.safeTop && measured.navHeight >= 44, '导航未避让或触区不足')
    assert.ok(measured.bottom <= measured.height - measured.safeBottom + 1, '底部按钮被手势区域遮挡')
    assert.equal(measured.cutouts, 0, '机壳已有开孔，正文不得重复绘制')
    assert.ok(measured.chrome > 0, '普通页缺少系统区域')
    assert.equal(measured.homeColor, 'rgb(17, 17, 17)', '浅色页 Home 条必须使用深色')
    await screenshot(window, 'normal-iphone17')
    /** 输入、脚本标记、启动次数与局部滚动作为现场保留证据。 */
    const frameIdentity = frame.frameTreeNodeId
    await frame.executeJavaScript(`document.querySelector('#entry').value='keep-input';document.querySelector('#scroll').scrollTop=123;window.fixtureMarker='keep-script'`)
    /** 即使伪造完整有效 viewport，错误 token 或错误消息来源也不能改写安全区。 */
    const config = await window.webContents.executeJavaScript(`JSON.parse(document.querySelector('iframe').srcdoc.match(/const config=(.*?);document.currentScript/)[1])`) as { token: string; viewport: Record<string, unknown> }
    const forgedViewport = { ...config.viewport, safeArea: { top: 333, right: 333, bottom: 333, left: 333 }, statusBarHeight: 333 }
    await window.webContents.executeJavaScript(`document.querySelector('iframe').contentWindow.postMessage(${JSON.stringify({ type: 'prototype-viewport', token: 'wrong-token', viewport: forgedViewport })}, '*')`)
    await frame.executeJavaScript(`window.postMessage(${JSON.stringify({ type: 'prototype-viewport', token: config.token, viewport: forgedViewport })}, '*')`)
    await new Promise<void>(resolve => setTimeout(resolve, 100))
    assert.deepEqual(await geometry(frame), measured, '错误来源或 token 改写了安全区')
    /** 横屏显示状态栏时仍保留 24px；页面隐藏后只移除系统栏占位，侧面硬件避让保留。 */
    await window.webContents.executeJavaScript(`window.__mobileSmoke.device('iPhone 17','landscape')`)
    await waitFor(async () => (await geometry(frame)).width > (await geometry(frame)).height, '横屏未完成')
    measured = await geometry(frame)
    assert.equal(measured.safeTop, 24, '横屏可见状态栏必须保留 24px 顶部')
    assert.equal(measured.statusDisplay, 'flex')
    await screenshot(window, 'normal-landscape-status-visible')
    await frame.executeJavaScript(`document.documentElement.setAttribute('data-prototype-status-bar','hidden')`)
    await waitFor(async () => (await geometry(frame)).safeTop === 0, '横屏隐藏状态栏后顶部仍然留白')
    assert.equal((await geometry(frame)).homeColor, 'rgb(255, 255, 255)', '沉浸页 Home 条应使用浅色')
    assert.equal(getFrame(window)?.frameTreeNodeId, frameIdentity)
    assert.equal(await frame.executeJavaScript('document.querySelector("#entry").value'), 'keep-input')
    await frame.executeJavaScript(`document.documentElement.style.setProperty('--prototype-home-color','rgb(1, 2, 3)')`)
    assert.equal((await geometry(frame)).homeColor, 'rgb(1, 2, 3)', '自定义 Home 条颜色未生效')
    await frame.executeJavaScript(`document.documentElement.style.removeProperty('--prototype-home-color');document.documentElement.setAttribute('data-prototype-status-bar','dark')`)
    await window.webContents.executeJavaScript(`window.__mobileSmoke.device('iPhone 17','portrait')`)
    await waitFor(async () => (await geometry(frame)).height === 874 && (await geometry(frame)).safeTop === 62, '竖屏恢复未完成')
    console.log('[Mobile smoke] PASS Home 条深浅/自定义颜色、横屏状态栏显示/隐藏与消息来源/token 隔离')
    for (const device of ['iPhone X', 'iPhone 8', 'Pixel 10', '浏览器 Web', 'iPhone 17']) {
      await window.webContents.executeJavaScript(`window.__mobileSmoke.device(${JSON.stringify(device)})`)
      await waitFor(async () => (await window.webContents.executeJavaScript(`document.querySelector('[data-device]')?.getAttribute('data-device')`)) === device, `未切到 ${device}`)
      await new Promise<void>(resolve => setTimeout(resolve, 100))
      frame = await readyFrame(window)
      assert.equal(frame.frameTreeNodeId, frameIdentity, `${device} 重建 iframe`)
      assert.deepEqual(await frame.executeJavaScript(`({input:document.querySelector('#entry').value,marker:window.fixtureMarker,boots:window.fixtureBoots,scroll:document.querySelector('#scroll').scrollTop})`), { input: 'keep-input', marker: 'keep-script', boots: 1, scroll: 123 }, `${device} 丢失现场`)
      measured = await geometry(frame)
      evidence[device] = measured
      assert.ok(measured.navTop >= measured.safeTop, `${device} 导航未避让`)
      if (device === 'iPhone 8') assert.equal(measured.safeBottom, 0, '实体 Home 键设备不应有手势安全区')
      if (device === '浏览器 Web') assert.equal(measured.safeTop, 0, 'Web 不应强制移动顶部留白')
    }
    console.log('[Mobile smoke] PASS 普通页、iPhone 17/X/8、Android、Web 适配与 iframe/输入/脚本/滚动保留')
    /** 根属性动态切换不经 React 重载，恢复布局后仍保留滚动。 */
    await frame.executeJavaScript(`document.documentElement.setAttribute('data-prototype-layout','edge-to-edge');document.documentElement.setAttribute('data-prototype-status-bar','hidden');document.documentElement.setAttribute('data-prototype-navigation-mode','none')`)
    await waitFor(async () => (await geometry(frame)).shellPaddingTop === 0, '动态全屏仍有顶部 padding')
    measured = await geometry(frame)
    assert.equal(measured.navDisplay, 'none')
    assert.ok(['none', 'missing'].includes(measured.statusDisplay))
    assert.equal(await frame.executeJavaScript('document.querySelector("#entry").value'), 'keep-input')
    await frame.executeJavaScript(`document.documentElement.setAttribute('data-prototype-layout','safe');document.documentElement.setAttribute('data-prototype-status-bar','dark');document.documentElement.setAttribute('data-prototype-navigation-mode','inline')`)
    await waitFor(async () => (await geometry(frame)).shellPaddingTop > 0, '退出全屏未恢复安全区')
    assert.equal(await frame.executeJavaScript('document.querySelector("#scroll").scrollTop'), 123)
    console.log('[Mobile smoke] PASS 动态全屏进入/退出保留现场')
    /** 直播背景铺满但 HUD 独立避让。 */
    frame = await scene(window, 'live')
    measured = await geometry(frame)
    evidence.live = measured
    assert.equal(measured.homeColor, 'rgb(255, 255, 255)', '直播浅色状态栏应匹配浅色 Home 条')
    assert.equal(measured.shellPaddingTop, 0)
    assert.equal(measured.sceneTop, 0)
    assert.equal(measured.sceneHeight, measured.height)
    assert.ok(measured.hudTop >= measured.safeTop, '直播 HUD 未避让顶部硬件')
    await screenshot(window, 'live-iphone17')
    /** 横屏游戏无状态栏和应用导航，保留硬件遮挡安全区。 */
    frame = await scene(window, 'game')
    const gameIdentity = frame.frameTreeNodeId
    await frame.executeJavaScript(`document.querySelector('#entry').value='game-state'`)
    await window.webContents.executeJavaScript(`window.__mobileSmoke.device('iPhone 17','landscape')`)
    await waitFor(async () => { const result = await geometry(frame); return result.width > result.height }, '横屏视口未交换尺寸')
    measured = await geometry(frame)
    evidence.gameLandscape = measured
    assert.equal(getFrame(window)?.frameTreeNodeId, gameIdentity, '旋转方向重建 iframe')
    assert.equal(await frame.executeJavaScript('document.querySelector("#entry").value'), 'game-state')
    assert.equal(measured.shellPaddingTop, 0)
    assert.equal(measured.navDisplay, 'none')
    assert.ok(['none', 'missing'].includes(measured.statusDisplay))
    assert.ok(measured.safeLeft > 0 && measured.hudLeft >= measured.safeLeft, '横屏 HUD 未避让侧面开孔')
    assert.ok(await window.webContents.executeJavaScript(`Boolean(document.querySelector('.id-preview-mockframe'))`), '游戏隐藏了物理机壳')
    await screenshot(window, 'game-landscape-iphone17')
    console.log('[Mobile smoke] PASS 直播全屏/独立安全控件与横屏游戏/硬件避让')
    /** 老页面没有 presentation 时不得新增系统节点或改变原 padding。 */
    frame = await scene(window, 'legacy')
    assert.equal((await geometry(frame)).chrome, 0)
    assert.equal(await frame.executeJavaScript('getComputedStyle(document.body).padding'), '13px')
    /** 状态显式覆盖与缺省继承分别验证。 */
    await scene(window, 'states')
    await window.webContents.executeJavaScript(`document.querySelector('[data-state-id="game"]').scrollIntoView()`)
    frame = await readyFrame(window, 'game')
    assert.equal((await geometry(frame)).layout, 'edge-to-edge')
    assert.equal((await geometry(frame)).navDisplay, 'none')
    await window.webContents.executeJavaScript(`document.querySelector('[data-state-id="inherited"]').scrollIntoView()`)
    frame = await readyFrame(window, 'inherited')
    assert.equal((await geometry(frame)).layout, 'safe')
    console.log('[Mobile smoke] PASS 旧页兼容、独立状态覆盖和继承')
    /** 直接渲染默认 Skill 的全屏代码块，避免测试手写 fixture 掩盖生成规范的布局错误。 */
    frame = await scene(window, 'skill')
    const skillLayout = await frame.executeJavaScript(`(() => {const nav=document.querySelector('nav[data-prototype-navigation]').getBoundingClientRect(),hud=document.querySelector('.hud').getBoundingClientRect();return {navTop:nav.top,navBottom:nav.bottom,hudTop:hud.top,safeTop:parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--prototype-safe-top'))}})()`) as { navTop: number; navBottom: number; hudTop: number; safeTop: number }
    evidence.defaultSkill = skillLayout
    await screenshot(window, 'default-skill-live')
    assert.ok(skillLayout.navBottom <= skillLayout.hudTop, `默认 Skill 直播导航与 HUD 发生重叠：${JSON.stringify(skillLayout)}`)
    assert.ok(skillLayout.navTop >= skillLayout.safeTop)
    await screenshot(window, 'default-skill-live')
    await frame.executeJavaScript(`document.documentElement.setAttribute('data-prototype-status-bar','hidden');document.documentElement.setAttribute('data-prototype-navigation-mode','none')`)
    await waitFor(async () => await frame.executeJavaScript(`getComputedStyle(document.querySelector('nav[data-prototype-navigation]')).display==='none'`) === true, '默认 Skill 游戏模式导航未隐藏')
    assert.equal(await frame.executeJavaScript(`document.querySelector('.hud').getBoundingClientRect().top-parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--prototype-safe-top'))`), 12, '默认 Skill 隐藏导航后 HUD 未恢复安全顶部 + 12px')
    console.log('[Mobile smoke] PASS 默认 Skill 原始全屏示例：导航/HUD 不重叠，游戏 HUD 自动复位')
    /** file:// 加载真实导出文档，不依赖测试服务器，尺寸与机型一致。 */
    await scene(window, 'normal')
    const exported = await window.webContents.executeJavaScript('window.__mobileSmoke.exportHtml()') as string
    await writeFile(join(outputDirectory, 'offline.html'), exported)
    const offlineWindow = new Window({ width: 1100, height: 1000, show: false, webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true } })
    try {
      await offlineWindow.loadFile(join(outputDirectory, 'offline.html'))
      await waitFor(async () => Boolean(await offlineWindow.webContents.mainFrame.frames[0]?.executeJavaScript('document.querySelector("#entry")')), '离线正文未加载')
      const offlineFrame = offlineWindow.webContents.mainFrame.frames[0]!
      measured = await geometry(offlineFrame)
      evidence.offline = measured
      assert.equal(measured.width, 402, '离线导出宽度未保持设计视口')
      assert.equal(measured.height, 874, '离线导出高度未保持设计视口')
      assert.equal(measured.cutouts, 1, '独立导出必须模拟一次开孔')
      assert.ok(measured.navTop >= measured.safeTop)
    } finally { offlineWindow.destroy() }
    console.log(`[Mobile smoke] PASS 离线导出全尺寸/开孔；证据：${outputDirectory}`)
  } finally {
    await writeFile(join(outputDirectory, 'geometry.json'), JSON.stringify(evidence, null, 2))
    window.destroy()
  }
}
/** 仅申请 loopback 临时端口，返回系统分配的空闲端口。 */
async function availablePort(): Promise<number> {
  return await new Promise<number>((resolve, reject) => {
    /** TCP 不对外监听。 */
    const server = createServer()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      /** 校验非 Unix socket 地址。 */
      const address = server.address()
      if (!address || typeof address === 'string') return reject(new Error('无法分配测试端口'))
      server.close(error => error ? reject(error) : resolve(address.port))
    })
  })
}
/** Bun 启动隔离 Vite/Electron，退出后清理全部临时运行文件。 */
async function orchestrate(): Promise<void> {
  /** 临时入口仅导入本测试 renderer，禁用 watch 和 HMR。 */
  const port = await availablePort()
  const fixture = join(process.cwd(), 'scripts', `.mobile-smoke-${process.pid}.html`)
  const config = join(process.cwd(), 'scripts', `.mobile-smoke-${process.pid}.ts`)
  const url = `http://127.0.0.1:${port}/@fs${fixture}`
  const buildDirectory = await mkdtemp(join(tmpdir(), 'dutydeck-mobile-smoke-build-'))
  await writeFile(fixture, '<!doctype html><html><head><meta charset="UTF-8"></head><body><div id="root"></div><script type="module">import RefreshRuntime from "/@react-refresh";RefreshRuntime.injectIntoGlobalHook(window);window.$RefreshReg$=()=>undefined;window.$RefreshSig$=()=>(type)=>type;</script><script type="module" src="./interaction-design-mobile-smoke-renderer.tsx"></script></body></html>')
  await writeFile(config, "import config from '../vite.config';export default {...config,server:{...config.server,hmr:false,watch:null}}")
  const vite = spawn(process.execPath, [join(process.cwd(), 'node_modules/vite/bin/vite.js'), '--config', config, '--host', '127.0.0.1', '--port', String(port), '--strictPort'], { stdio: 'inherit' })
  try {
    await waitFor(async () => (await fetch(url)).ok, '测试 Vite 启动超时')
    /** 不打包主应用，不连接真实业务数据根。 */
    const entry = join(buildDirectory, 'mobile-smoke.cjs')
    const build = spawn(process.execPath, ['build', join(process.cwd(), 'scripts/interaction-design-mobile-smoke.ts'), '--target=node', '--format=cjs', '--external=electron', '--outfile', entry], { stdio: 'inherit' })
    const buildCode = await new Promise<number>((resolve, reject) => { build.once('error', reject); build.once('exit', code => resolve(code ?? 1)) })
    assert.equal(buildCode, 0, 'smoke 编译失败')
    const child = spawn(process.env.PROMA_ELECTRON_PATH ?? join(process.cwd(), 'node_modules/.bin/electron'), [entry], { stdio: 'inherit', env: { ...process.env, DUTYDECK_MOBILE_SMOKE_CHILD: '1', DUTYDECK_MOBILE_SMOKE_URL: url, DUTYDECK_MOBILE_SMOKE_USER_DATA: join(buildDirectory, 'user-data') } })
    const code = await new Promise<number>((resolve, reject) => {
      /** 总测试有界，超时后 finally 仍清理。 */
      const timeout = setTimeout(() => child.kill('SIGKILL'), 120_000)
      child.once('error', error => { clearTimeout(timeout); reject(error) })
      child.once('exit', value => { clearTimeout(timeout); resolve(value ?? 1) })
    })
    assert.equal(code, 0, `移动 UI smoke 退出码 ${code}`)
  } finally {
    vite.kill('SIGTERM')
    await Promise.all([rm(fixture, { force: true }), rm(config, { force: true }), rm(buildDirectory, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 })])
  }
}
if (process.env.DUTYDECK_MOBILE_SMOKE_CHILD === '1') {
  /** Electron 的持久化仅落在隔离临时目录。 */
  const electron = require('electron') as typeof import('electron')
  electron.app.setPath('userData', process.env.DUTYDECK_MOBILE_SMOKE_USER_DATA!)
  electron.app.on('window-all-closed', () => undefined)
  const keepAlive = setInterval(() => undefined, 1_000)
  void runElectronSmoke(electron.app, electron.BrowserWindow).then(() => { clearInterval(keepAlive); electron.app.quit() }).catch((error: unknown) => { clearInterval(keepAlive); console.error('[Mobile smoke] FAIL', error); electron.app.exit(1) })
} else {
  void orchestrate().catch((error: unknown) => { console.error('[Mobile smoke] FAIL', error); process.exitCode = 1 })
}
