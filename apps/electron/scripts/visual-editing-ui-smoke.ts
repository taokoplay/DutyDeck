import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync, spawn } from 'node:child_process'
import { build } from 'esbuild'

/** 离线 UI 回归的全部产物与 Electron 数据均置于临时目录。 */
const directory = await mkdtemp(join(tmpdir(), 'dutydeck-editing-ui-'))
try {
  /** 使用合成色块验证真实媒体生命周期，不读取或改写任何正式作品。 */
  const video = join(directory, 'fixture.mp4')
  execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'color=c=blue:s=64x64:r=24:d=3', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', video])
  await build({ entryPoints: ['scripts/visual-editing-ui-smoke.fixture.tsx'], bundle: true, platform: 'browser', format: 'iife', outfile: join(directory, 'fixture.js'), tsconfig: 'tsconfig.json', define: { __EDITING_SMOKE_VIDEO__: JSON.stringify(Array.from(await readFile(video))) } })
  await writeFile(join(directory, 'index.html'), '<!doctype html><html><body><div id="root"></div><script src="fixture.js"></script></body></html>')
  await writeFile(join(directory, 'main.cjs'), `
const { app, BrowserWindow } = require('electron');
const assert = require('node:assert/strict');
app.setPath('userData', ${JSON.stringify(join(directory, 'user-data'))});
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');
app.whenReady().then(async () => {
 const win = new BrowserWindow({ show: true, webPreferences: { sandbox: true, contextIsolation: true } });
 const read = expression => win.webContents.executeJavaScript(expression);
 const wait = async expression => { const end = Date.now() + 10000; while (Date.now() < end) { if (await read(expression)) return; await new Promise(resolve => setTimeout(resolve, 20)); } throw new Error('等待失败: ' + expression); };
 try {
 await win.loadFile(${JSON.stringify(join(directory, 'index.html'))});
 await wait('document.querySelectorAll("video").length > 0');
 // Given 正式与待审均有视频 When 打开剪辑页 Then 只挂载正式播放器。
 assert.equal(await read('document.querySelectorAll("video").length'), 1, '剪辑页只能有一个播放器');
 assert.equal(await read('document.querySelector("[aria-label=正式时间线片段预演]") !== null'), true);
 assert.equal(await read('window.editingSmoke.calls.includes("media:review")'), false);
 await wait('document.querySelector("video").readyState >= 2');
 await read('window.oldVideo = document.querySelector("video"); window.oldVideo.play()');
 // When 键盘切换到待审 Then 正式视频卸载且停止，待审标识与范围保留。
 await read('document.querySelector("[role=tab][data-state=active]").focus()');
 win.focus();
 win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Right' });
 win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Right' });
 await wait('document.querySelector("[aria-label=待审声画预览]") && document.querySelectorAll("video").length === 1');
 await wait('window.oldVideo.paused');
 assert.equal(await read('window.oldVideo.isConnected'), false);
 assert.equal(await read('document.body.textContent.includes("非正式 · 未自动采用")'), true);
 assert.equal(await read('document.body.textContent.includes("0.00–2.00")'), true);
 // When 隐藏面板 Then 待审视频停止，重新显示不自动播放。
 await wait('document.querySelector("video").readyState >= 2');
 await read('window.reviewVideo = document.querySelector("video"); window.reviewVideo.play()');
 await read('window.editingSmoke.setActive(false)');
 await wait('window.reviewVideo.paused');
 await read('window.editingSmoke.setActive(true)');
 await wait('document.querySelector("video")?.readyState >= 2');
 assert.equal(await read('document.querySelector("video").paused'), true);
 // When 后台任务刷新 Then 保持当前来源；切集重置为正式预览。
 await read('window.editingSmoke.refresh()');
 await wait('document.querySelector("[aria-label=待审声画预览]") !== null');
 await read('window.editingSmoke.setEpisodeId("other")');
 await wait('document.querySelector("[aria-label=正式时间线片段预演]") && document.querySelectorAll("video").length === 1');
 // When 无待审任务 Then 保留正式预览且隐藏切换入口。
 await read('window.editingSmoke.timeline.exportJobs = []; window.editingSmoke.refresh()');
 await wait('document.querySelectorAll("[role=tab]").length === 0');
 assert.equal(await read('document.querySelectorAll("video").length'), 1);
 // When 预览生成失败 Then 默认正式预览仍可用，切换后展示错误。
 await read('window.editingSmoke.timeline.exportJobs = [{ id: "failed", productionId: "production", episodeId: "other", timelineRevision: 2, sourceHashes: [], settings: {}, status: "failed", message: "音轨素材缺失", createdAt: 2, updatedAt: 2, preview: { productionRevision: 3, candidateIds: [], range: { start: 0, end: 2 } } }]; window.editingSmoke.refresh()');
 await wait('document.querySelectorAll("[role=tab]").length === 2');
 assert.equal(await read('document.querySelector("[aria-label=正式时间线片段预演]") !== null'), true);
 await read('Array.from(document.querySelectorAll("[role=tab]")).find(tab => tab.textContent.includes("待审声画")).dispatchEvent(new MouseEvent("mousedown", { bubbles: true, button: 0 }))');
 await wait('document.body.textContent.includes("音轨素材缺失")');
 assert.equal(await read('document.querySelectorAll("video").length'), 0);
 // When 正在查看的待审任务消失后又出现 Then 保持正式预览，不被新任务抢占。
 await read('window.failedPreview = window.editingSmoke.timeline.exportJobs[0]; window.editingSmoke.timeline.exportJobs = []; window.editingSmoke.refresh()');
 await wait('document.querySelectorAll("[role=tab]").length === 0');
 await read('window.editingSmoke.timeline.exportJobs = [window.failedPreview]; window.editingSmoke.refresh()');
 await wait('document.querySelectorAll("[role=tab]").length === 2');
 assert.equal(await read('document.querySelector("[aria-label=正式时间线片段预演]") !== null'), true);
 console.log('PASS: 单播放器、默认正式、隐藏媒体不加载、键盘切换、旧视频停止、隐藏暂停、后台刷新、切集重置、无任务和失败边界');
 win.destroy(); app.exit(0);
 } catch (error) { console.error(error); console.error(await read('JSON.stringify({ text: document.body.textContent, calls: window.editingSmoke?.calls, focus: document.activeElement?.outerHTML })')); win.destroy(); app.exit(1); }
});
`)
  /** 使用隔离 Electron 验证真实 DOM 与媒体生命周期。 */
  const code = await new Promise<number | null>((resolve, reject) => {
    /** 本烟测不连接运行中的 Dev 或安装版。 */
    const child = spawn('node_modules/.bin/electron', [join(directory, 'main.cjs')], { stdio: 'inherit' })
    child.on('error', reject)
    child.on('exit', resolve)
  })
  if (code !== 0) throw new Error(`剪辑 UI smoke 失败：${code}`)
} finally { await rm(directory, { recursive: true, force: true }) }
