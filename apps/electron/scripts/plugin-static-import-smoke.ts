import { strict as assert } from 'node:assert'
import { generateKeyPairSync } from 'node:crypto'
import { createServer } from 'node:http'
import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir, homedir } from 'node:os'
import { join } from 'node:path'
import type { BrowserWindow } from 'electron'
import { createPluginPackage, createStandardPluginFiles } from '@dutydeck/plugin-kit'
import { AgentPluginRegistry } from '../src/main/lib/agent-modules/plugin-registry'
import { DataRootInstanceLeaseRegistry } from '../src/main/lib/data-root-instance-lease'
import { ContentPluginManager } from '../src/main/lib/agent-plugins/content-plugin-manager'
import { ContentPluginService } from '../src/main/lib/agent-plugins/content-plugin-service'
import { createContentPluginMutationGuard } from '../src/main/lib/agent-plugins/content-plugin-mutation-guard'
import { createStaticImportPlan } from '../src/main/lib/agent-plugins/import/import-plan'
import { PluginImportReceiptStore } from '../src/main/lib/agent-plugins/import/import-receipt-store'
import { registerStaticPluginImportIpc } from '../src/main/lib/agent-plugins/import/plugin-static-import-ipc'
import { createWorkspaceOperationGuard } from '../src/main/lib/workspace-operation-guard'
import { getConfigDir, getMcpOAuthCredentialsPath, getProxySettingsPath, getWorkspaceMcpPath } from '../src/main/lib/config-paths'
import { writeJsonFileAtomic, writeTextFileAtomic } from '../src/main/lib/safe-file'

const CHILD = 'DUTYDECK_STATIC_IMPORT_SMOKE'
const FIXTURE_URL = 'https://fixture.example.com/mcp'
const button = (text: string): string => `[...document.querySelectorAll('button')].find(node=>node.textContent.trim()===${JSON.stringify(text)})`
const confirmation = `document.querySelectorAll('input[type="checkbox"]')[0]`
const trust = `document.querySelectorAll('input[type="checkbox"]')[1]`
async function waitFor(window: BrowserWindow, expression: string): Promise<void> {
  const deadline = Date.now() + 12_000
  while (Date.now() < deadline) {
    try { if (await window.webContents.executeJavaScript(`Boolean(${expression})`)) return }
    catch (error) { throw new Error(`验收表达式失败：${expression}`, { cause: error }) }
    await new Promise(resolve => setTimeout(resolve, 30))
  }
  throw new Error(`等待失败：${expression}\n${await window.webContents.executeJavaScript('document.body.innerText')}`)
}
async function click(window: BrowserWindow, expression: string): Promise<void> {
  await waitFor(window, `${expression} && !(${expression}).disabled`)
  const point = await window.webContents.executeJavaScript(`(async()=>{const n=${expression};n.scrollIntoView({block:'center'});await new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)));const b=n.getBoundingClientRect();return {x:Math.round(b.x+b.width/2),y:Math.round(b.y+b.height/2)}})()`) as { x: number; y: number }
  // sendInputEvent 只提交输入；先确认 click 已被页面接收，再等待 React 提交，避免 idle 在操作开始前放行。
  await window.webContents.executeJavaScript(`document.documentElement.dataset.smokeClick='pending'; document.addEventListener('click',()=>{document.documentElement.dataset.smokeClick='received'}, {once:true})`)
  window.webContents.sendInputEvent({ type: 'mouseDown', ...point, button: 'left', clickCount: 1 })
  window.webContents.sendInputEvent({ type: 'mouseUp', ...point, button: 'left', clickCount: 1 })
  await waitFor(window, `document.documentElement.dataset.smokeClick==='received'`)
  await window.webContents.executeJavaScript('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))')
}

/** 真实协议与本机HTTP socket，不伪造validateMcpServer成功；不访问公网。 */
async function run(root: string, buildDir: string, html: string): Promise<void> {
  assert.equal(realpathSync(homedir()), root)
  const { app, BrowserWindow, ipcMain } = require('electron') as typeof import('electron')
  app.setPath('userData', join(root, 'electron')); app.on('window-all-closed', () => undefined)
  await app.whenReady()
  assert.equal(getConfigDir(), join(root, '.DutyDeck'))
  assert.equal(getMcpOAuthCredentialsPath(), join(root, '.DutyDeck/mcp-oauth-credentials.json'))
  assert.equal(getProxySettingsPath(), join(root, '.DutyDeck/proxy-settings.json'))
  assert.equal(existsSync(getMcpOAuthCredentialsPath()), false)
  writeJsonFileAtomic(getProxySettingsPath(), { enabled: false, mode: 'system', manualUrl: '' })
  const { StaticPluginImportService } = await import('../src/main/lib/agent-plugins/import/mcp-importer')
  const { getWorkspaceMcpConfig, saveWorkspaceMcpConfig } = await import('../src/main/lib/agent-workspace-manager')
  let ready = false; let initializes = 0; let discoveries = 0
  const server = createServer(async (request, response) => {
    if (request.method !== 'POST') { response.writeHead(405); response.end(); return }
    let body = ''
    for await (const chunk of request) { body += String(chunk); if (body.length > 32768) { response.writeHead(413); response.end(); return } }
    const message = JSON.parse(body) as { id?: number; method: string; params?: { protocolVersion?: string } }
    if (message.method === 'initialize') initializes++
    if (!ready) { response.writeHead(503); response.end('fixture unavailable'); return }
    if (message.id === undefined) { response.writeHead(202); response.end(); return }
    let result: unknown
    if (message.method === 'initialize') result = { protocolVersion: message.params?.protocolVersion ?? '2025-03-26', capabilities: { tools: {} }, serverInfo: { name: 'DutyDeck local fixture', version: '1.0.0' } }
    else if (message.method === 'tools/list') { discoveries++; result = { tools: [{ name: 'fixture_read', description: '本机只读验收工具，不执行调用', inputSchema: { type: 'object', properties: {} } }] } }
    else result = {}
    response.writeHead(200, { 'Content-Type': 'application/json' }); response.end(JSON.stringify({ jsonrpc: '2.0', id: message.id, result }))
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address(); assert(address && typeof address !== 'string')
  const originalFetch = globalThis.fetch
  // 只在本smoke子进程替换精确fixture地址；保留真实SDK HTTP交互，其他出站请求一律拒绝。
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    assert.equal(url, FIXTURE_URL)
    return originalFetch(`http://127.0.0.1:${address.port}/mcp`, init)
  }) as typeof fetch
  const registry = new AgentPluginRegistry()
  let changes = 0; let busy = false
  const contentManager = new ContentPluginManager(new ContentPluginService(join(root, 'content')), registry, () => { changes++ })
  contentManager.initialize()
  const bytes = createPluginPackage(createStandardPluginFiles('fixture.static', '静态导入验收'), generateKeyPairSync('ed25519').privateKey)
  const plan = createStaticImportPlan({ recipeId: 'fixture.static', recipeVersion: '1.0.0', source: { name: 'dsh-fixture-static', version: '1.0.0', sha256: 'a'.repeat(64), url: 'https://registry.npmjs.org/dsh-fixture-static/-/dsh-fixture-static-1.0.0.tgz', license: 'MIT' }, contentBytes: bytes, mcp: { name: 'fixture-docs', type: 'http', url: FIXTURE_URL, timeout: 3 } })
  const guard = createWorkspaceOperationGuard({ getWorkspaceIdBySessionId: () => undefined, getWorkspaceIdBySlug: slug => slug === 'fixture-a' ? 'workspace-a' : slug === 'fixture-b' ? 'workspace-b' : undefined, getWorkspaceOperationBlockReason: () => undefined })
  const service = new StaticPluginImportService({
    plans: [plan], receipts: new PluginImportReceiptStore(join(root, 'receipts')),
    content: { snapshot: () => contentManager.service.snapshot(), previewBytes: bytes => contentManager.previewBytes(bytes), install: (token, key) => contentManager.install(token, key), uninstall: (id, revision) => contentManager.uninstall(id, revision) },
    runContentMutation: createContentPluginMutationGuard(() => busy, new DataRootInstanceLeaseRegistry({ homeDir: root })),
    assertWorkspaceCurrent: workspace => { assert(['workspace-a', 'workspace-b'].includes(workspace.id)); assert.equal(workspace.slug, workspace.id.replace('workspace-', 'fixture-')); guard.assertWorkspaceWritable(workspace.id) },
    mcpOptions: { runWorkspaceSlugWrite: (slug, effect) => guard.runWorkspaceSlugWrite(slug, effect) },
  })
  const invalidConfigPath = getWorkspaceMcpPath('fixture-a')
  writeTextFileAtomic(invalidConfigPath, '{invalid fixture')
  for (let count = 0; count < 10; count++) assert.throws(() => service.preview(plan.hash, { id: 'workspace-a', slug: 'fixture-a' }), /PLUGIN_IMPORT_MCP_CONFIG_INVALID/)
  assert.equal(readFileSync(invalidConfigPath, 'utf8'), '{invalid fixture')
  rmSync(invalidConfigPath)
  // Given 合法主配置旁有预置辅助链接，When strict 保存，Then 不得覆盖链接目标。
  const linkFailures: string[] = []
  for (const suffix of ['tmp', 'bak']) {
    const victim = join(root, `unrelated-${suffix}.txt`)
    writeTextFileAtomic(victim, '用户自有 fixture，必须保留')
    writeTextFileAtomic(invalidConfigPath, JSON.stringify({ servers: {} }))
    rmSync(`${invalidConfigPath}.tmp`, { force: true }); rmSync(`${invalidConfigPath}.bak`, { force: true })
    symlinkSync(victim, `${invalidConfigPath}.${suffix}`)
    try { saveWorkspaceMcpConfig('fixture-a', { servers: { safe: { type: 'http', enabled: false, url: FIXTURE_URL } } }, { strictImport: true }) }
    catch { /* 安全拒绝允许；不允许链接目标被覆盖。 */ }
    if (readFileSync(victim, 'utf8') !== '用户自有 fixture，必须保留') linkFailures.push(suffix)
    rmSync(`${invalidConfigPath}.${suffix}`, { force: true }); rmSync(invalidConfigPath, { force: true })
  }
  assert.deepEqual(linkFailures, [], 'strict 保存不能追随 tmp/bak 链接覆盖无关文件')
  const window = new BrowserWindow({ width: 1000, height: 900, show: true, webPreferences: { preload: join(buildDir, 'preload/index.js'), contextIsolation: true, sandbox: true, nodeIntegration: false } })
  registerStaticPluginImportIpc({ ipc: ipcMain, service, isAuthorizedSender: event => event.sender === window.webContents && event.senderFrame === window.webContents.mainFrame,
    resolveWorkspace: id => { assert(['workspace-a', 'workspace-b'].includes(id)); return { id, slug: id.replace('workspace-', 'fixture-') } } })
  const errors: string[] = []
  window.webContents.on('console-message', (_event, level, message) => { if (level >= 3) { errors.push(message); console.error('[验收页面]', message) } })
  const idle = async (): Promise<void> => waitFor(window, `!document.querySelector('[role="status"]')`)
  try {
    // 同一真实preload但不同窗口不能使用静态导入IPC。
    const other = new BrowserWindow({ show: false, webPreferences: { preload: join(buildDir, 'preload/index.js'), contextIsolation: true, sandbox: true, nodeIntegration: false } })
    try {
      await other.loadURL('about:blank')
      const denied = await other.webContents.executeJavaScript("window.electronAPI.pluginStaticImport.list().then(() => 'unexpected success', error => String(error))")
      assert.match(String(denied), /PLUGIN_IMPORT_ACCESS_DENIED/)
    } finally { other.destroy() }
    await window.loadFile(join(buildDir, 'ui', html))
    await click(window, button('预览 / 重新核对')); await waitFor(window, confirmation); await idle()
    assert.equal(initializes, 0); assert.equal(contentManager.service.snapshot().plugins.length, 0)
    assert.equal(await window.webContents.executeJavaScript(`(${button('确认导入 / 重试')}).disabled`), true)
    await click(window, confirmation); await click(window, trust)
    busy = true
    await click(window, button('确认导入 / 重试')); await idle()
    await waitFor(window, `document.querySelector('[role="alert"]')`)
    assert.equal(contentManager.service.snapshot().plugins.length, 0); assert.equal(initializes, 0)
    busy = false
    await click(window, button('预览 / 重新核对')); await idle()
    await click(window, confirmation); await click(window, trust); await click(window, button('确认导入 / 重试'))
    await waitFor(window, `document.body.textContent.includes('连接尚不可用')`); await idle()
    assert.equal(contentManager.service.snapshot().plugins.length, 1)
    assert.equal(getWorkspaceMcpConfig('fixture-a').servers['fixture-docs']?.enabled, false)
    const revision = contentManager.service.snapshot().revision
    ready = true
    await click(window, confirmation); await click(window, button('确认导入 / 重试')); await idle()
    await waitFor(window, `!document.body.textContent.includes('连接尚不可用')`)
    assert.equal(discoveries, 1); assert.equal(getWorkspaceMcpConfig('fixture-a').servers['fixture-docs']?.enabled, true)
    assert.equal(contentManager.service.snapshot().revision, revision)
    await click(window, confirmation); await click(window, button('确认导入 / 重试')); await idle()
    assert.equal(discoveries, 1)
    await click(window, button('验收：切换项目')); await waitFor(window, `document.body.textContent.includes('验收项目 B') && !document.querySelector('input[type="checkbox"]')`)
    await click(window, button('预览 / 重新核对')); await idle()
    await click(window, confirmation); await click(window, button('确认导入 / 重试')); await idle()
    await waitFor(window, `document.body.textContent.includes('复用既有资源')`)
    assert.equal(discoveries, 2)
    await click(window, button('验收：切换项目')); await click(window, button('预览 / 重新核对')); await idle()
    const config = getWorkspaceMcpConfig('fixture-a'); config.servers['fixture-docs']!.enabled = false; saveWorkspaceMcpConfig('fixture-a', config)
    await click(window, confirmation); await click(window, button('撤销本次未修改的资源')); await idle()
    await waitFor(window, `document.body.textContent.includes('资源仍被其他导入引用') && document.body.textContent.includes('资源已变化')`)
    assert.equal(contentManager.service.snapshot().plugins.length, 1)
    assert.equal(getWorkspaceMcpConfig('fixture-a').servers['fixture-docs']?.enabled, false)
    window.setSize(430, 850)
    for (const dark of [false, true]) {
      await window.webContents.executeJavaScript(`document.documentElement.classList.toggle('dark', ${dark}); document.querySelector('[aria-label="导入阶段回执"]').scrollIntoView({block:'center'})`)
      assert.equal(await window.webContents.executeJavaScript('document.documentElement.scrollWidth <= innerWidth'), true)
      writeFileSync(join(root, dark ? 'static-import-dark.png' : 'static-import-light.png'), (await window.webContents.capturePage()).toPNG())
    }
    await click(window, button('验收：切换项目')); await click(window, button('预览 / 重新核对')); await idle()
    await click(window, confirmation); await click(window, button('撤销本次未修改的资源')); await idle()
    await waitFor(window, `document.querySelector('[aria-label="导入阶段回执"]')?.textContent.includes('MCP连接：已撤销或释放引用')`)
    assert.equal(contentManager.service.snapshot().plugins.length, 1)
    assert.equal(getWorkspaceMcpConfig('fixture-b').servers['fixture-docs'], undefined)
    await click(window, button('验收：切换项目')); await click(window, button('预览 / 重新核对')); await idle()
    await click(window, confirmation); await click(window, button('撤销本次未修改的资源')); await idle()
    await waitFor(window, `document.querySelector('[aria-label="导入阶段回执"]')?.textContent.includes('内容资源：已撤销或释放引用')`)
    assert.equal(contentManager.service.snapshot().plugins.length, 0)
    assert.equal(getWorkspaceMcpConfig('fixture-a').servers['fixture-docs']?.enabled, false)
    assert(changes >= 3); assert.deepEqual(errors, [])
    console.log('[Static import smoke] PASS: 真实manager/guard/IPC/preload/UI、其他窗口拒绝、损坏MCP拒绝且可恢复预览、明确确认、busy拒绝、HTTP握手失败与listTools重试、幂等、跨项目复用/释放、安全撤销保留用户修改、深浅窄窗。仅本机fixture协议；未验证公网TLS、OAuth、生产来源或签名配方。')
  } finally {
    window.destroy(); globalThis.fetch = originalFetch
    server.closeAllConnections(); await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
  }
}
async function orchestrate(): Promise<void> {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'dutydeck-static-import-')))
  const buildDir = mkdtempSync(join(tmpdir(), 'dutydeck-static-import-build-'))
  const html = `.plugin-static-import-smoke-${process.pid}.html`; const htmlPath = join(process.cwd(), 'scripts', html)
  try {
    writeFileSync(htmlPath, '<!doctype html><html lang="zh-CN"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head><body><div id="root"></div><script type="module" src="./plugin-static-import-smoke-renderer.tsx"></script></body></html>')
    const { build } = await import('vite')
    await build({ configFile: join(process.cwd(), 'vite.config.ts'), root: join(process.cwd(), 'scripts'), build: { outDir: join(buildDir, 'ui'), rollupOptions: { input: htmlPath }, emptyOutDir: true } })
    const main = await Bun.build({ entrypoints: [__filename], outdir: join(buildDir, 'main'), target: 'node', format: 'cjs', external: ['electron', 'vite'] })
    const preload = await Bun.build({ entrypoints: [join(process.cwd(), 'src/preload/index.ts')], outdir: join(buildDir, 'preload'), target: 'node', format: 'cjs', external: ['electron'] })
    if (!main.success || !preload.success || !main.outputs[0]) throw new Error(`smoke构建失败: ${[...main.logs, ...preload.logs].join('\n')}`)
    const env: NodeJS.ProcessEnv = { ...process.env, HOME: root, [CHILD]: JSON.stringify({ root, buildDir, html }) }; delete env.ELECTRON_RUN_AS_NODE
    await new Promise<void>((resolve, reject) => {
      const child = spawn(process.env.PROMA_ELECTRON_PATH ?? join(process.cwd(), 'node_modules/.bin/electron'), [main.outputs[0]!.path], { env, stdio: 'inherit' })
      const timer = setTimeout(() => child.kill('SIGKILL'), 90_000)
      child.once('error', error => { clearTimeout(timer); reject(error) })
      child.once('exit', code => { clearTimeout(timer); code === 0 ? resolve() : reject(new Error(`静态导入smoke退出: ${code}`)) })
    })
    console.log(`[Static import smoke] 证据目录：${root}`)
  } finally { rmSync(htmlPath, { force: true }); rmSync(buildDir, { recursive: true, force: true }) }
}
if (process.env[CHILD]) {
  const { root, buildDir, html } = JSON.parse(process.env[CHILD]) as { root: string; buildDir: string; html: string }
  const { app } = require('electron') as typeof import('electron')
  void run(root, buildDir, html).then(() => app.quit()).catch(error => { console.error(error); app.exit(1) })
} else { void orchestrate().catch(error => { console.error(error); process.exitCode = 1 }) }
