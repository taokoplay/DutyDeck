import { strict as assert } from 'node:assert'
import { spawn } from 'node:child_process'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { BrowserWindow } from 'electron'

/** 有界等待实际 React DOM 完成更新。 */
async function waitFor(window: BrowserWindow, expression: string): Promise<void> {
  const deadline = Date.now() + 12_000
  while (Date.now() < deadline) {
    if (await window.webContents.executeJavaScript(`Boolean(${expression})`)) return
    await new Promise<void>((resolve) => setTimeout(resolve, 40))
  }
  throw new Error(`界面断言超时：${expression}`)
}

/** 使用真实 BrowserWindow 验证双主题、窄面板、复制与重试；数据只在临时目录。 */
async function runElectronSmoke(): Promise<void> {
  const { app, BrowserWindow, nativeTheme } = await import('electron')
  const userDataPath = await mkdtemp(join(tmpdir(), 'canvas-load-error-smoke-'))
  const screenshotDir = join(tmpdir(), 'canvas-load-error-smoke-screenshots')
  await mkdir(screenshotDir, { recursive: true })
  app.setPath('userData', userDataPath)
  app.on('window-all-closed', () => undefined)
  await app.whenReady()
  const window = new BrowserWindow({ width: 800, height: 600, show: false, webPreferences: { backgroundThrottling: false } })
  try {
    for (const width of [800, 360]) {
      for (const theme of ['light', 'dark'] as const) {
        nativeTheme.themeSource = theme
        window.setSize(width, 600)
        await window.loadURL(`http://127.0.0.1:${process.env.PROMA_CANVAS_LOAD_ERROR_SMOKE_PORT}/@fs${join(process.cwd(), 'scripts/canvas-load-error-smoke.html')}`)
        await waitFor(window, `document.querySelector('[role="alert"]')`)
        await window.webContents.executeJavaScript(`document.documentElement.classList.toggle('dark', ${theme === 'dark'})`)
        assert.equal(await window.webContents.executeJavaScript(`document.body.textContent.includes('WIN32_5')`), true)
        assert.equal(await window.webContents.executeJavaScript(`document.body.textContent.includes('canvas-load-errors.json')`), true)
        assert.equal(await window.webContents.executeJavaScript(`document.body.textContent.includes('日志编号：7a69c5a0-2cb3-4ea0-9b21-10aa9b621e40')`), true)
        assert.equal(await window.webContents.executeJavaScript(`document.documentElement.scrollWidth <= window.innerWidth`), true)
        await window.webContents.executeJavaScript(`document.querySelectorAll('button')[0].click()`)
        await waitFor(window, `document.body.textContent.includes('诊断信息已复制')`)
        assert.equal(await window.webContents.executeJavaScript(`window.__canvasLoadSmoke.copied.includes('CANVAS_LOAD_FAILED') && window.__canvasLoadSmoke.copied.includes('WIN32_5') && window.__canvasLoadSmoke.copied.includes('7a69c5a0-2cb3-4ea0-9b21-10aa9b621e40')`), true)
        await window.webContents.executeJavaScript(`window.__canvasLoadSmoke.failCopy = true; document.querySelectorAll('button')[0].click()`)
        await waitFor(window, `document.body.textContent.includes('复制失败')`)
        await writeFile(join(screenshotDir, `${theme}-${width}.png`), (await window.webContents.capturePage()).toPNG())
        await window.webContents.executeJavaScript(`document.querySelectorAll('button')[1].click()`)
        await waitFor(window, `document.body.textContent.includes('重试已完成') && !document.querySelector('[role="alert"]')`)
      }
    }
    console.log('[画布加载错误 smoke] PASS：真实 Electron 双主题/双宽度、完整诊断、复制成功/失败与重试；截图 ' + screenshotDir)
  } finally {
    window.destroy()
    await rm(userDataPath, { recursive: true, force: true })
  }
}

/** 等待 Vite fixture 可访问，避免用固定 sleep 掩盖启动失败。 */
async function waitForVite(url: string): Promise<void> {
  const deadline = Date.now() + 20_000
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url)
      if (response.ok) return
    } catch {
      // Vite 尚未监听时继续有界重试。
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 100))
  }
  throw new Error('等待画布加载错误 smoke Vite 服务超时')
}

/** 让操作系统分配空闲回环端口，避免并行 smoke 相互占用固定端口。 */
async function findAvailablePort(): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const server = createServer()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      if (!address || typeof address === 'string') {
        server.close()
        reject(new Error('无法分配画布加载错误 smoke 端口'))
        return
      }
      server.close((error) => error ? reject(error) : resolve(String(address.port)))
    })
  })
}

/** Bun 父进程构建 Electron 入口、启动 Vite，并在退出时回收全部子进程。 */
async function orchestrateSmoke(): Promise<void> {
  const buildDir = await mkdtemp(join(tmpdir(), 'proma-canvas-load-error-smoke-build-'))
  const build = await Bun.build({
    entrypoints: [join(process.cwd(), 'scripts/canvas-load-error-smoke.ts')],
    outdir: buildDir,
    target: 'node',
    format: 'cjs',
    external: ['electron'],
  })
  if (!build.success) throw new Error(`构建 Electron smoke 入口失败：${build.logs.join('\n')}`)
  const outputPath = build.outputs[0]?.path
  if (!outputPath) throw new Error('Electron smoke 构建没有输出文件')
  /** 显式环境变量仍可固定端口；默认使用系统分配的空闲端口。 */
  const selectedPort = process.env.PROMA_CANVAS_LOAD_ERROR_SMOKE_PORT ?? await findAvailablePort()
  const selectedFixtureUrl = `http://127.0.0.1:${selectedPort}/@fs${join(process.cwd(), 'scripts/canvas-load-error-smoke.html')}`
  const vite = spawn(process.execPath, [join(process.cwd(), 'node_modules/vite/bin/vite.js'), '--host', '127.0.0.1', '--port', selectedPort, '--strictPort'], {
    cwd: process.cwd(),
    stdio: 'inherit',
  })
  try {
    await waitForVite(selectedFixtureUrl)
    const electron = spawn(join(process.cwd(), 'node_modules/.bin/electron'), [outputPath], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        PROMA_CANVAS_LOAD_ERROR_SMOKE_CHILD: '1',
        PROMA_CANVAS_LOAD_ERROR_SMOKE_PORT: selectedPort,
      },
      stdio: 'inherit',
    })
    const exitCode = await new Promise<number>((resolve, reject) => {
      /** 有界超时避免失败窗口或 timer 悬挂 CI。 */
      const timeout = setTimeout(() => {
        electron.kill('SIGTERM')
        reject(new Error('画布加载错误 Electron smoke 超时'))
      }, 120_000)
      electron.once('error', (error) => { clearTimeout(timeout); reject(error) })
      electron.once('exit', (code, signal) => {
        clearTimeout(timeout)
        if (signal) reject(new Error(`Electron smoke 被信号 ${signal} 终止`))
        else resolve(code ?? 1)
      })
    })
    assert.equal(exitCode, 0, `Electron smoke 退出码为 ${exitCode}`)
  } finally {
    vite.kill('SIGTERM')
    await rm(buildDir, { recursive: true, force: true })
  }
}

if (process.env.PROMA_CANVAS_LOAD_ERROR_SMOKE_CHILD === '1') {
  void runElectronSmoke().then(async () => {
    const { app } = await import('electron')
    app.quit()
  }).catch(async (error: unknown) => {
    console.error('[画布加载错误 smoke] FAIL', error)
    const { app } = await import('electron')
    app.exit(1)
  })
} else {
  void orchestrateSmoke().catch((error: unknown) => {
    console.error('[画布加载错误 smoke] FAIL', error)
    process.exitCode = 1
  })
}
