import { mkdtemp, writeFile, rm, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawn } from 'node:child_process'
import { build } from 'esbuild'

/** 可选截图目录仅保留模拟界面，默认不写额外产物。 */
const artifactDirectory = process.env.COMPUTER_USE_SMOKE_ARTIFACT_DIR
/** 全部中间构建文件在测试结束后删除。 */
const directory = await mkdtemp(join(tmpdir(), 'dutydeck-computer-use-ui-'))
try {
  /** 使用实际 Tailwind 配置和主题样式，验证真实字号、换行与深浅色布局。 */
  const cssCode = await new Promise<number | null>((resolve, reject) => {
    const child = spawn('node_modules/.bin/tailwindcss', ['-c', 'tailwind.config.js', '-i', 'src/renderer/styles/globals.css', '-o', join(directory, 'fixture.css')], { stdio: 'inherit' })
    child.on('error', reject)
    child.on('exit', resolve)
  })
  if (cssCode !== 0) throw new Error(`UI 样式构建失败：${cssCode}`)
  if (artifactDirectory) await mkdir(artifactDirectory, { recursive: true })
  await build({ entryPoints: ['scripts/computer-use-ui-smoke.fixture.tsx'], bundle: true, platform: 'browser', format: 'iife', outfile: join(directory, 'fixture.js'), tsconfig: 'tsconfig.json' })
  await writeFile(join(directory, 'index.html'), '<!doctype html><html class="dark"><head><meta charset="utf-8"><link rel="stylesheet" href="fixture.css"></head><body class="bg-content-area text-foreground"><div id="root"></div><script src="fixture.js"></script></body></html>')
  await writeFile(join(directory, 'main.cjs'), `
const { app, BrowserWindow } = require('electron');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const artifactDirectory = ${JSON.stringify(artifactDirectory ?? null)};
app.setPath('userData', ${JSON.stringify(join(directory, 'user-data'))});
app.whenReady().then(async () => {
 const win = new BrowserWindow({ show: false, width: 1100, height: 1050, webPreferences: { sandbox: true, contextIsolation: true, backgroundThrottling: false } });
 const read = expression => win.webContents.executeJavaScript(expression);
 const wait = async expression => { const end = Date.now() + 10000; while (Date.now() < end) { if (await read(expression)) return; await new Promise(r => setTimeout(r, 20)); } throw new Error('等待失败: ' + expression); };
 // 截图等待主题的 150ms 颜色过渡结束，避免记录中间帧。
 const capture = async name => { await new Promise(resolve => setTimeout(resolve, 200)); await read('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))'); if (artifactDirectory) await fs.writeFile(path.join(artifactDirectory, name + '.png'), (await win.webContents.capturePage()).toPNG()); };
 const checkWidth = async () => { assert.equal(await read('document.documentElement.scrollWidth <= window.innerWidth'), true, '页面不应横向溢出'); };
 const click = label => read('Array.from(document.querySelectorAll("button")).find(b => b.textContent.trim() === ' + JSON.stringify(label) + ').click()');
 try {
 await win.loadFile(${JSON.stringify(join(directory, 'index.html'))});
 await wait('window.computerUseSmoke?.listeners() === 1 && document.querySelector("[role=switch]")?.getAttribute("aria-checked") === "false"');
 assert.equal(await read('Array.from(document.querySelectorAll("button")).find(b => b.textContent.trim() === "验证系统权限").disabled'), true);
 await checkWidth(); await capture('computer-use-dark');
 await click('安装 Driver');
 await wait('document.body.textContent.includes("正在下载…")');
 assert.equal(await read('Array.from(document.querySelectorAll("button")).find(b => b.textContent.trim() === "选择 Driver").disabled'), true);
 assert.equal(await read('Array.from(document.querySelectorAll("button")).find(b => b.textContent.trim() === "验证系统权限").disabled'), true);
 assert.equal(await read('Array.from(document.querySelectorAll("button")).filter(b => b.textContent.trim() === "正在下载…").length'), 1);
 await capture('computer-use-downloading');
 await read('window.computerUseSmoke.finishInstall(false)');
 await wait('document.body.textContent.includes("模拟网络错误") && document.body.textContent.includes("重试安装")');
 await click('重试安装'); await wait('document.body.textContent.includes("正在下载…")');
 await read('window.computerUseSmoke.finishInstall(true)');
 await wait('document.body.textContent.includes("Driver 0.38.0 已安装")');
 assert.equal(await read('document.querySelector("[role=switch]").getAttribute("aria-checked")'), 'false');
 await read('document.querySelector("[role=switch]").click()');
 await wait('document.querySelector("[role=switch]").getAttribute("aria-checked") === "true"');
 await click('选择 Driver'); await wait('document.body.textContent.includes("/fixture/cua-driver")');
 await click('检测安装'); await wait('document.body.textContent.includes("0.38.0")');
 await click('验证系统权限'); await wait('Array.from(document.querySelectorAll(".settings-card")).some(card => card.textContent.includes("辅助功能") && card.textContent.includes("屏幕录制") && (card.textContent.match(/本次通过/g) || []).length === 2)');
 assert.ok(await read('document.body.textContent.includes("最近预检：")'));
 await read('window.computerUseSmoke.activate()');
 await wait('document.querySelector("#owner").textContent.includes("测试窗口")');
 assert.equal(await read('document.querySelector("#other").textContent'), '');
 await read('window.computerUseSmoke.holdCheck()');
 await click('检测安装');
 await wait('Array.from(document.querySelectorAll("button")).find(b => b.textContent.trim() === "检测安装").disabled');
 assert.equal(await read('Array.from(document.querySelectorAll("button")).filter(b => b.textContent.trim() === "停止操作").every(b => !b.disabled)'), true);
 await click('停止操作'); await wait('document.body.textContent.includes("模拟停止失败")');
 assert.ok(await read('document.querySelector("#owner").textContent.includes("测试窗口")'));
 await read('window.computerUseSmoke.allowStop()'); await click('停止操作');
 await wait('document.querySelector("#owner").textContent === ""');
 assert.deepEqual(await read('window.computerUseSmoke.calls'), ['install','install','enabled','choose','check','permissions','check','stop:operation','stop:operation']);
 await read('window.computerUseSmoke.finishCheck()');
 await wait('!Array.from(document.querySelectorAll("button")).find(b => b.textContent.trim() === "检测安装").disabled');
 assert.equal(await read('document.querySelector("#owner").textContent'), '');
 await read('document.documentElement.classList.remove("dark")');
 await wait('getComputedStyle(document.body).backgroundColor === "rgb(255, 255, 255)"');
 await checkWidth(); await capture('computer-use-light');
 await read('window.computerUseSmoke.setPlatform("windows")');
 await wait('document.body.textContent.includes("UI Automation") && document.body.textContent.includes("屏幕捕获")');
 assert.equal(await read('document.body.textContent.includes("辅助功能")'), false);
 await read('window.computerUseSmoke.setPath("C:/Users/" + "very-long-directory-name/".repeat(15) + "cua-driver.exe")');
 win.setContentSize(480, 1100);
 await wait('window.innerWidth === 480');
 await checkWidth(); await capture('computer-use-narrow-windows');
 await read('window.computerUseSmoke.unmount()');
 await wait('window.computerUseSmoke.listeners() === 0');
 console.log('PASS: UI explicit install, progress, failure/retry, no auto-enable, choose, installation and permission check, session isolation, independent stop, single subscription and cleanup, dark/light themes, narrow layout and Windows terminology');
 win.destroy(); app.exit(0);
 } catch (error) { console.error(error); win.destroy(); app.exit(1); }
});
`)
  /** 启动独立 Electron，仅加载模拟页面。 */
  const code = await new Promise<number | null>((resolve, reject) => {
    const child = spawn('node_modules/.bin/electron', [join(directory, 'main.cjs')], { stdio: 'inherit' })
    child.on('error', reject)
    child.on('exit', resolve)
  })
  if (code !== 0) throw new Error(`UI smoke 失败：${code}`)
} finally { await rm(directory, { recursive: true, force: true }) }
