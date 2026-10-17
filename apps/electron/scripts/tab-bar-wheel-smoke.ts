import { strict as assert } from 'node:assert'
import { spawn } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { createServer as createNetServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { BrowserWindow } from 'electron'

/** 等待表达式在真实 renderer 中成立；window 为隔离窗口，expression 为只读断言，无返回值。 */
async function waitFor(window: BrowserWindow, expression: string): Promise<void> {
  /** 有界截止时间，防止界面加载失败挂住验证。 */
  const deadline = Date.now() + 10_000
  while (Date.now() < deadline) {
    if (await window.webContents.executeJavaScript(`Boolean(${expression})`)) return
    await new Promise<void>((resolve) => setTimeout(resolve, 25))
  }
  throw new Error(`标签栏界面断言超时：${expression}`)
}

/** 给指定标签栏发送真实 Chromium 滚轮输入，返回滚动后的水平位置。 */
async function wheel(window: BrowserWindow, selector: string, deltaX: number, deltaY: number, modifiers = 0): Promise<number> {
  /** 取视口中心命中生产组件；移动指针后以 CDP 输入避免直接调用事件 handler。 */
  const point = await window.webContents.executeJavaScript(`(() => {
    const rect = document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect();
    return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
  })()`)
  await window.webContents.debugger.sendCommand('Input.dispatchMouseEvent', { type: 'mouseMoved', ...point })
  await window.webContents.debugger.sendCommand('Input.dispatchMouseEvent', { type: 'mouseWheel', ...point, deltaX, deltaY, modifiers })
  await window.webContents.executeJavaScript('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))')
  return window.webContents.executeJavaScript(`document.querySelector(${JSON.stringify(selector)}).scrollLeft`)
}

/** 验证真实标签栏的双向、对角干扰、竖滚轮、Shift 和边界；只读写临时浏览器数据。 */
async function runElectronSmoke(): Promise<void> {
  /** Electron 只在子进程加载，Bun 父进程仅负责构建与本地服务。 */
  const { app, BrowserWindow } = await import('electron')
  /** 独立 userData 防止测试读取或修改用户登录、会话及窗口状态。 */
  const userDataPath = await mkdtemp(join(tmpdir(), 'tab-bar-wheel-user-'))
  app.setPath('userData', userDataPath)
  app.on('window-all-closed', () => undefined)
  await app.whenReady()
  /** 隐藏的真实 Chromium 窗口，保持动画帧可用。 */
  const window = new BrowserWindow({ width: 560, height: 300, show: false, webPreferences: { backgroundThrottling: false } })
  /** 收集所有场景失败，确保旧实现的两个标签栏都经过复现。 */
  const failures: string[] = []
  try {
    await window.loadURL(process.env.DUTYDECK_TAB_WHEEL_FIXTURE_URL!)
    await waitFor(window, `document.querySelector('[role="tablist"]') && document.querySelector('.main-tabbar')`)
    window.webContents.debugger.attach('1.3')
    for (const selector of ['[data-smoke-workspace] [role="tablist"]', '[data-smoke-main] .overflow-x-auto']) {
      /** 每个标签栏都必须真实溢出，否则方向断言没有意义。 */
      const query = `document.querySelector(${JSON.stringify(selector)})`
      await waitFor(window, `${query}.scrollWidth - ${query}.clientWidth > 400`)
      for (const [label, dx, dy, expected, modifiers] of [
        ['Given 向右滑动夹带反向纵轴 When 滚动 Then 向右', 80, -2, 280, 0],
        ['Given 向左滑动夹带反向纵轴 When 滚动 Then 向左', -80, 2, 120, 0],
        ['Given 纯横向滑动 When 滚动 Then 保留横轴幅度', 40, 0, 240, 0],
        ['Given 普通滚轮 When 向下滚动 Then 横向浏览', 0, 40, 240, 0],
        ['Given 普通滚轮 When 向上滚动 Then 反向浏览', 0, -40, 160, 0],
        ['Given Shift 滚轮 When 滚动 Then 不重复或反转位移', 0, 40, 240, 8],
      ] as const) {
        // Chromium 会锁定同一段滚动的命中目标；场景间等待该手势结束。
        await new Promise<void>((resolve) => setTimeout(resolve, 180))
        await window.webContents.executeJavaScript(`${query}.scrollLeft = 200`)
        /** 实际位移必须与主轴输入一致，不能被较小的反向干扰接管。 */
        const actual = await wheel(window, selector, dx, dy, modifiers)
        if (Math.abs(actual - expected) > 1) failures.push(`${selector} ${label}：预期 ${expected}，实际 ${actual}`)
      }
      // 同一方向的连续输入中，纵轴正负交替不得导致回跳。
      await window.webContents.executeJavaScript(`${query}.scrollLeft = 200`)
      for (const dy of [1, -1, 2, -2, 0]) {
        /** 读取前后位置，验证事件流而非单一终点。 */
        const before = await window.webContents.executeJavaScript(`${query}.scrollLeft`)
        const after = await wheel(window, selector, 20, dy)
        if (after <= before) failures.push(`${selector} 连续右滑回跳：${before} -> ${after}`)
      }
      await window.webContents.executeJavaScript(`${query}.scrollLeft = 0`)
      assert.equal(await wheel(window, selector, -80, 0), 0, '左边界不得反弹到另一端')
      await window.webContents.executeJavaScript(`${query}.scrollLeft = ${query}.scrollWidth`)
      await wheel(window, selector, 80, 0)
      // 悬停关闭按钮会改变标签宽度；以布局稳定后的实时边界验证，避免把宽度变化当成方向错误。
      await new Promise<void>((resolve) => setTimeout(resolve, 250))
      await wheel(window, selector, 100_000, 0)
      assert.equal(await window.webContents.executeJavaScript(`${query}.scrollLeft >= ${query}.scrollWidth - ${query}.clientWidth - 1`), true, '右边界应可达')
    }
    // 先移开主标签栏的鼠标，等待其悬停预览退出，避免预览 Portal 遮挡下面的触摸目标。
    await window.webContents.debugger.sendCommand('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 540, y: 260 })
    await waitFor(window, `!document.body.textContent.includes('暂无消息')`)
    // 直接触屏不走 wheel：以原生触摸输入验证右侧标签栏仍可双向滑动。
    await window.webContents.debugger.sendCommand('Emulation.setTouchEmulationEnabled', { enabled: true })
    for (const direction of [-1, 1]) {
      /** 每次重置视口，避免上一轮边界和惯性影响触摸方向断言。 */
      const point = await window.webContents.executeJavaScript(`(() => {
        const list = document.querySelector('[data-smoke-workspace] [role="tablist"]');
        list.scrollLeft = 300;
        const rect = list.getBoundingClientRect();
        return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
      })()`)
      assert.equal(await window.webContents.executeJavaScript(`Boolean(document.elementFromPoint(${point.x}, ${point.y}).closest('[data-smoke-workspace]'))`), true, '触摸必须命中右侧标签栏')
      await window.webContents.debugger.sendCommand('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ ...point, id: 1 }] })
      for (let step = 1; step <= 8; step += 1) {
        await window.webContents.debugger.sendCommand('Input.dispatchTouchEvent', {
          type: 'touchMove', touchPoints: [{ x: point.x + direction * step * 12, y: point.y, id: 1 }],
        })
        await new Promise<void>((resolve) => setTimeout(resolve, 20))
      }
      await window.webContents.debugger.sendCommand('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
      await new Promise<void>((resolve) => setTimeout(resolve, 500))
      /** 手指向左时内容应向右滚，手指向右时内容应向左滚。 */
      const after = await window.webContents.executeJavaScript(`document.querySelector('[data-smoke-workspace] [role="tablist"]').scrollLeft`)
      assert.ok((after - 300) * direction < 0, `触屏方向错误：direction=${direction}, scrollLeft=${after}`)
      assert.equal(await window.webContents.executeJavaScript(`document.querySelector('[data-smoke-workspace] [aria-selected="true"]').textContent`), '文件', '滑动不应误切换标签')
    }
    assert.deepEqual(failures, [], failures.join('\n'))
    console.log('[标签栏滚动 smoke] PASS：两种生产标签栏的双向横滑、纵轴干扰、连续滑动、普通/Shift 滚轮及左右边界；右侧原生触屏双向滑动且不误切换。')
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
  const buildDir = await mkdtemp(join(tmpdir(), 'tab-bar-wheel-build-'))
  const vite = await createServer({ configFile: join(process.cwd(), 'vite.config.ts'), server: { port: await findAvailablePort(), strictPort: true } })
  try {
    await vite.listen()
    /** 使用系统实际分配的端口，允许与其他 smoke 并行运行。 */
    const address = vite.httpServer?.address()
    assert.ok(address && typeof address !== 'string')
    /** 只打包测试主进程入口，Electron 与 Vite 保留为现有外部依赖。 */
    const build = await Bun.build({ entrypoints: [join(process.cwd(), 'scripts/tab-bar-wheel-smoke.ts')], outdir: buildDir, target: 'node', format: 'cjs', external: ['electron', 'vite'] })
    assert.ok(build.success, build.logs.join('\n'))
    /** 子进程仅打开隔离 fixture，不运行生产主进程服务。 */
    const electron = spawn(join(process.cwd(), 'node_modules/.bin/electron'), [build.outputs[0]!.path], {
      env: { ...process.env, DUTYDECK_TAB_WHEEL_FIXTURE_URL: `http://127.0.0.1:${address.port}/@fs${join(process.cwd(), 'scripts/tab-bar-wheel-smoke.html')}` }, stdio: 'inherit',
    })
    await new Promise<void>((resolve, reject) => {
      /** 子进程失败或页面不响应时自动终止，避免验收永久等待。 */
      const timeout = setTimeout(() => { electron.kill('SIGTERM'); reject(new Error('标签栏滚动 smoke 超时')) }, 60_000)
      electron.once('error', (error) => { clearTimeout(timeout); reject(error) })
      electron.once('exit', (code, signal) => {
        clearTimeout(timeout)
        if (code === 0) resolve()
        else reject(new Error(`标签栏滚动 smoke 退出：code=${code}, signal=${signal}`))
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
