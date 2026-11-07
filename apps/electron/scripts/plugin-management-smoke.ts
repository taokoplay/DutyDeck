import { strict as assert } from 'node:assert'
import { createHash } from 'node:crypto'
import { gzipSync } from 'node:zlib'
import { spawn } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { BrowserWindow } from 'electron'
import { AGENT_IPC_CHANNELS, MODULE_RUNTIME_PLUGIN_IPC_CHANNELS, PLUGIN_MARKET_IPC_CHANNELS, normalizeAgentSessionModulePolicy } from '@dutydeck/shared'
import { createPluginPackage, inspectPluginPackage } from '@dutydeck/plugin-kit'
import type { PluginV3Manifest } from '@dutydeck/plugin-sdk'
import { AgentPluginRegistry } from '../src/main/lib/agent-modules/plugin-registry'
import { ModuleRuntimeManager } from '../src/main/lib/agent-plugins/module-runtime-manager'
import { ModuleRuntimePluginService } from '../src/main/lib/agent-plugins/module-runtime-plugin-service'
import { PluginCatalogService } from '../src/main/lib/agent-plugins/catalog/catalog-service'
import { registerStaticPluginImportIpc } from '../src/main/lib/agent-plugins/import/plugin-static-import-ipc'

const CHILD = 'DUTYDECK_PLUGIN_MANAGEMENT_SMOKE'
const ID = 'acme.runtime-fixture'

/** 有界等待真实页面状态，失败附正文便于定位，不访问用户页面。 */
async function waitFor(window: BrowserWindow, expression: string): Promise<void> {
  const deadline = Date.now() + 10_000
  while (Date.now() < deadline) {
    if (await window.webContents.executeJavaScript(`Boolean(${expression})`)) return
    await new Promise(resolve => setTimeout(resolve, 30))
  }
  throw new Error(`等待失败：${expression}\n${await window.webContents.executeJavaScript('document.body.innerText')}`)
}

/** Electron 原生鼠标事件进入 React 的真实事件链。 */
async function click(window: BrowserWindow, expression: string): Promise<void> {
  await waitFor(window, `${expression} && !(${expression}).disabled`)
  const point: { x: number; y: number } = await window.webContents.executeJavaScript(`(async()=>{
    const node=${expression}; node.scrollIntoView({block:'center'});
    await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));
    const box=node.getBoundingClientRect();return {x:Math.round(box.x+box.width/2),y:Math.round(box.y+box.height/2)};
  })()`)
  window.webContents.sendInputEvent({ type: 'mouseDown', ...point, button: 'left', clickCount: 1 })
  window.webContents.sendInputEvent({ type: 'mouseUp', ...point, button: 'left', clickCount: 1 })
}
const button = (text: string): string => `[...document.querySelectorAll('button')].find(n=>n.textContent.trim()===${JSON.stringify(text)})`
const confirm = button('确认所选授权（不自动启用）')
const setting = `document.querySelector('[aria-label="插件普通设置"] input[type="text"]')`

/** 真正的 service/IPC/preload/页面；只注入临时数据和可控 busy。 */
async function run(root: string, buildDir: string, html: string): Promise<void> {
  const { app, BrowserWindow, ipcMain } = require('electron') as typeof import('electron')
  app.setPath('userData', join(root, 'electron'))
  app.on('window-all-closed', () => undefined)
  await app.whenReady()
  let busy = false
  let starts = 0
  const manager = new ModuleRuntimeManager({
    moduleRegistry: new AgentPluginRegistry(),
    createSupervisor: () => ({ start: async () => { starts++; throw new Error('管理页不应启动runtime') }, invokeTool: async () => ({}), stop: async () => undefined }),
  })
  const service = new ModuleRuntimePluginService({ root: join(root, 'plugins'), manager, development: true, isBusy: () => busy })
  await service.initialize()
  await service.install(service.previewBytes(readFileSync(join(root, 'fixture.ddplugin'))).token)
  let catalogCalls = 0
  let catalogFailure = false
  let packageCalls = 0
  let packageFailure = false
  // 自有USTAR fixture；不加载npm包、第三方脚本或真实registry。
  const packageJson = Buffer.from(JSON.stringify({ name: 'demo-2', version: '1.0.0', license: 'MIT', dependencies: { cordis: '^4.0.0' } }))
  const header = Buffer.alloc(512)
  header.write('package/package.json'); header.write('0000644\0', 100)
  header.write(packageJson.length.toString(8).padStart(11, '0') + '\0', 124)
  header.fill(32, 148, 156); header.write('0', 156); header.write('ustar\0', 257); header.write('00', 263)
  header.write(header.reduce((total, value) => total + value, 0).toString(8).padStart(6, '0') + '\0 ', 148)
  const tarball = gzipSync(Buffer.concat([header, packageJson, Buffer.alloc((512 - packageJson.length % 512) % 512), Buffer.alloc(1024)]))
  const packageHash = createHash('sha256').update(tarball).digest('hex')
  const catalog = new PluginCatalogService({ root: join(root, 'catalog'), download: async () => {
    catalogCalls++
    if (catalogFailure) throw new Error('smoke模拟断网')
    return Buffer.from(JSON.stringify({ format: 1, plugins: Array.from({ length: 31 }, (_, i) => ({
      name: `demo-${i}`, title: `验收条目${i}`, description: '<script>window.__marketExecuted=true</script>',
      versions: [{ version: '1.0.0', source: { type: 'npm' } }],
    })) }))
  }, downloadPackage: async (_url, kind) => {
    packageCalls++
    if (packageFailure) throw new Error('smoke包下载断网')
    return kind === 'tarball' ? tarball : Buffer.from(JSON.stringify({ name: 'demo-2', version: '1.0.0', dist: {
      tarball: 'https://registry.npmjs.org/demo-2/-/demo-2-1.0.0.tgz', integrity: `sha512-${createHash('sha512').update(tarball).digest('base64')}`,
    } }))
  } })
  const { registerPluginMarketIpc } = await import('../src/main/lib/agent-plugins/plugin-market-ipc')
  // 仅延迟真实list handler返回，用于重挂载竞态；仍使用生产handler/service/preload。
  let delayList = false
  let listEntered: (() => void) | undefined
  let releaseList: (() => void) | undefined
  const handle = ipcMain.handle.bind(ipcMain)
  ipcMain.handle = (channel, listener) => handle(channel, async (event, ...args: unknown[]) => {
    const result: unknown = await listener(event, ...args)
    if (channel === PLUGIN_MARKET_IPC_CHANNELS.LIST && delayList) {
      listEntered?.()
      await new Promise<void>(resolve => { releaseList = resolve })
    }
    return result
  })
  try { registerPluginMarketIpc(catalog) } finally { ipcMain.handle = handle }
  // 空工作区 fixture 保证 list 接线不接触实际用户工作区；授权仍经过生产 IPC 校验。
  ipcMain.handle(AGENT_IPC_CHANNELS.LIST_WORKSPACES, () => [])
  const { registerModuleRuntimePluginIpc } = await import('../src/main/lib/agent-plugins/module-runtime-plugin-ipc')
  registerModuleRuntimePluginIpc({ service, manager, requireVisibleSession: () => { throw new Error('管理验收无会话') }, getSessionPolicy: () => normalizeAgentSessionModulePolicy(undefined) })
  const window = new BrowserWindow({ show: true, width: 1000, height: 900, webPreferences: { preload: join(buildDir, 'preload/index.js'), contextIsolation: true, sandbox: true, nodeIntegration: false } })
  // 市场页同时挂载静态导入卡片；这里仅验收生产空清单，不引入真实工作区/配方。
  const unavailable = (): never => { throw new Error('本管理验收未登记导入配方') }
  registerStaticPluginImportIpc({ ipc: ipcMain, service: { list: () => [], preview: unavailable, apply: unavailable, undo: unavailable },
    isAuthorizedSender: event => event.sender === window.webContents && event.senderFrame === window.webContents.mainFrame,
    resolveWorkspace: unavailable })
  const pageErrors: string[] = []
  window.webContents.on('console-message', (_event, level, message) => { if (level >= 3) pageErrors.push(message) })
  try {
    await window.loadFile(join(buildDir, 'ui', html))
    await waitFor(window, `document.body.textContent.includes('兼容证据：待验证') && document.body.textContent.includes('授权与启停：待授权')`)
    assert.equal(await window.webContents.executeJavaScript(`document.body.textContent.includes('utilityProcess 不是 OS 沙箱')`), true)
    await click(window, button('核对授权'))
    await waitFor(window, `${confirm} && !(${confirm}).disabled`)
    await click(window, `document.querySelector('[aria-label="插件执行授权"] input[type="checkbox"]')`)
    busy = true
    await click(window, confirm)
    await waitFor(window, `document.querySelector('[role="alert"]')?.textContent.includes('正在运行')`)
    assert.equal(await window.webContents.executeJavaScript(`Boolean(${confirm})`), true, '失败不能关闭授权编辑器')
    assert.equal(await window.webContents.executeJavaScript(`document.querySelector('[aria-label="插件执行授权"] input').checked`), true, '失败不能丢失所选能力')
    assert.equal(service.snapshot().plugins[0]?.grant, null)
    busy = false
    await click(window, confirm)
    await waitFor(window, `!(${confirm}) && document.body.textContent.includes('已确认当前包')`)
    assert.equal(service.snapshot().plugins[0]?.enabled, false, '授权不自动启用')
    assert.deepEqual(service.snapshot().plugins[0]?.grant?.capabilities, ['plugin.state.read'])
    await waitFor(window, `!(${setting}).disabled`)
    await window.webContents.executeJavaScript(`(${setting}).focus();(${setting}).select()`)
    window.webContents.insertText('修改后的设置')
    await waitFor(window, `(${setting}).value==='修改后的设置'`)
    busy = true
    await click(window, button('保存普通设置'))
    await waitFor(window, `document.querySelector('[role="alert"]')?.textContent.includes('正在运行')`)
    assert.equal(await window.webContents.executeJavaScript(`(${setting}).value`), '修改后的设置')
    assert.equal(service.snapshot().plugins[0]?.settings?.values.label, '初始设置')
    busy = false
    await click(window, button('保存普通设置'))
    await waitFor(window, `document.querySelector('[aria-label="插件普通设置"]').textContent.includes('revision 1') && !document.querySelector('[role="alert"]')`)
    assert.equal(service.snapshot().plugins[0]?.settings?.values.label, '修改后的设置')
    await window.webContents.executeJavaScript(`(${setting}).focus();(${setting}).select()`)
    window.webContents.insertText('并发草稿')
    await waitFor(window, `(${setting}).value==='并发草稿'`)
    await service.configureSettings(ID, { label: '另一入口的新值' }, service.snapshot().revision, 1)
    await click(window, button('保存普通设置'))
    await waitFor(window, `document.querySelector('[role="alert"]') && document.querySelector('[aria-label="插件普通设置"]').textContent.includes('revision 2')`)
    assert.equal(await window.webContents.executeJavaScript(`(${setting}).value`), '并发草稿', 'CAS失败刷新不能丢弃草稿')
    assert.equal(await window.webContents.executeJavaScript(`(${button('保存普通设置')}).disabled`), true, '不能静默按新revision覆盖')
    await click(window, button('保留草稿，确认使用最新 revision'))
    await click(window, button('保存普通设置'))
    await waitFor(window, `document.querySelector('[aria-label="插件普通设置"]').textContent.includes('revision 3') && !document.querySelector('[role="alert"]')`)
    assert.equal(service.snapshot().plugins[0]?.settings?.values.label, '并发草稿')
    await click(window, button('启用插件'))
    await waitFor(window, `Boolean(${button('停用插件')})`)
    assert.equal(await window.webContents.executeJavaScript(`(${setting}).disabled`), true)
    assert.equal(starts, 0, '启用管理动作不得加载Node入口')
    assert.equal(await window.webContents.executeJavaScript(`document.body.textContent.includes('运行健康：未启动（按需加载）')`), true)
    busy = true
    await click(window, button('撤销授权并停止调用'))
    await waitFor(window, `document.body.textContent.includes('已撤销') && Boolean(${button('启用插件')})`)
    assert.equal(service.snapshot().plugins[0]?.grant?.revoked, true)
    assert.equal(service.snapshot().plugins[0]?.enabled, false)
    busy = false
    // 跨页面重载仍保持撤销和停用，设置持久化不丢失。
    await window.loadFile(join(buildDir, 'ui', html))
    await waitFor(window, `document.body.textContent.includes('已撤销')`)
    assert.equal(await window.webContents.executeJavaScript(`(${setting}).value`), '并发草稿')
    window.setSize(430, 850)
    await window.webContents.executeJavaScript(`document.documentElement.classList.add('dark')`)
    await click(window, button('核对授权'))
    await waitFor(window, `Boolean(${confirm}) && !(${confirm}).disabled`)
    await click(window, button('取消'))
    await waitFor(window, `!(${confirm})`)
    writeFileSync(join(root, 'management-dark.png'), (await window.webContents.capturePage()).toPNG())
    assert.equal(catalogCalls, 0, '打开和重载页面均不联网')
    await click(window, button('加载社区目录（联网）'))
    await waitFor(window, `document.body.textContent.includes('匹配 31 项')`)
    assert.equal(catalogCalls, 1)
    assert.equal(await window.webContents.executeJavaScript('window.__marketExecuted'), undefined, '目录HTML不得执行')
    const marketInput = `document.querySelector('[aria-label="搜索社区插件"]')`
    await window.webContents.executeJavaScript(`(${marketInput}).focus()`)
    window.webContents.insertText('demo-2')
    await click(window, button('下一页'))
    await waitFor(window, `document.body.textContent.includes('当前 31–31') && document.body.textContent.includes('匹配 31 项')`)
    await click(window, button('搜索缓存'))
    await waitFor(window, `document.body.textContent.includes('匹配 11 项')`)
    await click(window, button('验收：离开市场'))
    await click(window, button('验收：返回市场'))
    await waitFor(window, `document.body.textContent.includes('匹配 11 项') && (${marketInput}).value === 'demo-2'`)
    assert.equal(catalogCalls, 1, '分页搜索仅访问缓存')
    await click(window, `[...document.querySelectorAll('[aria-label="社区插件目录"] button')].find(n=>n.textContent.includes('demo-2') && n.textContent.includes('查看诊断'))`)
    await waitFor(window, `document.querySelector('[role="dialog"]')?.textContent.includes('未知，尚未读取包字节')`)
    assert.equal(packageCalls, 0, '打开详情不能自动下载包')
    await click(window, button('静态分析 1.0.0（联网）'))
    await waitFor(window, `document.querySelector('[role="dialog"]')?.textContent.includes('${packageHash}') && !(${button('静态分析 1.0.0（联网）')}).disabled`)
    assert.equal(packageCalls, 2)
    assert.equal(await window.webContents.executeJavaScript(`document.querySelector('[role="dialog"]').textContent.includes('未解析 / 未锁定，阻断执行与转换')`), true)
    assert.equal(starts, 0, '静态包分析不能启动runtime')
    packageFailure = true
    await click(window, button('静态分析 1.0.0（联网）'))
    await waitFor(window, `document.querySelector('[role="dialog"] [role="alert"]')?.textContent.includes('包静态分析失败')`)
    assert.equal(await window.webContents.executeJavaScript(`document.querySelector('[role="dialog"]').textContent.includes('${packageHash}')`), true, '失败保留上次报告')
    packageFailure = false
    await click(window, button('静态分析 1.0.0（联网）'))
    await waitFor(window, `!document.querySelector('[role="dialog"] [role="alert"]') && !(${button('静态分析 1.0.0（联网）')}).disabled`)
    assert.equal(await window.webContents.executeJavaScript('document.documentElement.scrollWidth<=innerWidth'), true)
    writeFileSync(join(root, 'package-analysis-dark.png'), (await window.webContents.capturePage()).toPNG())
    window.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Escape' })
    window.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Escape' })
    await waitFor(window, `!document.querySelector('[role="dialog"]')`)
    catalogFailure = true
    await click(window, button('联网刷新目录'))
    await waitFor(window, `document.querySelector('[aria-label="社区插件目录"] [role="alert"]')?.textContent.includes('保留上次成功缓存')`)
    await waitFor(window, `document.body.textContent.includes('匹配 31 项')`)
    catalogFailure = false
    await click(window, button('联网刷新目录'))
    await waitFor(window, `!document.querySelector('[role="alert"]') && !(${button('联网刷新目录')})?.disabled && document.body.textContent.includes('缓存可用') && document.body.textContent.includes('匹配 31 项')`)
    assert.equal(catalogCalls, 3)
    delayList = true
    const reached = new Promise<void>(resolve => { listEntered = resolve })
    await click(window, button('下一页'))
    await reached
    await click(window, button('验收：离开市场'))
    await click(window, button('验收：返回市场'))
    delayList = false
    releaseList?.()
    await waitFor(window, `document.body.textContent.includes('当前 31–31') && !(${button('上一页')}).disabled`)
    await click(window, button('上一页'))
    await waitFor(window, `document.body.textContent.includes('当前 1–30')`)
    await window.webContents.executeJavaScript(`(async()=>{ document.querySelector('[aria-label="社区插件目录"]').scrollIntoView({block:'start',behavior:'instant'}); await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))); })()`)
    assert.equal(await window.webContents.executeJavaScript('document.documentElement.scrollWidth<=innerWidth'), true)
    writeFileSync(join(root, 'market-dark.png'), (await window.webContents.capturePage()).toPNG())
    // M4：实际生产历史组件展示声明差异；不调用插件、不触碰真实项目数据。
    const fixture = inspectPluginPackage(readFileSync(join(root, 'fixture.ddplugin')))
    if (fixture.manifest.formatVersion !== 3) throw new Error('V3 fixture required')
    const schemaPackage = (version: string, schemaVersion: number): Uint8Array => {
      const manifest = JSON.parse(new TextDecoder().decode(fixture.files.get('plugin.json'))) as PluginV3Manifest
      manifest.version = version
      manifest.artifacts = [{ id: 'report', title: '报告', ownerModuleId: 'echo', schemaVersion, mimeTypes: ['application/json'], retention: 'project' }]
      manifest.modules[0]!.artifacts = ['report']
      const files = new Map(fixture.files)
      files.set('plugin.json', Buffer.from(JSON.stringify(manifest)))
      files.set('CHANGELOG.md', Buffer.from(`# 更新记录\n\n## ${version}\n\n隔离管理验收。\n`))
      return createPluginPackage(files)
    }
    await service.install(service.previewBytes(schemaPackage('2.0.0', 1)).token)
    await service.install(service.previewBytes(schemaPackage('3.0.0', 2)).token)
    await window.loadFile(join(buildDir, 'ui', html))
    await click(window, button('版本历史'))
    await waitFor(window, `document.querySelector('[role="dialog"]')?.textContent.includes('report：2 → 1')`)
    assert.equal(await window.webContents.executeJavaScript(`Boolean(${button('已阻止降级')}?.disabled)`), true)
    assert.equal(await window.webContents.executeJavaScript(`document.querySelector('[role="dialog"]').textContent.includes('包回滚不等于数据回滚')`), true)
    assert.equal(starts, 0)
    await window.webContents.executeJavaScript(`document.documentElement.classList.add('dark')`)
    await waitFor(window, `(() => { const node=document.querySelector('[role="dialog"]'); return node && getComputedStyle(node).opacity==='1' && !node.getAnimations().some(animation=>animation.playState==='running'); })()`)
    const darkStyle = await window.webContents.executeJavaScript(`(() => { const style=getComputedStyle(document.querySelector('[role="dialog"]')); return {background:style.backgroundColor,color:style.color,opacity:style.opacity}; })()`)
    assert.deepEqual(darkStyle, { background: 'rgb(41, 41, 41)', color: 'rgb(250, 250, 250)', opacity: '1' }, '稳定后的深色弹窗必须不透明并继承主题')
    await window.webContents.executeJavaScript('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))')
    assert.equal(await window.webContents.executeJavaScript('document.documentElement.scrollWidth<=innerWidth'), true)
    writeFileSync(join(root, 'version-history-dark.png'), (await window.webContents.capturePage()).toPNG())
    window.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Escape' })
    window.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Escape' })
    await waitFor(window, `!document.querySelector('[role="dialog"]')`)
    assert.equal(await window.webContents.executeJavaScript(`document.activeElement?.textContent==='版本历史'`), true, '关闭对话框恢复触发器焦点')
    await window.webContents.executeJavaScript(`document.documentElement.classList.remove('dark')`)
    window.setSize(1000, 900)
    await click(window, button('版本历史'))
    await waitFor(window, `Boolean(${button('已阻止降级')})`)
    await waitFor(window, `(() => { const node=document.querySelector('[role="dialog"]'); return node && getComputedStyle(node).opacity==='1' && !node.getAnimations().some(animation=>animation.playState==='running'); })()`)
    const lightStyle = await window.webContents.executeJavaScript(`(() => { const style=getComputedStyle(document.querySelector('[role="dialog"]')); return {background:style.backgroundColor,color:style.color,opacity:style.opacity}; })()`)
    assert.deepEqual(lightStyle, { background: 'rgb(255, 255, 255)', color: 'rgb(10, 10, 10)', opacity: '1' }, '稳定后的浅色弹窗必须不透明并继承主题')
    await window.webContents.executeJavaScript('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))')
    writeFileSync(join(root, 'version-history-light.png'), (await window.webContents.capturePage()).toPNG())
    // 打开历史后另一窗口更新：即使 changed 已刷新卡片，旧差异也必须携带旧 revision 被拒绝。
    await service.install(service.previewBytes(schemaPackage('3.1.0', 2)).token)
    await window.loadFile(join(buildDir, 'ui', html))
    await click(window, button('版本历史'))
    await waitFor(window, `Boolean(${button('回滚到此版本')})`)
    const later = await service.install(service.previewBytes(schemaPackage('4.0.0', 2)).token)
    window.webContents.send(MODULE_RUNTIME_PLUGIN_IPC_CHANNELS.CHANGED)
    await waitFor(window, `document.querySelector('h3')?.textContent.includes('v4.0.0')`)
    await click(window, button('回滚到此版本'))
    await waitFor(window, `document.body.textContent.includes('PLUGIN_REGISTRY_REVISION_CONFLICT')`)
    assert.equal(service.snapshot().revision, later.revision, '旧历史提交不能修改当前目录')
    assert.equal(service.snapshot().plugins[0]?.manifest.version, '4.0.0')
    assert.equal(starts, 0)
    assert.deepEqual(pageErrors, [])
    console.log('[M4 management smoke] PASS: 待验证/授权/空闲健康分离、声明差异、schema降级禁用、深浅主题、Escape与焦点恢复；全过程不启动runtime。')
    console.log('[Plugin market UI smoke] PASS: 首次/重载不联网、明确加载、未提交草稿不影响分页、搜索重挂载保持、延迟翻页跨Tab一致、搜索分页只读缓存、HTML不执行、详情不自动下载包、显式静态分析/真实哈希/依赖阻断、包分析失败保留报告及重试、不启动runtime、Escape关闭、失败缓存保留和重试、窄窗深色无横向溢出。')
    console.log('[Plugin management UI smoke] PASS: 真实service/IPC/preload；授权失败保留编辑与选择、原错误可见、重试成功不自动启用；设置失败保留草稿、成功持久化；启用禁编辑不启动runtime；忙时撤权停用、重载不复活；窄窗深色取消。')
  } finally { window.destroy(); await service.dispose() }
}

async function orchestrate(): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), 'dutydeck-plugin-management-'))
  const buildDir = mkdtempSync(join(tmpdir(), 'dutydeck-plugin-management-build-'))
  const html = `.plugin-management-smoke-${process.pid}.html`
  const htmlPath = join(process.cwd(), 'scripts', html)
  try {
    const manifest = JSON.parse(readFileSync(join(process.cwd(), '../../examples/plugins/runtime-fixture/plugin.json'), 'utf8'))
    manifest.id = ID
    manifest.capabilities = ['plugin.state.read', 'plugin.state.write']
    manifest.settings = [{ key: 'label', label: '展示文字', type: 'text', defaultValue: '初始设置', maxLength: 200, apply: 'restart-runtime' }]
    writeFileSync(join(root, 'fixture.ddplugin'), createPluginPackage(new Map([
      ...['README.md', 'LICENSE', 'CHANGELOG.md', 'THIRD_PARTY_NOTICES.md'].map(name => [name, readFileSync(join(process.cwd(), '../../examples/plugins/runtime-fixture', name))] as [string, Buffer]),
      ['plugin.json', Buffer.from(JSON.stringify(manifest))],
      ['runtime/main.mjs', Buffer.from('export default { activate() { throw new Error("管理页不应执行入口") } }')],
      ['prompts/workflow.md', Buffer.from('只用于管理验收。')],
      ['surfaces/workspace/index.html', Buffer.from('<!doctype html><title>管理fixture</title>')],
    ])))
    writeFileSync(htmlPath, '<!doctype html><html lang="zh-CN"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head><body><div id="root"></div><script type="module" src="./plugin-management-smoke-renderer.tsx"></script></body></html>')
    const { build } = await import('vite')
    await build({ configFile: join(process.cwd(), 'vite.config.ts'), root: join(process.cwd(), 'scripts'), build: { outDir: join(buildDir, 'ui'), rollupOptions: { input: htmlPath }, emptyOutDir: true } })
    const main = await Bun.build({ entrypoints: [__filename], outdir: join(buildDir, 'main'), target: 'node', format: 'cjs', external: ['electron', 'vite'] })
    const preload = await Bun.build({ entrypoints: [join(process.cwd(), 'src/preload/index.ts')], outdir: join(buildDir, 'preload'), target: 'node', format: 'cjs', external: ['electron'] })
    if (!main.success || !preload.success || !main.outputs[0]) throw new Error(`smoke构建失败: ${[...main.logs, ...preload.logs].join('\n')}`)
    const env: NodeJS.ProcessEnv = { ...process.env, [CHILD]: JSON.stringify({ root, buildDir, html }) }
    delete env.ELECTRON_RUN_AS_NODE
    await new Promise<void>((resolve, reject) => {
      const child = spawn(process.env.PROMA_ELECTRON_PATH ?? join(process.cwd(), 'node_modules/.bin/electron'), [main.outputs[0]!.path], { env, stdio: 'inherit' })
      const timer = setTimeout(() => child.kill('SIGKILL'), 90_000)
      child.once('error', error => { clearTimeout(timer); reject(error) })
      child.once('exit', code => { clearTimeout(timer); code === 0 ? resolve() : reject(new Error(`管理smoke退出: ${code}`)) })
    })
    console.log(`[Plugin management UI smoke] 证据目录：${root}`)
  } finally { rmSync(htmlPath, { force: true }); rmSync(buildDir, { recursive: true, force: true }) }
}

if (process.env[CHILD]) {
  const { root, buildDir, html } = JSON.parse(process.env[CHILD]) as { root: string; buildDir: string; html: string }
  const { app } = require('electron') as typeof import('electron')
  void run(root, buildDir, html).then(() => app.quit()).catch(error => { console.error(error); app.exit(1) })
} else { void orchestrate().catch(error => { console.error(error); process.exitCode = 1 }) }
