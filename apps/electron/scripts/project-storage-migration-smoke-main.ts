import { strict as assert } from 'node:assert'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import { app, BrowserWindow, ipcMain } from 'electron'
import type { WorkspacePathState } from '@dutydeck/shared'
import { createDesignPathResolver } from '../src/main/lib/design/design-paths'
import { createDesignStore } from '../src/main/lib/design/design-store'
import { createProjectKnowledgeStore } from '../src/main/lib/project-knowledge/store'
import { InteractionDesignService } from '../src/main/lib/interaction-design/store'
import { VisualProductionService } from '../src/main/lib/visual-production/store'
import { resolveProjectStorageDirectory } from '../src/main/lib/project-storage/project-storage-paths'
import { inspectProjectStorageMigrationNamespace } from '../src/main/lib/project-storage/project-storage-migration'
import { migrateWorkspaceProjectStorageWithDependencies } from '../src/main/lib/project-storage/workspace-project-storage-migration'
import { registerPathManagementIpcHandlers } from '../src/main/lib/path-management-ipc'
import { createWorkspaceOperationRegistry } from '../src/main/lib/workspace-operation-lock'
import { writeJsonFileAtomicSecure } from '../src/main/lib/safe-file'

/** 只接受 launcher 分配的测试根，禁止将现有项目作为烟测目标。 */
const root = process.env.PROJECT_STORAGE_SMOKE_ROOT ?? ''
assert.ok(basename(root).startsWith('dutydeck-project-storage-smoke-') && existsSync(join(root, 'home')), '缺少隔离 launcher 根')
app.setPath('userData', join(root, 'electron-user-data'))
app.on('window-all-closed', () => undefined)

/** 有界等待真实 Chromium DOM，失败时保留页面正文。 */
async function wait(window: BrowserWindow, expression: string): Promise<void> {
  const deadline = Date.now() + 12000
  while (Date.now() < deadline) {
    if (await window.webContents.executeJavaScript(`Boolean(${expression})`)) return
    await new Promise(accept => setTimeout(accept, 50))
  }
  throw new Error(`等待失败：${expression}\n${await window.webContents.executeJavaScript('document.body.innerText')}`)
}

/** 弹窗优先定位准确按钮文本，避免点击背景中的另一项迁移。 */
function button(label: string): string {
  return `[...(document.querySelector('[role="dialog"]') ?? document).querySelectorAll('button')].find(node=>node.textContent.trim()===${JSON.stringify(label)})`
}

/** 通过 Chromium 真实鼠标事件操作 Radix 按钮，不调用 React 内部回调。 */
async function click(window: BrowserWindow, label: string): Promise<void> {
  const selector = button(label)
  await wait(window, selector)
  await wait(window, `!document.getAnimations().some(a=>Number.isFinite(a.effect?.getComputedTiming().endTime)&&a.playState==='running')`)
  await window.webContents.executeJavaScript(`(${selector}).scrollIntoView({block:'nearest'})`)
  await window.webContents.capturePage()
  const point = await window.webContents.executeJavaScript(`(()=>{const r=(${selector}).getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2}})()`)
  window.webContents.debugger.attach('1.3')
  try {
    await window.webContents.debugger.sendCommand('Input.dispatchMouseEvent', { type: 'mouseMoved', ...point })
    await window.webContents.debugger.sendCommand('Input.dispatchMouseEvent', { type: 'mousePressed', ...point, button: 'left', buttons: 1, clickCount: 1 })
    await window.webContents.debugger.sendCommand('Input.dispatchMouseEvent', { type: 'mouseReleased', ...point, button: 'left', buttons: 0, clickCount: 1 })
  } finally { window.webContents.debugger.detach() }
}

/** 项目树快照包含文件 hash 和目录 inode；取消/阻断必须完全不改项目树。 */
function tree(projectRoot: string): Record<string, string> {
  const result: Record<string, string> = {}
  const walk = (directory: string, prefix: string): void => {
    for (const name of readdirSync(directory).sort()) {
      const path = join(directory, name)
      const key = `${prefix}${name}`
      const state = statSync(path)
      result[key] = state.isDirectory() ? `directory:${state.ino}` : createHash('sha256').update(readFileSync(path)).digest('hex')
      if (state.isDirectory()) walk(path, `${key}/`)
    }
  }
  walk(projectRoot, '')
  return result
}

/** 生产 store 初始化有效四模块数据，再重命名为真实历史布局。 */
async function fixture() {
  const projectRoot = join(root, 'project')
  const memoryRoot = join(root, 'memory')
  mkdirSync(projectRoot); mkdirSync(memoryRoot); mkdirSync(join(root, 'config'))
  const project = { projectId: 'smoke-project', projectRoot, memoryRoot, cacheRoot: join(root, 'cache') }
  const designPaths = createDesignPathResolver({
    getWorkspace: () => ({ id: 'smoke-project', name: '隔离项目', slug: 'smoke', projectRootPath: projectRoot, createdAt: 1, updatedAt: 1 }),
    getProjectFilesPath: () => projectRoot, getConfigDir: () => join(root, 'config'),
  })
  const design = createDesignStore({ pathResolver: designPaths })
  const knowledge = createProjectKnowledgeStore({ resolveProject: () => project })
  const interaction = new InteractionDesignService({ workspaceId: 'smoke-project', projectRoot })
  const visual = new VisualProductionService({ workspaceId: 'smoke-project', projectRoot })
  const canvas = design.initialize('smoke-project')
  const manifest = await knowledge.initialize(project, 'smoke-project')
  const prototype = await interaction.invoke('create', { sessionId: 'smoke-session', name: '迁移原型', platform: 'mobile' })
  const production = await visual.invoke('create', { sessionId: 'smoke-session', title: '迁移影片', kind: 'film' })
  renameSync(join(projectRoot, '.dutydeck'), join(projectRoot, '.proma'))
  mkdirSync(join(projectRoot, '.dutydeck', 'plugin-artifacts'), { recursive: true })
  writeFileSync(join(projectRoot, '.proma', 'user-note'), '用户未知内容，必须保留')
  writeFileSync(join(projectRoot, '.dutydeck', 'plugin-artifacts', 'keep.txt'), '插件内容，必须保留')
  /** 使用真实 resolver/store 重新读取，不只检查文件移动成功。 */
  const verify = async (namespace: '.proma' | '.dutydeck'): Promise<void> => {
    for (const directory of ['design', 'knowledge', 'interaction-design', 'visual-production'] as const) {
      assert.equal(resolveProjectStorageDirectory(projectRoot, directory, false), join(projectRoot, namespace, directory))
    }
    assert.deepEqual(design.load('smoke-project').document, canvas)
    assert.deepEqual(knowledge.readManifest(project), manifest)
    assert.deepEqual((await interaction.invoke('load', { sessionId: 'smoke-session', prototypeId: prototype.document.id })).document, prototype.document)
    assert.deepEqual((await visual.invoke('load', { sessionId: 'smoke-session', productionId: production.document.id })).document, production.document)
  }
  await verify('.proma')
  return { projectRoot, verify }
}

/** 真实设置页面的确认/取消/迁移/忙碌/冲突验收；生命周期只记录不重启任何应用。 */
async function run(): Promise<void> {
  const data = await fixture()
  const conflictRoot = join(root, 'conflict-project')
  mkdirSync(join(conflictRoot, '.proma', 'design'), { recursive: true })
  mkdirSync(join(conflictRoot, '.dutydeck', 'design'), { recursive: true })
  const registry = createWorkspaceOperationRegistry()
  let activeProject = data.projectRoot
  let agentBusy = false
  let backgroundBusy = false
  const events: string[] = []
  const errors: string[] = []
  const screenshots: string[] = []
  await app.whenReady()
  const window = new BrowserWindow({ width: 1100, height: 780, show: true, webPreferences: { preload: join(root, 'project-storage-migration-smoke-preload.js'), backgroundThrottling: false } })
  window.webContents.on('console-message', event => { if (event.level === 'error') errors.push(event.message) })
  const states = (): WorkspacePathState[] => [{ workspaceId: 'smoke-project', name: '隔离项目', sourceRoot: activeProject, kind: 'external', availability: 'available', relocation: null, projectStorageMigration: inspectProjectStorageMigrationNamespace(activeProject) }]
  registerPathManagementIpcHandlers({
    mode: 'normal', ipc: ipcMain, homeDir: join(root, 'home'), getExpectedWebContents: () => window.webContents,
    app: { relaunch: () => { events.push('relaunch') }, quit: () => { events.push('quit') } },
    coordinator: {
      getStatus: () => ({ activeRoot: null, availability: 'available', deviceType: 'unknown', migration: null }),
      createPlan: async () => { throw new Error('本烟测禁止用户数据根迁移') },
      runPending: async () => { throw new Error('本烟测禁止用户数据根迁移') },
      resumePending: async () => { throw new Error('本烟测禁止用户数据根迁移') }, cancel: async () => undefined,
    },
    listWorkspacePathStates: states, hasActiveTasks: () => agentBusy,
    hasActiveProjectStorageTasks: () => backgroundBusy || registry.hasActiveWorkspaceWrites(),
    hasOtherPromaInstance: () => false,
    refreshWorkspaceRenderer: () => { events.push('refresh') },
    migrateProjectStorage: workspaceId => {
      events.push('migrate')
      return migrateWorkspaceProjectStorageWithDependencies(workspaceId, {
        listWorkspaces: () => [{ id: 'smoke-project', projectRoot: activeProject }],
        isActive: () => agentBusy,
        acquireOperation: id => registry.acquireWorkspaceOperation(id, 'project-storage-migration'),
      })
    },
  })
  const capture = async (name: string): Promise<void> => {
    /** 弹窗淡入完成后再截屏，避免把中间透明帧当作最终界面证据。 */
    await wait(window, `!document.getAnimations().some(a=>Number.isFinite(a.effect?.getComputedTiming().endTime)&&a.playState==='running')`)
    const path = join(root, `${name}.png`)
    writeFileSync(path, (await window.webContents.capturePage()).toPNG()); screenshots.push(path)
  }
  try {
    await window.loadURL(process.env.PROJECT_STORAGE_SMOKE_URL!)
    await wait(window, button('迁移项目数据'))
    const before = tree(data.projectRoot)
    await click(window, '迁移项目数据')
    await wait(window, "document.querySelector('[role=dialog]')")
    assert.deepEqual(tree(data.projectRoot), before)
    assert.equal(events.length, 0)
    await capture('01-confirmation')
    await click(window, '取消')
    await wait(window, "!document.querySelector('[role=dialog]')")
    assert.deepEqual(tree(data.projectRoot), before)
    assert.equal(events.length, 0)
    for (const mode of ['agent', 'background', 'cross-project-write'] as const) {
      agentBusy = mode === 'agent'; backgroundBusy = mode === 'background'
      /** 全应用重启会打断其它项目，必须覆盖不同工作区持有的真实写租约。 */
      const releaseWrite = mode === 'cross-project-write' ? registry.acquireWorkspaceWriteLease('another-workspace') : undefined
      try {
        if (releaseWrite) assert.equal(registry.hasActiveWorkspaceWrites(), true)
        await click(window, '迁移项目数据'); await click(window, '迁移并重启')
        await wait(window, "document.querySelector('[role=alert]')?.textContent.includes('正在运行')")
        assert.deepEqual(tree(data.projectRoot), before)
        assert.ok(!events.includes('migrate') && !events.includes('relaunch') && !events.includes('quit'))
        await capture(`02-blocked-${mode}`)
        await click(window, '取消')
        await wait(window, "!document.querySelector('[role=dialog]')")
      } finally { releaseWrite?.() }
      assert.equal(registry.hasActiveWorkspaceWrites(), false)
    }
    agentBusy = false; backgroundBusy = false
    events.length = 0
    await click(window, '迁移项目数据'); await click(window, '迁移并重启')
    await wait(window, `${button('已使用新目录')}?.disabled`)
    await data.verify('.dutydeck')
    assert.deepEqual(events, ['migrate', 'relaunch', 'quit', 'refresh'])
    assert.ok(await window.webContents.executeJavaScript("Number(document.querySelector('output').dataset.refreshes)>=5"))
    assert.equal(readFileSync(join(data.projectRoot, '.proma', 'user-note'), 'utf8'), '用户未知内容，必须保留')
    assert.equal(readFileSync(join(data.projectRoot, '.dutydeck', 'plugin-artifacts', 'keep.txt'), 'utf8'), '插件内容，必须保留')
    assert.deepEqual(readdirSync(join(data.projectRoot, '.proma')), ['user-note'])
    await capture('03-completed')
    activeProject = conflictRoot
    await window.loadURL(process.env.PROJECT_STORAGE_SMOKE_URL!)
    await wait(window, "document.body.textContent.includes('目录冲突：design')")
    assert.ok(await window.webContents.executeJavaScript(`${button('迁移项目数据')}?.disabled`))
    const conflictBefore = tree(conflictRoot)
    const conflictError = await window.webContents.executeJavaScript("window.electronAPI.migrateProjectStorage('smoke-project').then(()=>null,error=>error.message)")
    assert.match(conflictError, /冲突/)
    assert.deepEqual(tree(conflictRoot), conflictBefore)
    assert.equal(events.filter(event => event === 'migrate').length, 1)
    await capture('04-conflict')
    assert.deepEqual(errors, [])
    writeJsonFileAtomicSecure(join(root, 'evidence.json'), { passed: true, projectRoot: data.projectRoot, conflictRoot, screenshots, events, checks: ['real-four-store-legacy-read', 'confirmation-no-write', 'cancel-no-write', 'agent-zero-move', 'background-zero-move', 'cross-project-write-zero-move-no-restart', 'write-lease-released-before-migration', 'four-modules-migrated', 'real-four-store-current-read', 'unknown-and-plugin-preserved', 'relaunch-quit-recorded', 'state-refreshed', 'current-disabled', 'conflict-zero-move'], rendererErrors: errors })
  } catch (error) {
    await capture('failure')
    writeJsonFileAtomicSecure(join(root, 'failure.json'), { error: String(error), body: await window.webContents.executeJavaScript('document.body.innerText'), events, errors })
    throw error
  } finally { window.destroy() }
}

void run().then(() => app.quit()).catch(error => { console.error(error); app.exit(1) })
