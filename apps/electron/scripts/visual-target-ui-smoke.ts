import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawn } from 'node:child_process'
import { build } from 'esbuild'

/** 全部产物及 Electron userData 使用临时目录，不连接运行中的 Dev。 */
const directory = await mkdtemp(join(tmpdir(), 'dutydeck-visual-target-ui-'))
try {
  await build({ entryPoints: ['scripts/visual-target-ui-smoke.fixture.tsx'], bundle: true, platform: 'browser', format: 'iife', outfile: join(directory, 'fixture.js'), tsconfig: 'tsconfig.json' })
  await writeFile(join(directory, 'index.html'), '<!doctype html><html><body><div id="root"></div><script src="fixture.js"></script></body></html>')
  await writeFile(join(directory, 'main.cjs'), `
const { app, BrowserWindow } = require('electron');
const assert = require('node:assert/strict');
app.setPath('userData', ${JSON.stringify(join(directory, 'user-data'))});
app.whenReady().then(async () => {
 const win = new BrowserWindow({ show: false, webPreferences: { sandbox: true, contextIsolation: true } });
 const read = expression => win.webContents.executeJavaScript(expression);
 const wait = async expression => { const end = Date.now() + 10000; while (Date.now() < end) { if (await read(expression)) return; await new Promise(resolve => setTimeout(resolve, 20)); } throw new Error('等待失败: ' + expression); };
 try {
 await win.loadFile(${JSON.stringify(join(directory, 'index.html'))});
 await wait('window.targetSmoke?.current()?.productionTitle === "第一部作品" && document.querySelector(".vp-top strong")?.textContent === "第一部作品"');
 await read('document.querySelector("#send-snapshot").click()');
 assert.equal(await read('window.targetSmoke.sent()[0].productionId'), 'first');
 assert.equal(await read('window.targetSmoke.sent()[0].source'), 'current-view');
 // Given 第一部已加载 When 从真实目录切到第二部且延迟读取 Then 立即绑定新作品身份。
 await read('window.targetSmoke.delay(); document.querySelector("[aria-label=影像项目目录]").click()');
 await wait('document.querySelector(".vp-directory") !== null');
 await read('Array.from(document.querySelectorAll(".vp-directory button")).find(button => button.textContent.includes("第二部作品")).click()');
 await wait('window.targetSmoke.pending.length > 0 && window.targetSmoke.current()?.productionId === "second"');
 assert.equal(await read('window.targetSmoke.sent()[0].productionId'), 'first');
 await read('document.querySelector("#send-snapshot").click()');
 assert.equal(await read('window.targetSmoke.sent()[0].productionId'), 'second');
 assert.notEqual(await read('window.targetSmoke.sent()[0].title'), '第一部作品');
 await read('window.targetSmoke.release()');
 await wait('window.targetSmoke.current()?.productionTitle === "第二部作品"');
 await read('document.querySelector("#send-snapshot").click()');
 assert.equal(await read('window.targetSmoke.sent()[0].productionId'), 'second');
 // When 后台版本改变 Then 当前目标更新，之前发送的版本保持冻结。
 await read('window.targetSmoke.delay(); window.targetSmoke.refresh()');
 await wait('window.targetSmoke.pending.length > 0');
 await read('document.querySelector("#send-snapshot").click()');
 assert.equal(await read('window.targetSmoke.sent()[0].productionId'), 'second');
 await read('window.targetSmoke.release()');
 await wait('window.targetSmoke.current()?.productionRevision === 2');
 assert.equal(await read('window.targetSmoke.sent()[0].productionRevision'), 1);
 // When 同作品切换会话并延迟读取 Then 旧会话撤销，新会话只使用自身目录标题。
 await read('window.targetSmoke.delay(); window.targetSmoke.setSessionId("session-two")');
 await wait('window.targetSmoke.pending.length > 0 && window.targetSmoke.current("session-one") === null && window.targetSmoke.current("session-two")?.productionId === "second"');
 assert.notEqual(await read('window.targetSmoke.current("session-two")?.productionTitle'), '第二部作品');
 await read('window.targetSmoke.release()');
 await wait('window.targetSmoke.current("session-two")?.productionTitle === "新会话第二部作品"');
 assert.equal(await read('window.targetSmoke.current("session-one")'), null);
 // When 隐藏与卸载 Then 撤销当前目标；重新显示恢复正式版本。
 await read('window.targetSmoke.setActive(false)');
 await wait('window.targetSmoke.current() === null');
 await read('window.targetSmoke.setActive(true)');
 await wait('window.targetSmoke.current()?.productionRevision === 2');
 await read('window.targetSmoke.setMounted(false)');
 await wait('window.targetSmoke.current() === null && !document.querySelector("[data-testid=visual-production-workspace]")');
 assert.deepEqual(await read('window.targetSmoke.errors'), []);
 console.log('PASS: 真实工作台目录切换、延迟加载与后台刷新保留选中身份、发送快照冻结、后台版本刷新、会话隔离、隐藏恢复、卸载清理；模拟发送不代表完整 AgentView 验收');
 win.destroy(); app.exit(0);
 } catch (error) { console.error(error); console.error(await read('JSON.stringify({ text: document.body.textContent, calls: window.targetSmoke?.calls, errors: window.targetSmoke?.errors })')); win.destroy(); app.exit(1); }
});
`)
  /** 独立进程只执行上述离线测试。 */
  const code = await new Promise<number | null>((resolve, reject) => {
    const child = spawn('node_modules/.bin/electron', [join(directory, 'main.cjs')], { stdio: 'inherit' })
    child.on('error', reject)
    child.on('exit', resolve)
  })
  if (code !== 0) throw new Error(`影像目标 UI smoke 失败：${code}`)
} finally { await rm(directory, { recursive: true, force: true }) }
