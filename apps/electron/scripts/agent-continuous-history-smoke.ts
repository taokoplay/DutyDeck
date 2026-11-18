import { strict as assert } from 'node:assert'
import { spawn } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { createServer as createNetServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { BrowserWindow } from 'electron'

/** 等待真实 renderer 条件，超时抛错。 */
async function waitFor(window: BrowserWindow, expression: string): Promise<void> {
  const deadline = Date.now() + 30_000
  while (Date.now() < deadline) {
    if (await window.webContents.executeJavaScript(`Boolean(${expression})`)) return
    await new Promise(resolve => setTimeout(resolve, 50))
  }
  throw new Error(`界面等待超时：${expression}`)
}
/** 等待异步布局与模拟页面完成；输入毫秒，返回定时完成。 */
const delay = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms))
/** 仅包含合成数据的观测结果。 */
interface Observation { reading: boolean; blockedCommits: number; start: number; end: number; total: number; calls: string[]; anchors: number[]; missingAnchors: number; loading: boolean; error: string | null }
/** 显示隔离 Electron 窗口并驱动真实滚轮，打印可复核 JSON 报告。 */
async function runElectronSmoke(): Promise<void> {
  const { app, BrowserWindow } = await import('electron')
  const userDataPath = await mkdtemp(join(tmpdir(), 'agent-continuous-history-user-'))
  app.setPath('userData', userDataPath)
  app.setPath('sessionData', userDataPath)
  app.on('window-all-closed', () => undefined)
  await app.whenReady()
  const window = new BrowserWindow({ width: 900, height: 680, show: true, webPreferences: { backgroundThrottling: false, contextIsolation: true, nodeIntegration: false, sandbox: true } })
  window.webContents.on('console-message', (_event, level, message) => { if (level >= 2) console.error('[renderer]', message) })
  const failures: string[] = []
  const read = (): Promise<Observation> => window.webContents.executeJavaScript('JSON.parse(JSON.stringify(window.__historySmoke))')
  const check = (condition: boolean, message: string): void => { if (!condition) failures.push(message) }
  const wheel = async (deltaY: number): Promise<void> => {
    await window.webContents.debugger.sendCommand('Input.dispatchMouseEvent', { type: 'mouseWheel', x: 420, y: 340, deltaX: 0, deltaY })
    await delay(260)
    await waitFor(window, '!window.__historySmoke.loading')
    await delay(100)
  }
  const click = async (selector: string): Promise<void> => {
    const point = await window.webContents.executeJavaScript(`(() => { const r = document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect(); return { x:r.x+r.width/2, y:r.y+r.height/2 } })()`)
    await window.webContents.debugger.sendCommand('Input.dispatchMouseEvent', { type: 'mousePressed', ...point, button: 'left', clickCount: 1 })
    await window.webContents.debugger.sendCommand('Input.dispatchMouseEvent', { type: 'mouseReleased', ...point, button: 'left', clickCount: 1 })
    await delay(200)
  }
  try {
    await window.loadURL(process.env.DUTYDECK_HISTORY_FIXTURE_URL!)
    await waitFor(window, `document.querySelector('[data-smoke-scroll]') && window.__historySmoke`)
    window.webContents.debugger.attach('1.3')
    await delay(500)
    const initial = await read()
    const forbidden = await window.webContents.executeJavaScript(`Array.from(document.querySelectorAll('button')).map(x=>x.textContent).filter(x=>/较早历史|较新历史|上一页|下一页/.test(x))`)
    check(forbidden.length === 0, `仍有分页控件：${forbidden.join(',')}`)
    for (let step = 0; step < 180 && (await read()).start > 0; step++) await wheel(-900)
    await delay(250)
    const oldest = await read()
    const imageDrift = await window.webContents.executeJavaScript(`(async () => {
      const root = document.querySelector('[data-smoke-scroll]');
      const top = root.getBoundingClientRect().top;
      const anchor = Array.from(root.querySelectorAll('[data-message-id]')).find(x=>x.getBoundingClientRect().bottom>top);
      const before = anchor.getBoundingClientRect().top-top;
      const image = new Image();
      await new Promise(resolve=>setTimeout(resolve,120));
      image.src = 'data:image/svg+xml,'+encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="300" height="240"><rect width="300" height="240" fill="orange"/></svg>');
      await image.decode();
      root.querySelector('[data-message-id]').append(image);
      await new Promise(resolve=>setTimeout(resolve,180));
      const drift = Math.abs(anchor.getBoundingClientRect().top-root.getBoundingClientRect().top-before);
      const height = image.getBoundingClientRect().height;
      image.remove();
      await new Promise(resolve=>setTimeout(resolve,180));
      return { drift, height, decoded: image.complete && image.naturalHeight === 240 };
    })()`)
    check(imageDrift.decoded && imageDrift.height === 240 && imageDrift.drift <= 2, `图片延迟解码高度展开漂移：${JSON.stringify(imageDrift)}`)
    check(initial.start - oldest.start >= 500, `上滚仅跨越 ${initial.start - oldest.start} 条`)
    for (let step = 0; step < 180 && (await read()).end < (await read()).total; step++) await wheel(900)
    const diskTail = await read()
    check(diskTail.reading && diskTail.end === 720, '磁盘尾页必须仍处于历史模式')
    const tailCallsBefore = diskTail.calls.filter(mode => mode === 'tail').length
    await click('[data-smoke-append]')
    const pendingLive = await read()
    check(pendingLive.end === 720 && pendingLive.total === 721 && pendingLive.reading, '触底前实时消息侵入历史页')
    await wheel(15000)
    await wheel(100)
    const newest = await read()
    check(newest.end - oldest.end >= 500, `下滚仅跨越 ${newest.end - oldest.end} 条`)
    check(newest.end === newest.total && !newest.reading, '下滚未返回实时模式')
    check(newest.calls.filter(mode => mode === 'tail').length > tailCallsBefore, '磁盘尾页触底未实际调用 tail')
    const maxAnchorDrift = Math.max(0, ...newest.anchors)
    check(newest.anchors.length >= 12 && newest.missingAnchors === 0 && maxAnchorDrift <= 2, `锚点异常：samples=${newest.anchors.length}, missing=${newest.missingAnchors}, max=${maxAnchorDrift}px`)
    await click('[data-smoke-append]')
    const tailGap = await window.webContents.executeJavaScript(`(() => { const r=document.querySelector('[data-smoke-scroll]'); return r.scrollHeight-r.clientHeight-r.scrollTop })()`)
    check(tailGap <= 3, `追加实时消息未追随：gap=${tailGap}`)
    // 注入一次传输失败，生产组件必须呈现错误并允许人工重试。
    await window.webContents.executeJavaScript('window.__historySmoke.failNext=true')
    const beforeError = (await read()).calls.length
    for (let step = 0; step < 20 && (await read()).calls.length === beforeError; step++) await wheel(-900)
    await delay(400)
    const errorState = await read()
    check(Boolean(errorState.error), '失败未保持可见，可能自动重试吞掉错误')
    const retry = await window.webContents.executeJavaScript(`(() => { const b=Array.from(document.querySelectorAll('button')).find(x=>/重试|重新加载/.test(x.textContent)); if (!b) return false; b.setAttribute('data-smoke-retry',''); return true })()`)
    if (retry) { await click('[data-smoke-retry]'); check(!(await read()).error, '重试后错误未清除') }
    else check(false, '缺少可交互重试入口')
    // 请求发出后选中文本，模拟用户在异步等待期间开始阅读。
    await window.webContents.executeJavaScript('window.getSelection().removeAllRanges(); window.__historySmoke.selectDuringLoad=true')
    const beforeSelection = await read()
    for (let step = 0; step < 20 && (await read()).calls.length === beforeSelection.calls.length; step++) await wheel(-900)
    await delay(200)
    const selected = await read()
    check(selected.blockedCommits === beforeSelection.blockedCommits + 1 && selected.start === beforeSelection.start, '请求期间选区未阻止提交')
    await window.webContents.executeJavaScript('window.getSelection().removeAllRanges()')
    console.log(JSON.stringify({ imageDrift, selected, diskTail, pendingLive, scenario: 'continuous-history', initial, oldest, newest, maxAnchorDrift, tailGap, errorState, failures }, null, 2))
    assert.deepEqual(failures, [])
  } finally {
    window.destroy()
    await rm(userDataPath, { recursive: true, force: true })
  }
}

/** 让操作系统分配空闲端口，返回端口号，避免并行开发服务与回归脚本相互抢占。 */
async function findAvailablePort(): Promise<number> {
  return new Promise<number>((resolve, reject) => {
    /** 短暂监听只用于申请端口，交给 Vite 前先关闭。 */
    const server = createNetServer()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      /** TCP 地址由 Node 返回；字符串地址不是本测试使用的监听方式。 */
      const address = server.address()
      server.close((error) => {
        if (error) reject(error)
        else if (!address || typeof address === 'string') reject(new Error('无法分配 smoke 端口'))
        else resolve(address.port)
      })
    })
  })
}

/** 构建隔离 Electron 入口并启动临时 Vite 服务，结束时释放进程、端口及产物。 */
async function orchestrateSmoke(): Promise<void> {
  /** 已安装的 Vite 为真实生产组件提供别名、CSS 和 React 转换，不新增依赖。 */
  const { createServer } = await import('vite')
  /** 临时构建目录不触碰正在运行的开发或安装版产物。 */
  const buildDir = await mkdtemp(join(tmpdir(), 'agent-continuous-history-build-'))
  const vite = await createServer({ configFile: join(process.cwd(), 'vite.config.ts'), cacheDir: join(buildDir, 'vite-cache'), server: { port: await findAvailablePort(), strictPort: true, hmr: false } })
  try {
    await vite.listen()
    /** 使用系统实际分配的端口，允许与其他 smoke 并行运行。 */
    const address = vite.httpServer?.address()
    assert.ok(address && typeof address !== 'string')
    /** 只打包测试主进程入口，Electron 与 Vite 保留为现有外部依赖。 */
    const build = await Bun.build({ entrypoints: [join(process.cwd(), 'scripts/agent-continuous-history-smoke.ts')], outdir: buildDir, target: 'node', format: 'cjs', external: ['electron', 'vite'] })
    assert.ok(build.success, build.logs.join('\n'))
    /** 子进程仅打开隔离 fixture，不运行生产主进程服务。 */
    const electron = spawn(join(process.cwd(), 'node_modules/.bin/electron'), [build.outputs[0]!.path], {
      env: { ...process.env, DUTYDECK_HISTORY_FIXTURE_URL: `http://127.0.0.1:${address.port}/@fs${join(process.cwd(), 'scripts/agent-continuous-history-smoke.html')}` }, stdio: 'inherit',
    })
    await new Promise<void>((resolve, reject) => {
      /** 子进程失败或页面不响应时自动终止，避免验收永久等待。 */
      const timeout = setTimeout(() => { electron.kill('SIGTERM'); reject(new Error('连续历史 smoke 超时')) }, 240_000)
      electron.once('error', (error) => { clearTimeout(timeout); reject(error) })
      electron.once('exit', (code, signal) => {
        clearTimeout(timeout)
        if (code === 0) resolve()
        else reject(new Error(`连续历史 smoke 退出：code=${code}, signal=${signal}`))
      })
    })
  } finally {
    await vite.close()
    await rm(buildDir, { recursive: true, force: true })
  }
}

if (process.versions.electron) {
  void runElectronSmoke().then(async () => (await import('electron')).app.quit()).catch(async (error: unknown) => {
    console.error(error)
    ;(await import('electron')).app.exit(1)
  })
} else {
  void orchestrateSmoke().catch((error: unknown) => { console.error(error); process.exitCode = 1 })
}
