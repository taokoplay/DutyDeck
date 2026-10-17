import { strict as assert } from 'node:assert'
import { spawn } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { BrowserWindow } from 'electron'
import { VISUAL_PRODUCTION_CHANNELS } from '@proma/shared'
import type { VisualProductionInputs, VisualProductionMethod, VisualProductionResults, VisualProductionMediaOption } from '@proma/shared'
import { createVisualProductionAccess } from '../src/main/lib/visual-production/access'
import { registerVisualProductionIpc } from '../src/main/lib/visual-production/ipc'
import { VisualProductionService } from '../src/main/lib/visual-production/store'
import { buildVisualProductionMediaCatalog } from '../src/main/lib/visual-production/media-catalog'

/** 记录各测试窗口的指针位置，悬浮测试沿真实路径移动，避免跨过 Radix 的过渡判断。 */
const pointerPositions = new WeakMap<BrowserWindow, { x: number; y: number }>()

/** 获取临时端口，避免触及正在运行的开发实例。 */
async function port(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer()
    server.on('error', reject)
    server.listen(0, '127.0.0.1', () => { const address = server.address(); if (!address || typeof address === 'string') return reject(new Error('端口分配失败')); server.close(error => error ? reject(error) : resolve(address.port)) })
  })
}
/** 给单次渲染器执行加主进程截止时间，超时报告步骤以定位失去响应的位置。 */
async function bounded<T>(step: string, operation: Promise<T>): Promise<T> {
  /** 操作结束即清理计时器，不延长测试进程生命周期。 */
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([operation, new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new Error(`渲染器步骤超时：${step}`)), 12000) })])
  } catch (cause) {
    throw new Error(`渲染器步骤失败：${step}`, { cause })
  } finally { if (timer) clearTimeout(timer) }
}
/** DOM 等待有界并输出失败证据。 */
async function wait(window: BrowserWindow, expression: string): Promise<void> {
  const deadline = Date.now() + 12000
  while (Date.now() < deadline) {
    if (await bounded(expression, window.webContents.executeJavaScript(`Boolean(${expression})`))) return
    await new Promise(resolve => setTimeout(resolve, 50))
  }
  throw new Error(`等待失败 ${expression}\n${await bounded('读取失败页面', window.webContents.executeJavaScript('document.body.innerText'))}`)
}
/** 真实 Chromium 鼠标事件，覆盖 Radix 焦点与遮罩。 */
async function click(window: BrowserWindow, selector: string): Promise<void> {
  await wait(window, selector)
  /** 从主进程轮询动画状态，避免窗口被遮挡时依赖未调度的 rAF 挂起。 */
  await wait(window, `!document.getAnimations().some(animation=>Number.isFinite(animation.effect?.getComputedTiming().endTime) && animation.playState === 'running')`)
  await bounded(`滚动到点击目标 ${selector}`, window.webContents.executeJavaScript(`(${selector}).scrollIntoView({block:'nearest'})`))
  /** 等待 Chromium 提交可见帧，防止重载后 DOM 已就绪、鼠标仍命中上一帧。 */
  await bounded(`绘制点击目标 ${selector}`, window.webContents.capturePage())
  await wait(window, `(()=>{const node=${selector};if(!node)return false;const b=node.getBoundingClientRect();return b.width>0 && b.height>0 && node.contains(document.elementFromPoint(b.x+b.width/2,b.y+b.height/2))})()`)
  const point = await bounded(`定位点击目标 ${selector}`, window.webContents.executeJavaScript(`(()=>{const node=${selector};node.scrollIntoView({block:'nearest'});const b=node.getBoundingClientRect();return{x:b.x+b.width/2,y:b.y+b.height/2}})()`))
  window.webContents.debugger.attach('1.3')
  try {
    /** 与交互设计烟测一致，显式同步指针位置与按键状态，避免弹出菜单误判释放事件。 */
    await window.webContents.debugger.sendCommand('Input.dispatchMouseEvent', { type: 'mouseMoved', ...point })
    await window.webContents.debugger.sendCommand('Input.dispatchMouseEvent', { type: 'mousePressed', ...point, button: 'left', buttons: 1, clickCount: 1 })
    await window.webContents.debugger.sendCommand('Input.dispatchMouseEvent', { type: 'mouseReleased', ...point, button: 'left', buttons: 0, clickCount: 1 })
    pointerPositions.set(window, point)
  } finally { window.webContents.debugger.detach() }
}
/** 与鼠标共用 CDP 投递真实按键，避免原生窗口焦点把 Escape 交给外层弹窗。 */
async function pressKey(window: BrowserWindow, key: string, keyCode: number): Promise<void> {
  /** CDP 的 code 使用物理键名，空格的 key 值仍保留真实空白字符。 */
  const code = key === ' ' ? 'Space' : key
  window.webContents.debugger.attach('1.3')
  try {
    await window.webContents.debugger.sendCommand('Input.dispatchKeyEvent', { type: 'keyDown', key, code, windowsVirtualKeyCode: keyCode, ...(key === 'Enter' ? { text: '\r' } : {}) })
    await window.webContents.debugger.sendCommand('Input.dispatchKeyEvent', { type: 'keyUp', key, code, windowsVirtualKeyCode: keyCode })
  } finally { window.webContents.debugger.detach() }
}
/** 真实移动指针到资产行，验证悬浮预览不会依赖点击或改变勾选状态。 */
async function hover(window: BrowserWindow, selector: string): Promise<void> {
  await wait(window, selector)
  await wait(window, `!document.getAnimations().some(animation=>Number.isFinite(animation.effect?.getComputedTiming().endTime) && animation.playState === 'running')`)
  await window.webContents.executeJavaScript(`(${selector}).scrollIntoView({block:'nearest'})`)
  await window.webContents.capturePage()
  /** 使用元素中心作为真实指针坐标，兼容窄窗滚动后的布局。 */
  const point = await window.webContents.executeJavaScript(`(()=>{const bounds=(${selector}).getBoundingClientRect();return {x:bounds.x+bounds.width/2,y:bounds.y+bounds.height/2}})()`)
  /** 连续坐标经过上一资产的真实边缘，让 Tooltip 的指针过渡区正确结束。 */
  const start = pointerPositions.get(window) ?? { x: point.x + 12, y: point.y }
  window.webContents.debugger.attach('1.3')
  try {
    for (let step = 1; step <= 12; step++) await window.webContents.debugger.sendCommand('Input.dispatchMouseEvent', { type: 'mouseMoved', x: start.x + (point.x - start.x) * step / 12, y: start.y + (point.y - start.y) * step / 12 })
    pointerPositions.set(window, point)
  }
  finally { window.webContents.debugger.detach() }
}
/** 获取当前弹窗优先的精确按钮，不误点背景相同文案。 */
function button(text: string): string { return `[...(document.querySelector('[role="dialog"]')??document).querySelectorAll('button')].find(n=>n.textContent.trim()===${JSON.stringify(text)})` }
/** 按稳定状态定位制作记录页签，数量更新不影响交互定位。 */
function recordTab(status: string): string { return `document.querySelector('.vp-records-tabs [data-record-status="${status}"]')` }
/** 用原生 value setter 驱动 React 受控输入。 */
async function fill(window: BrowserWindow, label: string, value: string): Promise<void> {
  const selector = `[...document.querySelectorAll('[role="dialog"] label')].find(n=>n.textContent.startsWith(${JSON.stringify(label)}))?.querySelector('input,textarea')`
  await wait(window, selector)
  await window.webContents.executeJavaScript(`(()=>{const node=${selector};const type=node instanceof HTMLTextAreaElement?HTMLTextAreaElement:HTMLInputElement;Object.getOwnPropertyDescriptor(type.prototype,'value').set.call(node,${JSON.stringify(value)});node.dispatchEvent(new Event('input',{bubbles:true}));})()`)
}
/** 真实操作项目 Select 的触发器及弹出选项，不通过隐藏表单 select 绕过交互。 */
async function selectOption(window: BrowserWindow, label: string, option: string): Promise<void> {
  /** 显式无障碍名称同时用于表单字段和工具栏字段。 */
  const trigger = `document.querySelector('[role="combobox"][aria-label="${label}"]')`
  await click(window, trigger)
  await wait(window, `document.querySelector('[role="listbox"]')`)
  await click(window, `[...document.querySelectorAll('[role="option"]')].find(node=>node.textContent.trim()===${JSON.stringify(option)})`)
  await wait(window, `!document.querySelector('[role="listbox"]') && ${trigger}?.textContent.includes(${JSON.stringify(option)})`)
}
/** 从空项目到真实存储/媒体/候选的完整窗口烟测。 */
async function runChild(): Promise<void> {
  const { app, BrowserWindow: Window, ipcMain } = require('electron') as typeof import('electron')
  const root = process.env.VISUAL_SMOKE_DIR!
  app.setPath('userData', join(root, 'user-data'))
  app.on('window-all-closed', () => undefined)
  await app.whenReady()
  const window = new Window({ width: 1000, height: 800, show: true, webPreferences: { preload: join(root, 'visual-production-ui-smoke-preload.js'), backgroundThrottling: false } })
  const errors: string[] = []
  window.webContents.on('console-message', event => { if (event.level === 'error') { errors.push(event.message); console.error('渲染器错误：', event.message) } })
  const projectRoot = join(root, 'project')
  /** 仅提供隔离能力描述，不连接模型或 ComfyUI。 */
  /** 即梦选项使用生产目录构造器，验证真实参考上限与来源身份，不读取全局配置。 */
  const dreaminaOptions = buildVisualProductionMediaCatalog([
    { ref: 'media:image:dreamina:smoke-profile:5.0Pro', name: '即梦图片 5.0Pro', kind: 'image', provider: 'dreamina', profileId: 'smoke-profile', modelId: '5.0Pro', capabilities: ['text-to-image', 'image-to-image'], available: true, adapterId: 'dreamina-image' },
    { ref: 'media:video:dreamina:smoke-profile:video-test', name: '即梦视频', kind: 'video', provider: 'dreamina', profileId: 'smoke-profile', modelId: 'video-test', capabilities: ['text-to-video'], available: false, unavailableReason: '即梦视频执行器尚未接入' },
  ], { connections: [], workflows: [], archivedWorkflowIds: [] }, 'smoke-project')
  const mediaOptions: VisualProductionMediaOption[] = [
    ...dreaminaOptions,
    { id: 'smoke-image', name: '测试图片模型', kind: 'image', source: { type: 'model', modelRef: 'smoke-image' }, parameters: {}, available: true, constraints: { maxImageReferences: 1, parameters: [{ key: 'size', label: '图片尺寸', type: 'string', defaultValue: '1024x1024', options: ['1024x1024', '1536x1024'] }] } },
    ...(['image', 'video', 'audio'] as const).map(kind => ({ id: `smoke-service-${kind}`, name: '测试 ComfyUI 服务', kind, source: { type: 'connection' as const, connectionId: 'smoke-server' }, parameters: {}, available: true, constraints: {} })),
    { id: 'smoke-disabled', name: '已停用声音模型', kind: 'audio', source: { type: 'model', modelRef: 'smoke-disabled' }, parameters: {}, available: false, unavailableReason: '模型已停用', constraints: {} },
  ]
  const service = new VisualProductionService({ projectRoot, workspaceId: 'smoke-project', listMediaOptions: async () => mediaOptions })
  /** 只延迟真实保存响应，复现磁盘已提交但 UI 尚未收到的网络/IPC 时序。 */
  let holdSave = false
  let releaseSave: (() => void) | undefined
  /** 按媒体身份记录读取次数，验证资产列表按需预览，不因打开表单整库加载。 */
  const mediaReads = new Map<string, number>()
  /** 仅对隔离预览模拟一次读取失败和迟到响应，不改变真实媒体文件。 */
  let failPreview = false
  let holdPreview = false
  let releasePreview: (() => void) | undefined
  const access = (assertCaller?: () => void) => createVisualProductionAccess('smoke-session', { resolveSession: () => ({ workspaceId: 'smoke-project', projectRoot }), assertCaller, acquireWriteLease: () => () => undefined, createService: () => ({
    async invoke<M extends VisualProductionMethod>(method: M, input: VisualProductionInputs[M]): Promise<VisualProductionResults[M]> {
      if (method === 'mediaContent') {
        /** 此分支只读取 mediaContent 已校验的参数，其他方法不受测试故障影响。 */
        const mediaId = (input as VisualProductionInputs['mediaContent']).mediaId
        mediaReads.set(mediaId, (mediaReads.get(mediaId) ?? 0) + 1)
        if (failPreview) { failPreview = false; throw new Error('测试图片暂不可用') }
        if (holdPreview) { holdPreview = false; await new Promise<void>(resolve => { releasePreview = resolve }) }
      }
      const result = await service.invoke(method, input)
      if (method === 'save' && holdSave) { holdSave = false; await new Promise<void>(resolve => { releaseSave = resolve }) }
      return result
    },
  }), onChanged: event => window.webContents.send(VISUAL_PRODUCTION_CHANNELS.CHANGED, event) })
  registerVisualProductionIpc({ ipc: ipcMain, isAuthorizedSender: event => event.sender.id === window.webContents.id, createAccess: (_sessionId, assertCaller) => access(assertCaller) })
  /** 可独立运行配置交互验收，绕开不相关的指针悬浮时序。 */
  async function verifyMediaConfiguration(targetId: string, targetRevision: number): Promise<void> {
    const sessionId = 'smoke-session'
    /** 配置独立持久化，切页保留草稿，空范围不能自动恢复全局目录。 */
    await pressKey(window, 'Escape', 27)
    await wait(window, `!document.querySelector('[role="dialog"]')`)
    await click(window, button('制作配置'))
    await wait(window, `document.querySelectorAll('.vp-media-capability').length === 3`)
    assert.ok(await window.webContents.executeJavaScript(`document.querySelector('.vp-media-config-note').textContent.includes('继承全局')`))
    assert.equal(await window.webContents.executeJavaScript(`document.querySelectorAll('.vp-media-capability[data-media-source="connection"]').length`), 1, '同一服务三种路由合并为一张卡片')
    assert.equal(await window.webContents.executeJavaScript(`[...document.querySelectorAll('.vp-media-capability[data-media-source="connection"] button')].some(node=>node.textContent==='参数')`), false, '服务不得暴露虚构通用参数')
    assert.ok(await window.webContents.executeJavaScript(`document.querySelector('.vp-media-capability[data-media-source="connection"]').textContent.includes('工作流由 Agent 按任务选择')`))
    assert.equal(await window.webContents.executeJavaScript(`document.querySelector('.vp-media-capability[data-media-source="connection"]').textContent.includes('undefined')`), false)
    await selectOption(window, '视频默认方案', '测试 ComfyUI 服务')

    await selectOption(window, '图片默认方案', '测试图片模型')
    await click(window, button('资产')); await click(window, button('制作配置'))
    await wait(window, `document.querySelector('[aria-label="图片默认方案"]').textContent.includes('测试图片模型')`)
    await click(window, `[...document.querySelectorAll('.vp-media-capability')].find(node=>node.textContent.includes('测试图片模型')).querySelector('button')`)
    await selectOption(window, '图片尺寸', '1536x1024'); await click(window, button('应用参数'))
    await click(window, button('保存配置'))
    await wait(window, `document.querySelector('.vp-media-configuration').textContent.includes('配置版本 1')`)
    const configured = await service.invoke('load', { sessionId, productionId: targetId })
    assert.equal(configured.mediaConfiguration?.defaults.image, 'smoke-image')
    assert.equal(configured.mediaConfiguration?.defaults.video, 'smoke-service-video')
    assert.equal(configured.mediaConfiguration?.entries.find(entry => entry.id === 'smoke-image')?.parameters.size, '1536x1024')
    assert.equal(configured.document.revision, targetRevision)
    window.setSize(460, 760)
    await wait(window, `innerWidth === 460`)
    assert.equal(await window.webContents.executeJavaScript(`document.querySelector('.vp-body').scrollWidth > document.querySelector('.vp-body').clientWidth`), false)
    await writeFile('/private/tmp/dutydeck-visual-media-configuration-narrow.png', (await window.webContents.capturePage()).toPNG())
    await window.webContents.executeJavaScript(`document.querySelector('.vp-media-capability[data-media-source="connection"]').scrollIntoView({block:'center'})`)
    await writeFile('/private/tmp/dutydeck-visual-comfyui-service-narrow.png', (await window.webContents.capturePage()).toPNG())
    await click(window, `[...document.querySelectorAll('.vp-media-capability button')].find(node=>node.textContent==='移除')`)
    await click(window, `[...document.querySelectorAll('.vp-media-capability button')].find(node=>node.textContent==='移除')`)
    await click(window, `[...document.querySelectorAll('.vp-media-capability button')].find(node=>node.textContent==='移除')`)
    await click(window, button('保存配置'))
    await wait(window, `document.querySelector('.vp-media-configuration').textContent.includes('配置版本 2')`)
    assert.deepEqual((await service.invoke('load', { sessionId, productionId: targetId })).mediaConfiguration?.entries, [])
    await click(window, button('资产')); await click(window, button('制作配置'))
    assert.equal(await window.webContents.executeJavaScript(`document.querySelectorAll('.vp-media-capability').length`), 0)
    await click(window, button('添加媒体能力'))
    await selectOption(window, '能力类型', '声音')
    assert.equal(await window.webContents.executeJavaScript(`[...document.querySelectorAll('.vp-media-catalog article')].find(node=>node.textContent.includes('已停用声音模型')).querySelector('button').disabled`), true)
    await selectOption(window, '能力类型', '视频')
    assert.equal(await window.webContents.executeJavaScript(`document.querySelectorAll('.vp-media-catalog article').length`), 2)
    assert.ok(await window.webContents.executeJavaScript(`document.querySelector('.vp-media-catalog').textContent.includes('测试 ComfyUI 服务')`))
    assert.equal(await window.webContents.executeJavaScript(`document.querySelectorAll('.vp-media-catalog [role="combobox"]').length`), 0, '不让用户选择工作流模板')
    await click(window, `document.querySelector('.vp-media-catalog [data-media-source="connection"] button')`); await click(window, button('完成选择'))
    await click(window, button('保存配置'))
    await wait(window, `document.querySelector('.vp-media-configuration').textContent.includes('配置版本 3')`)
    assert.equal((await service.invoke('load', { sessionId, productionId: targetId })).mediaConfiguration?.entries[0]?.source.type, 'connection')
    /** 从真实目录搜到即梦图片，视频明确不可用；只保存配置，不生成媒体。 */
    await click(window, button('添加媒体能力'))
    await selectOption(window, '能力类型', '全部')
    await window.webContents.executeJavaScript(`(()=>{const node=document.querySelector('[aria-label="搜索媒体能力"]');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(node,'即梦');node.dispatchEvent(new Event('input',{bubbles:true}));})()`)
    await wait(window, `document.querySelectorAll('.vp-media-catalog article').length === 2`)
    const imageOption = `[...document.querySelectorAll('.vp-media-catalog article')].find(node=>node.textContent.includes('即梦图片'))`
    const videoOption = `[...document.querySelectorAll('.vp-media-catalog article')].find(node=>node.textContent.includes('即梦视频'))`
    assert.equal(await window.webContents.executeJavaScript(`${imageOption}.querySelector('button').disabled`), false)
    assert.equal(await window.webContents.executeJavaScript(`${videoOption}.querySelector('button').disabled`), true)
    assert.ok(await window.webContents.executeJavaScript(`${videoOption}.textContent.includes('即梦视频执行器尚未接入')`))
    assert.ok(await window.webContents.executeJavaScript(`${imageOption}.textContent.includes('本机 CLI 登录态') && !${imageOption}.textContent.includes('API 模型')`))
    /** 等待 Chromium 提交筛选后的可见帧，截图不能保留上一帧的未筛选列表。 */
    await window.webContents.executeJavaScript('new Promise(resolve=>setTimeout(resolve,120))')
    await writeFile('/private/tmp/dutydeck-visual-dreamina-catalog.png', (await window.webContents.capturePage()).toPNG())
    await click(window, `${imageOption}.querySelector('button')`)
    await click(window, button('完成选择'))
    await selectOption(window, '图片默认方案', '即梦图片 5.0Pro')
    await click(window, button('保存配置'))
    await wait(window, `document.querySelector('.vp-media-configuration').textContent.includes('配置版本 4')`)
    const dreaminaSaved = (await service.invoke('load', { sessionId, productionId: targetId })).mediaConfiguration!
    assert.equal(dreaminaSaved.defaults.image, dreaminaOptions[0]!.id)
    assert.equal(dreaminaSaved.entries.some(entry => entry.id === dreaminaOptions[1]!.id), false)
    const imageCard = `[...document.querySelectorAll('.vp-media-capability')].find(node=>node.textContent.includes('即梦图片'))`
    assert.ok(await window.webContents.executeJavaScript(`${imageCard}.textContent.includes('最多支持 10 张图片参考')`))
    await window.webContents.executeJavaScript(`${imageCard}.scrollIntoView({block:'center'})`)
    await window.webContents.executeJavaScript('new Promise(resolve=>setTimeout(resolve,120))')
    await writeFile('/private/tmp/dutydeck-visual-dreamina-configuration.png', (await window.webContents.capturePage()).toPNG())

  }
  try {
    await window.loadURL(process.env.VISUAL_SMOKE_URL!)
    await wait(window, button('新建影像项目'))
    await click(window, button('新建影像项目')); await fill(window, '作品名称', '影像首版验收')
    /** 打开的是项目弹出菜单；Escape 只关闭菜单并把焦点交还字段，保留父弹窗。 */
    await click(window, `document.querySelector('[role="combobox"][aria-label="作品类型"]')`)
    await wait(window, `document.querySelectorAll('[role="option"]').length === 4`)
    await wait(window, `!document.getAnimations().some(animation=>Number.isFinite(animation.effect?.getComputedTiming().endTime) && animation.playState === 'running')`)
    await writeFile('/private/tmp/dutydeck-visual-production-select-light.png', (await window.webContents.capturePage()).toPNG())
    await window.webContents.executeJavaScript("document.documentElement.classList.add('dark')")
    await wait(window, `!document.getAnimations().some(animation=>Number.isFinite(animation.effect?.getComputedTiming().endTime) && animation.playState === 'running')`)
    await writeFile('/private/tmp/dutydeck-visual-production-select-dark.png', (await window.webContents.capturePage()).toPNG())
    await window.webContents.executeJavaScript("document.documentElement.classList.remove('dark')")
    await pressKey(window, 'Escape', 27)
    await wait(window, `!document.querySelector('[role="listbox"]') && document.querySelector('[role="dialog"]') && document.activeElement?.getAttribute('aria-label') === '作品类型'`)
    await selectOption(window, '作品类型', '宣传片'); await click(window, button('创建作品'))
    await wait(window, `document.querySelector('.vp-top')?.textContent.includes('影像首版验收')`)
    if (process.env.VISUAL_SMOKE_CONFIGURATION_ONLY === '1') {
      const created = (await service.invoke('list', { sessionId: 'smoke-session' }))[0]!
      await verifyMediaConfiguration(created.id, created.revision)
      assert.deepEqual(errors, [])
      console.log('PASS: media config service grouping, per-kind defaults, Agent workflow selection, no service parameter/template controls, retained tab drafts, parameter save, empty scope, unavailable model, ComfyUI service persistence, Dreamina image selection/default/10 references/CLI source and unavailable video, and 460px layout. No external model calls.')
      return
    }

    await click(window, button('编辑设定')); await fill(window, '作品目标', '用真实媒体验证第一支宣传片')
    await selectOption(window, '画面比例', '4:3'); await selectOption(window, '帧率', '50'); await click(window, button('保存设置'))
    await wait(window, `!document.querySelector('[role="dialog"]') && document.body.textContent.includes('用真实媒体验证')`)
    await click(window, button('资产')); await click(window, button('新增资产')); await fill(window, '资产名称', '品牌主角'); await fill(window, '描述', '保持形象一致')
    await selectOption(window, '资产类型', '产品'); await click(window, button('保存设置'))
    await wait(window, `!document.querySelector('[role="dialog"]') && document.body.textContent.includes('品牌主角')`)
    await click(window, button('分镜')); await selectOption(window, '当前集数', '第 1 集')
    await click(window, button('新增')); await fill(window, '镜头名称', '开场镜头'); await fill(window, '画面描述', '主角出现在画面中央')
    /** 没有图片的资产仍可悬浮查看，不应误选资产或关闭父弹窗。 */
    await hover(window, `[...document.querySelectorAll('[role="dialog"] label')].find(node=>node.textContent.includes('品牌主角'))`)
    await wait(window, `document.querySelector('.vp-asset-preview')?.textContent.includes('尚未设置图片')`)
    assert.equal(await window.webContents.executeJavaScript(`document.querySelector('[role="dialog"] input[type="checkbox"]').checked`), false)
    await pressKey(window, 'Escape', 27)
    await wait(window, `!document.querySelector('.vp-asset-preview') && document.querySelector('[role="dialog"]')`)
    await click(window, `[...document.querySelectorAll('[role="dialog"] label')].find(n=>n.textContent.includes('品牌主角'))?.querySelector('input')`)
    await click(window, button('保存设置')); await wait(window, `!document.querySelector('[role="dialog"]') && document.querySelector('.vp-shot')`)
    const sessionId = 'smoke-session'
    const productionId = (await service.invoke('list', { sessionId }))[0]!.id
    const media = await access().execute('importFile', { sessionId, productionId, relativePath: 'frame.png' })
    /** 已绑定图片、未绑定素材和视频资产共同验证悬浮预览的边界。 */
    const referenceClip = await access().execute('importFile', { sessionId, productionId, relativePath: 'clip.mp4' })
    const referenceSnapshot = await service.invoke('load', { sessionId, productionId })
    const { schemaVersion: _as, id: _ai, revision: assetRevision, createdAt: _ac, updatedAt: _au, ...referenceDraft } = referenceSnapshot.document
    referenceDraft.assets[0]!.mediaId = media.id
    referenceDraft.assets.push({ id: 'empty-reference', name: '尚未绑定图片的场景资产', type: '场景', description: '', locked: false, mediaId: null }, { id: 'video-reference', name: '参考视频', type: '场景', description: '', locked: false, mediaId: referenceClip.id })
    await access().execute('save', { sessionId, productionId, baseRevision: assetRevision, draft: referenceDraft })
    await wait(window, `document.querySelector('.vp-top')?.textContent.includes('v${assetRevision + 1}')`)
    await click(window, button('镜头设置'))
    assert.equal(mediaReads.get(media.id) ?? 0, 0, '打开镜头设置不应读取尚未预览的资产图片')
    /** 图片读取通过真实 IPC；悬浮不能改变已保存的引用集合。 */
    const referenceSelector = `document.querySelector('[data-asset-id="${referenceDraft.assets[0]!.id}"]')`
    await hover(window, referenceSelector)
    await wait(window, `document.querySelector('.vp-asset-preview img')?.naturalWidth > 0`)
    assert.equal(mediaReads.get(media.id), 1)
    assert.equal(await window.webContents.executeJavaScript(`${referenceSelector}.querySelector('input').checked`), true)
    assert.equal((await service.invoke('load', { sessionId, productionId })).document.revision, assetRevision + 1)
    await wait(window, `!document.getAnimations().some(animation=>Number.isFinite(animation.effect?.getComputedTiming().endTime) && animation.playState === 'running')`)
    await writeFile('/private/tmp/dutydeck-visual-asset-preview-light.png', (await window.webContents.capturePage()).toPNG())
    await window.webContents.executeJavaScript("document.documentElement.classList.add('dark')")
    await wait(window, `!document.getAnimations().some(animation=>Number.isFinite(animation.effect?.getComputedTiming().endTime) && animation.playState === 'running')`)
    await writeFile('/private/tmp/dutydeck-visual-asset-preview-dark.png', (await window.webContents.capturePage()).toPNG())
    await window.webContents.executeJavaScript("document.documentElement.classList.remove('dark')")
    await hover(window, `document.querySelector('[data-asset-id="video-reference"]')`)
    await wait(window, `document.querySelector('.vp-asset-preview')?.textContent.includes('视频资产，暂无图片预览')`)
    assert.equal(mediaReads.get(referenceClip.id) ?? 0, 0, '非图片资产不能偷偷加载或播放视频')
    /** 读取失败给出明确状态，移开再悬浮可重新尝试。 */
    failPreview = true
    await hover(window, referenceSelector)
    await wait(window, `document.querySelector('.vp-asset-preview')?.textContent.includes('媒体读取失败')`)
    await hover(window, `document.querySelector('[data-asset-id="empty-reference"]')`)
    await wait(window, `document.querySelector('.vp-asset-preview')?.textContent.includes('尚未设置图片')`)
    holdPreview = true
    await hover(window, referenceSelector)
    await wait(window, `document.querySelector('.vp-asset-preview')?.textContent.includes('加载素材')`)
    for (let count = 0; count < 100 && !releasePreview; count++) await new Promise(resolve => setTimeout(resolve, 20))
    assert.ok(releasePreview, '预览读取应到达隔离 IPC')
    await hover(window, `document.querySelector('[data-asset-id="empty-reference"]')`)
    await wait(window, `document.querySelector('.vp-asset-preview')?.textContent.includes('尚未设置图片')`)
    releasePreview!()
    await window.webContents.executeJavaScript('new Promise(resolve=>setTimeout(resolve,100))')
    assert.equal(await window.webContents.executeJavaScript(`Boolean(document.querySelector('.vp-asset-preview img'))`), false, '切换资产后迟到图片不得显示在另一资产上')
    /** 键盘聚焦显示相同预览，空格保留原生勾选行为，Escape 只收起预览。 */
    await hover(window, `document.querySelector('[role="dialog"] h2')`)
    await window.webContents.executeJavaScript(`${referenceSelector}.querySelector('input').focus()`)
    await wait(window, `document.querySelector('.vp-asset-preview img')?.naturalWidth > 0`)
    await pressKey(window, 'Escape', 27)
    await wait(window, `!document.querySelector('.vp-asset-preview') && document.querySelector('[role="dialog"]')`)
    await pressKey(window, ' ', 32)
    await wait(window, `!${referenceSelector}.querySelector('input').checked`)
    await pressKey(window, ' ', 32)
    await wait(window, `${referenceSelector}.querySelector('input').checked`)
    /** 统一折叠入口保持纯展开行为，不提交镜头表单。 */
    await click(window, button('从当前项目导入媒体'))
    await wait(window, `document.querySelector('[aria-label="项目内媒体相对路径"]') && document.querySelector('[role="dialog"]')`)
    await click(window, button('从当前项目导入媒体'))
    await wait(window, `!document.querySelector('[aria-label="项目内媒体相对路径"]')`)
    /** 窄窗浮层按视口避让；关闭后回收图片 URL，再打开不复用失效地址。 */
    window.setSize(460, 760)
    await wait(window, 'innerWidth === 460')
    await hover(window, referenceSelector)
    await wait(window, `document.querySelector('.vp-asset-preview img')?.naturalWidth > 0`)
    await wait(window, `!document.getAnimations().some(animation=>Number.isFinite(animation.effect?.getComputedTiming().endTime) && animation.playState === 'running')`)
    const previewGeometry = await window.webContents.executeJavaScript(`(()=>{const bounds=document.querySelector('.vp-asset-preview').getBoundingClientRect();return {left:bounds.left,right:bounds.right,top:bounds.top,bottom:bounds.bottom,width:innerWidth,height:innerHeight}})()`)
    assert.ok(previewGeometry.left >= 0 && previewGeometry.right <= previewGeometry.width && previewGeometry.top >= 0 && previewGeometry.bottom <= previewGeometry.height, JSON.stringify(previewGeometry))
    await writeFile('/private/tmp/dutydeck-visual-asset-preview-narrow.png', (await window.webContents.capturePage()).toPNG())
    const previewUrl = await window.webContents.executeJavaScript(`document.querySelector('.vp-asset-preview img').src`)
    await click(window, button('关闭'))
    await wait(window, `!document.querySelector('.vp-asset-preview') && !document.querySelector('[role="dialog"]')`)
    assert.ok(await window.webContents.executeJavaScript(`window.__visualSmoke.revokedUrls().includes(${JSON.stringify(previewUrl)})`), '关闭预览应回收 Blob URL')
    /** 可独立验收本次资产预览；默认仍执行后续全部影像回归，不跳过旧断言。 */
    if (process.env.VISUAL_SMOKE_PREVIEW_ONLY === '1') {
    assert.deepEqual(errors, [])
      console.log('PASS: asset preview via real IPC; hover/focus image, lazy reads, missing/video/error states, late-response isolation, keyboard checkbox and Escape, Blob cleanup, theme and 460px placement, collapsible import. media config defaults/parameters/tab drafts/empty scope/disabled options/ComfyUI. No model calls or real user data.')
      return
    }
    window.setSize(1000, 800)
    await wait(window, 'innerWidth === 1000')
    await click(window, button('镜头设置')); await selectOption(window, '采用素材', `${media.name} · ${media.kind}`)
    /** 清空媒体映射回 null，选择后关闭重开仍保留当前草稿。 */
    await selectOption(window, '采用素材', '暂无素材'); await click(window, button('保存设置'))
    assert.equal((await service.invoke('load', { sessionId, productionId })).document.shots[0]!.mediaId, null)
    await click(window, button('镜头设置')); await selectOption(window, '采用素材', `${media.name} · ${media.kind}`); await click(window, button('保存设置'))
    await wait(window, `!document.querySelector('[role="dialog"]') && document.querySelector('.vp-player img')?.naturalWidth > 0`)
    await click(window, button('镜头设置')); await fill(window, '画面描述', '尚未保存的描述'); await click(window, button('关闭')); await click(window, button('镜头设置'))
    assert.equal(await window.webContents.executeJavaScript(`document.querySelector('[role="dialog"] textarea').value`), '尚未保存的描述')
    await click(window, button('关闭')); await click(window, button('引用到 Agent'))
    assert.ok(await window.webContents.executeJavaScript(`window.__visualSmoke.prompt().message.includes(${JSON.stringify(productionId)})`))
    const current = await service.invoke('load', { sessionId, productionId })
    assert.equal(current.document.kind, 'promo')
    assert.equal(current.document.ratio, '4:3')
    assert.equal(current.document.fps, 50)
    assert.equal(current.document.assets[0]!.type, '产品')
    const { schemaVersion: _schema, id: _id, revision, createdAt: _created, updatedAt: _updated, ...draft } = current.document
    const job = await access().execute('beginJob', { sessionId, productionId, baseRevision: revision, instruction: '修改开场', shotId: draft.shots[0]!.id })
    await access().execute('updateJob', { sessionId, productionId, baseRevision: revision, jobId: job.id, stage: 'generating' })
    /** 制作任务从各页签正文移出，完整记录只在统一入口打开后显示。 */
    assert.equal(await window.webContents.executeJavaScript(`document.querySelector('main')?.textContent.includes('制作任务与候选')`), false, '制作记录不应常驻页签底部')
    await click(window, `document.querySelector('[aria-label^="制作记录"]')`)
    await wait(window, `document.body.textContent.includes('生成媒体中')`)
    draft.shots[0]!.scene = 'Agent 候选中的新画面'
    await access().execute('propose', { sessionId, productionId, baseRevision: revision, jobId: job.id, draft, summary: '更新开场画面' })
    await wait(window, button('采用候选'))
    assert.equal((await service.invoke('load', { sessionId, productionId })).document.shots[0]!.scene, '主角出现在画面中央')
    await click(window, button('预览')); await wait(window, `document.querySelector('[role="dialog"]')?.textContent.includes('Agent 候选中的新画面')`)
    assert.equal(await window.webContents.executeJavaScript(`document.querySelectorAll('[role="dialog"] figure').length`), 2, '单镜头候选没有展示当前与新结果对比')
    await click(window, button('采用候选'))
    await wait(window, `document.body.textContent.includes('已采用')`)
    assert.equal((await service.invoke('load', { sessionId, productionId })).document.shots[0]!.scene, 'Agent 候选中的新画面')
    await window.loadURL(process.env.VISUAL_SMOKE_URL!)
    await wait(window, `document.querySelector('.vp-top')?.textContent.includes('影像首版验收')`)
    await click(window, button('分镜')); await wait(window, `document.querySelector('.vp-player img')?.naturalWidth > 0`)
    await writeFile('/private/tmp/dutydeck-visual-production-v1-desktop.png', (await window.webContents.capturePage()).toPNG())
    window.setSize(460, 760)
    await click(window, button('镜头设置'))
    await wait(window, button('保存设置'))
    await window.webContents.executeJavaScript('new Promise(resolve=>setTimeout(resolve,200))')
    const geometry = await window.webContents.executeJavaScript(`(()=>{const dialog=document.querySelector('[role="dialog"]');const footer=document.querySelector('.vp-form-footer');return{width:dialog.getBoundingClientRect().width,bottom:footer.getBoundingClientRect().bottom,viewport:innerHeight,overflow:document.documentElement.scrollWidth>innerWidth}})()`)
    assert.ok(geometry.width <= 460 && geometry.bottom <= geometry.viewport && !geometry.overflow, JSON.stringify(geometry))
    await writeFile('/private/tmp/dutydeck-visual-production-v1-dialog.png', (await window.webContents.capturePage()).toPNG())
    await window.webContents.executeJavaScript("document.documentElement.classList.add('dark')")
    await writeFile('/private/tmp/dutydeck-visual-production-v1-dark.png', (await window.webContents.capturePage()).toPNG())
    await click(window, button('关闭'))
    window.setSize(1000, 800)
    /** 两个真实镜头验证实际视频播放、时长截断和后续静帧连续播放。 */
    const clip = await access().execute('importFile', { sessionId, productionId, relativePath: 'clip.mp4' })
    const playback = await service.invoke('load', { sessionId, productionId })
    const { schemaVersion: _ps, id: _pi, revision: playbackRevision, createdAt: _pc, updatedAt: _pu, ...playbackDraft } = playback.document
    playbackDraft.ratio = '9:16'
    playbackDraft.shots[0]!.mediaId = clip.id
    playbackDraft.shots[0]!.duration = 0.5
    playbackDraft.shots.push({ ...playbackDraft.shots[0]!, id: 'second-shot', title: '第二镜头', mediaId: media.id, duration: 0.5 })
    await access().execute('save', { sessionId, productionId, baseRevision: playbackRevision, draft: playbackDraft })
    await wait(window, `document.querySelector('.vp-player video')?.readyState >= 2`)
    /** 竖幅预演必须维持作品比例，不能仅改变文字标签。 */
    const frameRatio = await window.webContents.executeJavaScript(`(()=>{const frame=document.querySelector('.vp-player').getBoundingClientRect();return frame.width/frame.height})()`)
    assert.ok(Math.abs(frameRatio - 9 / 16) < 0.02, `竖幅画框比例错误：${frameRatio}`)
    await click(window, button('连续播放'))
    await wait(window, `document.querySelector('.vp-player video')?.currentTime > 0`)
    await wait(window, `document.querySelector('.vp-shot[aria-pressed="true"]')?.textContent.includes('第二镜头')`)
    await wait(window, button('连续播放'))
    await click(window, `document.querySelector('.vp-shot')`)
    await click(window, button('连续播放'))
    await window.webContents.executeJavaScript('window.__visualSmoke.active(false)')
    await wait(window, `document.querySelector('.vp-player video')?.paused`)
    await window.webContents.executeJavaScript('window.__visualSmoke.active(true)')
    /** 指定第二镜头换真实视频：候选可播放，采用前后验证其他镜头和资产完全保留。 */
    const beforeReplacement = await service.invoke('load', { sessionId, productionId })
    const replacementJob = await access().execute('beginJob', { sessionId, productionId, baseRevision: beforeReplacement.document.revision, instruction: '只更换第二镜头', shotId: 'second-shot' })
    const replacement = await access().execute('proposeShot', { sessionId, productionId, baseRevision: beforeReplacement.document.revision, jobId: replacementJob.id, shotId: 'second-shot', mediaId: clip.id, summary: '第二镜头视频候选' })
    await wait(window, `document.querySelector('[aria-label^="制作记录"]')?.getAttribute('aria-label').includes('1 待采用')`)
    await click(window, `document.querySelector('[aria-label^="制作记录"]')`)
    assert.equal(await window.webContents.executeJavaScript(`document.querySelectorAll('.vp-records-tabs [role="tab"]').length`), 7)
    assert.equal(await window.webContents.executeJavaScript(`${recordTab('all')}?.getAttribute('aria-selected')`), 'true', '记录默认显示全部状态')
    await click(window, recordTab('pending'))
    await wait(window, `document.querySelectorAll('.vp-record').length === 1 && ${recordTab('pending')}?.getAttribute('aria-label') === '待采用，1 条任务'`)
    assert.equal(await window.webContents.executeJavaScript(`document.querySelectorAll('[data-job-id="${replacementJob.id}"]').length`), 1, '任务和对应候选应只出现一条记录')
    await click(window, `[...document.querySelectorAll('.vp-record')].find(node=>node.textContent.includes('第二镜头视频候选'))?.querySelector('button')`)
    await wait(window, `document.querySelector('[role="dialog"] video[controls]')?.readyState >= 2`)
    await bounded('播放候选视频', window.webContents.executeJavaScript(`document.querySelector('[role="dialog"] video').play()`))
    await wait(window, `document.querySelector('[role="dialog"] video')?.currentTime > 0`)
    await window.webContents.executeJavaScript(`document.querySelector('[role="dialog"] video').pause()`)
    assert.deepEqual((await service.invoke('load', { sessionId, productionId })).document, beforeReplacement.document)
    /** 等弹窗入场与图片解码结束再截图，不能把动画中间帧当成视觉验收。 */
    await wait(window, `document.querySelector('[role="dialog"] img')?.naturalWidth > 0`)
    await wait(window, `!document.getAnimations().some(animation=>Number.isFinite(animation.effect?.getComputedTiming().endTime) && animation.playState === 'running')`)
    await writeFile('/private/tmp/dutydeck-visual-production-candidate-compare.png', (await window.webContents.capturePage()).toPNG())
    await click(window, button('采用候选'))
    await wait(window, `document.querySelector('[role="dialog"]')?.textContent.includes('已采用')`)
    const afterReplacement = await service.invoke('load', { sessionId, productionId })
    assert.equal(afterReplacement.document.shots[1]!.mediaId, clip.id)
    assert.deepEqual(afterReplacement.document.shots[0], beforeReplacement.document.shots[0])
    assert.deepEqual(afterReplacement.document.assets, beforeReplacement.document.assets)
    assert.equal(afterReplacement.candidates.find(item => item.id === replacement.id)?.status, 'adopted')
    await click(window, button('返回记录'))
    await wait(window, `${recordTab('adopted')}?.getAttribute('aria-selected') === 'true' && document.querySelector('[data-job-id="${replacementJob.id}"]')`)
    await pressKey(window, 'Escape', 27)
    await wait(window, `!document.querySelector('[role="dialog"]')`)
    await wait(window, `document.activeElement?.getAttribute('aria-label')?.startsWith('制作记录')`)
    /** 失败重试走主会话，使用当前版本且不恢复旧任务。 */
    const failedJob = await access().execute('beginJob', { sessionId, productionId, baseRevision: afterReplacement.document.revision, instruction: '第二镜头推进', shotId: 'second-shot' })
    await access().execute('failJob', { sessionId, productionId, jobId: failedJob.id, message: '测试供应商暂不可用' })
    await click(window, `document.querySelector('[aria-label^="制作记录"]')`)
    await click(window, recordTab('failed'))
    await wait(window, button('引用到 Agent 重试'))
    await click(window, button('引用到 Agent 重试'))
    assert.ok(await window.webContents.executeJavaScript(`window.__visualSmoke.prompt().message.includes('shotId: second-shot') && window.__visualSmoke.prompt().message.includes('revision: ${afterReplacement.document.revision}') && window.__visualSmoke.prompt().autoSend === false`))
    /** A → B → A 的旧保存回流不得清掉新打开的草稿。 */
    const another = await access().execute('create', { sessionId, title: '另一个作品', kind: 'image' })
    await click(window, button('镜头设置'))
    /** 前一阶段关闭保留的草稿基于旧版，显式丢弃后才开始新的时序场景。 */
    if (await window.webContents.executeJavaScript(`Boolean(${button('放弃草稿，读取最新')})`)) {
      await click(window, button('放弃草稿，读取最新'))
      await click(window, button('镜头设置'))
    }
    await fill(window, '画面描述', '延迟响应前的编辑')
    holdSave = true
    await click(window, button('保存设置'))
    for (let count = 0; count < 100 && !releaseSave; count++) await new Promise(resolve => setTimeout(resolve, 30))
    assert.ok(releaseSave, '未进入保存响应延迟')
    await window.webContents.executeJavaScript(`window.__visualSmoke.select(${JSON.stringify(another.document.id)})`)
    await wait(window, `document.querySelector('.vp-top')?.textContent.includes('另一个作品')`)
    await window.webContents.executeJavaScript(`window.__visualSmoke.select(${JSON.stringify(productionId)})`)
    await wait(window, `document.querySelector('.vp-top')?.textContent.includes('影像首版验收')`)
    await click(window, button('编辑设定')); await fill(window, '作品目标', '切回之后继续填写的草稿')
    releaseSave(); releaseSave = undefined
    await new Promise(resolve => setTimeout(resolve, 250))
    assert.equal(await window.webContents.executeJavaScript(`document.querySelector('[role="dialog"] textarea')?.value`), '切回之后继续填写的草稿')
    await click(window, button('关闭'))
    /** 长短标题与空画面、图片、视频混排，验证横向分镜在真实窗口中保持对齐。 */
    const stripSnapshot = await service.invoke('load', { sessionId, productionId })
    const { schemaVersion: _ss, id: _si, revision: stripRevision, createdAt: _sc, updatedAt: _su, ...stripDraft } = stripSnapshot.document
    /** 保留用户名称里的序号，测试超长文本截断而不改变原始标题。 */
    const stripTitles = ['01 | 古镜里的白光', '02 | 醒在刀下', '03 | 两件定罪证物', '04 | 先验刀，再杀我', '05 | 仵作要求验尸', '06 | 尸身上的细微伤口透露另一条线索', '07 | 围观', '08 | 凶手露出破绽', '09 | 当众复原案发现场', '10 | 刑场风起', '11 | 真相渐明', '12 | 县令忽然躬身喊了一声：沈警官']
    stripDraft.shots = stripTitles.map((title, index) => ({ ...stripDraft.shots[0]!, id: `strip-shot-${index}`, title, duration: index >= 10 ? 1 : 6 + index % 3, mediaId: index === 4 ? clip.id : index === 5 || index >= 10 ? media.id : null }))
    await access().execute('save', { sessionId, productionId, baseRevision: stripRevision, draft: stripDraft })
    await click(window, button('分镜'))
    await wait(window, `document.querySelectorAll('.vp-shot').length === 12`)
    /** 只测几何与真实选择结果，不复制布局实现；viewportWidth 用于复用宽窄窗口验收。 */
    async function verifyStripLayout(viewportWidth: number): Promise<void> {
      /** DOM 测量保留每层顶边和高度，覆盖短标题及单行截断后的纵向对齐。 */
      const layout = await window.webContents.executeJavaScript(`(()=>{
        const rect=node=>{const b=node.getBoundingClientRect();return{top:b.top,height:b.height}};
        const strip=document.querySelector('.vp-strip');const body=document.querySelector('.vp-body');
        return{width:innerWidth,pageOverflow:document.documentElement.scrollWidth>innerWidth,bodyOverflow:body.scrollWidth>body.clientWidth,stripOverflow:strip.scrollWidth>strip.clientWidth,
          rows:[...strip.querySelectorAll('.vp-shot')].map(card=>({card:rect(card),preview:rect(card.querySelector('.vp-shot-preview')),title:rect(card.querySelector('.vp-shot-title')),footer:rect(card.querySelector('.vp-shot-footer'))}))};
      })()`)
      assert.equal(layout.width, viewportWidth)
      assert.ok(!layout.pageOverflow && !layout.bodyOverflow && layout.stripOverflow, JSON.stringify(layout))
      for (const row of layout.rows) for (const part of ['card', 'preview', 'title', 'footer']) {
        assert.ok(Math.abs(row[part].top - layout.rows[0][part].top) < 1 && Math.abs(row[part].height - layout.rows[0][part].height) < 1, `分镜 ${part} 未对齐：${JSON.stringify(layout)}`)
      }
    }
    await verifyStripLayout(1000)
    assert.equal(await window.webContents.executeJavaScript(`document.querySelector('.vp-shot-status').textContent`), '未生成')
    assert.equal(await window.webContents.executeJavaScript(`document.querySelectorAll('.vp-shot-title')[5].title`), stripTitles[5])
    await wait(window, `!document.getAnimations().some(animation=>Number.isFinite(animation.effect?.getComputedTiming().endTime) && animation.playState === 'running')`)
    await writeFile('/private/tmp/dutydeck-visual-production-strip-dark.png', (await window.webContents.capturePage()).toPNG())
    await window.webContents.executeJavaScript("document.documentElement.classList.remove('dark')")
    await wait(window, `!document.getAnimations().some(animation=>Number.isFinite(animation.effect?.getComputedTiming().endTime) && animation.playState === 'running')`)
    await writeFile('/private/tmp/dutydeck-visual-production-strip-light.png', (await window.webContents.capturePage()).toPNG())
    window.setSize(460, 760)
    await wait(window, 'innerWidth === 460')
    await verifyStripLayout(460)
    await writeFile('/private/tmp/dutydeck-visual-production-strip-narrow.png', (await window.webContents.capturePage()).toPNG())
    /** 绕过烟测 click 自身的滚动，直接触发末镜头选择，确保工作台只滚横向分镜。 */
    const verticalPosition = await window.webContents.executeJavaScript(`document.querySelector('.vp-body').scrollTop`)
    await window.webContents.executeJavaScript(`document.querySelectorAll('.vp-shot')[11].click()`)
    await wait(window, `document.querySelector('.vp-shot[aria-pressed="true"]')?.querySelector('.vp-shot-number').textContent === '12'`)
    await wait(window, `(()=>{const strip=document.querySelector('.vp-strip').getBoundingClientRect();const card=document.querySelector('.vp-shot[aria-pressed="true"]').getBoundingClientRect();return card.left>=strip.left && card.right<=strip.right+1})()`)
    assert.equal(await window.webContents.executeJavaScript(`document.querySelector('.vp-body').scrollTop`), verticalPosition, '切换镜头不应带动纵向工作区')
    /** 键盘可选回第 11 镜头，连续播放到第 12 镜头时自动跟随并在末尾停止。 */
    await window.webContents.executeJavaScript(`document.querySelectorAll('.vp-shot')[10].focus({preventScroll:true})`)
    await wait(window, `document.activeElement === document.querySelectorAll('.vp-shot')[10]`)
    await pressKey(window, 'Enter', 13)
    await wait(window, `document.querySelector('.vp-shot[aria-pressed="true"]')?.querySelector('.vp-shot-number').textContent === '11' && document.querySelector('.vp-player img')?.naturalWidth > 0`)
    await window.webContents.executeJavaScript(`document.querySelector('.vp-strip').scrollLeft = 0`)
    await click(window, button('连续播放'))
    await wait(window, `document.querySelector('.vp-shot[aria-pressed="true"]')?.querySelector('.vp-shot-number').textContent === '12'`)
    await wait(window, `(()=>{const strip=document.querySelector('.vp-strip').getBoundingClientRect();const card=document.querySelector('.vp-shot[aria-pressed="true"]').getBoundingClientRect();return card.left>=strip.left && card.right<=strip.right+1})()`)
    await wait(window, button('连续播放'))
    /** 长任务和已过期候选在统一弹窗中管理，关闭后所有页签正文均保持精简。 */
    const recordsSnapshot = await service.invoke('load', { sessionId, productionId })
    const longInstruction = '请保持角色、场景和运镜一致，补齐本集参考素材并提交候选，正式采用仍由用户确认。'.repeat(30)
    const recordsJob = await access().execute('beginJob', { sessionId, productionId, baseRevision: recordsSnapshot.document.revision, instruction: longInstruction, shotId: 'strip-shot-11' })
    const staleCandidate = await access().execute('proposeShot', { sessionId, productionId, baseRevision: recordsSnapshot.document.revision, jobId: recordsJob.id, shotId: 'strip-shot-11', mediaId: clip.id, summary: '末镜头待审阅结果' })
    /** 正式设置更新让候选过期，仍须可见但不可采用。 */
    const { schemaVersion: _rs, id: _ri, revision: recordsRevision, createdAt: _rc, updatedAt: _ru, ...recordsDraft } = recordsSnapshot.document
    recordsDraft.brief += '；已调整制作目标'
    await access().execute('save', { sessionId, productionId, baseRevision: recordsRevision, draft: recordsDraft })
    const activeJob = await access().execute('beginJob', { sessionId, productionId, baseRevision: recordsRevision + 1, instruction: longInstruction, shotId: 'strip-shot-11' })
    await wait(window, `document.querySelector('[aria-label^="制作记录"]')?.getAttribute('aria-label').includes('1 进行中 · 1 需更新')`)
    for (const tab of ['项目', '资产', '分镜', '画布', '交付']) {
      await click(window, button(tab))
      assert.equal(await window.webContents.executeJavaScript(`document.querySelector('main').textContent.includes('制作任务与候选') || Boolean(document.querySelector('.vp-record'))`), false, '关闭弹窗时各页签不应挂载制作记录')
    }
    await click(window, `document.querySelector('[aria-label^="制作记录"]')`)
    await wait(window, `document.querySelectorAll('.vp-record').length === 5`)
    assert.deepEqual(await window.webContents.executeJavaScript(`[...document.querySelectorAll('.vp-records-tab-count')].map(node=>Number(node.textContent))`), [5, 1, 0, 2, 1, 1, 0], '数量以任务为单位，覆盖全部状态且不重复计数')
    assert.equal(await window.webContents.executeJavaScript(`Boolean(document.querySelector('[data-candidate-id="${staleCandidate.id}"]')?.textContent.includes('采用候选'))`), false)
    /** 用真实键盘验证窄窗页签跟随、首尾定位和方向键切换，焦点不能被正文抢走。 */
    await window.webContents.executeJavaScript(`${recordTab('all')}.focus()`)
    for (const [key, code, status] of [['End', 35, 'closed'], ['Home', 36, 'all'], ['ArrowRight', 39, 'running']] as const) {
      await pressKey(window, key, code)
      await wait(window, `${recordTab(status)}?.getAttribute('aria-selected') === 'true' && document.activeElement === ${recordTab(status)}`)
      await wait(window, `(()=>{const bounds=document.querySelector('.vp-records-tabs').getBoundingClientRect();const selected=${recordTab(status)}.getBoundingClientRect();return selected.left>=bounds.left-1 && selected.right<=bounds.right+1})()`)
    }
    assert.equal(await window.webContents.executeJavaScript(`document.querySelectorAll('.vp-record').length`), 1, '进行中页签只显示运行任务')
    assert.equal(await window.webContents.executeJavaScript(`document.querySelector('[data-job-id="${activeJob.id}"] .vp-record-details').open`), false)
    /** 长文案限制在摘要内，完整文本在详情中可读且不撑破窄窗。 */
    const recordsGeometry = await window.webContents.executeJavaScript(`(()=>{const dialog=document.querySelector('[role="dialog"]');const title=document.querySelector('[data-job-id="${activeJob.id}"] .vp-record-title');return{width:dialog.getBoundingClientRect().width,bottom:dialog.getBoundingClientRect().bottom,overflow:dialog.scrollWidth>dialog.clientWidth,titleHeight:title.getBoundingClientRect().height,viewport:innerHeight}})()`)
    assert.ok(recordsGeometry.width <= 460 && recordsGeometry.bottom <= recordsGeometry.viewport && !recordsGeometry.overflow && recordsGeometry.titleHeight <= 41, JSON.stringify(recordsGeometry))
    await wait(window, `!document.getAnimations().some(animation=>Number.isFinite(animation.effect?.getComputedTiming().endTime) && animation.playState === 'running')`)
    await writeFile('/private/tmp/dutydeck-visual-records-narrow.png', (await window.webContents.capturePage()).toPNG())
    await click(window, `document.querySelector('[data-job-id="${activeJob.id}"] .vp-record-details summary')`)
    await wait(window, `document.querySelector('[data-job-id="${activeJob.id}"] .vp-record-details')?.open`)
    assert.equal(await window.webContents.executeJavaScript(`document.querySelector('[data-job-id="${activeJob.id}"] .vp-record-details p').textContent`), longInstruction)
    /** 展开长详情后只滚动正文，状态页签仍固定在弹窗顶部。 */
    const tabsTop = await window.webContents.executeJavaScript(`document.querySelector('.vp-records-tabs').getBoundingClientRect().top`)
    await window.webContents.executeJavaScript(`document.querySelector('.vp-records-body').scrollTop = document.querySelector('.vp-records-body').scrollHeight`)
    assert.ok(await window.webContents.executeJavaScript(`document.querySelector('.vp-records-body').scrollTop > 0`))
    assert.equal(await window.webContents.executeJavaScript(`document.querySelector('.vp-records-tabs').getBoundingClientRect().top`), tabsTop)
    await click(window, `document.querySelector('[data-job-id="${activeJob.id}"] .vp-record-details summary')`)
    await click(window, recordTab('pending'))
    await wait(window, `document.querySelector('.vp-records-empty')?.textContent === '暂无待采用的结果' && !document.querySelector('.vp-record')`)
    await click(window, recordTab('adopted'))
    await wait(window, `document.querySelectorAll('.vp-record').length === 2`)
    await click(window, recordTab('failed'))
    await wait(window, `document.querySelectorAll('.vp-record').length === 1 && document.querySelector('[data-job-id="${failedJob.id}"]')`)
    await click(window, recordTab('all'))
    window.setSize(1000, 800)
    await window.webContents.executeJavaScript("document.documentElement.classList.add('dark')")
    await wait(window, `innerWidth === 1000 && !document.getAnimations().some(animation=>Number.isFinite(animation.effect?.getComputedTiming().endTime) && animation.playState === 'running')`)
    await writeFile('/private/tmp/dutydeck-visual-records-dark.png', (await window.webContents.capturePage()).toPNG())
    await click(window, recordTab('running'))
    await click(window, button('取消任务'))
    await wait(window, `${recordTab('running')}?.getAttribute('aria-selected') === 'true' && document.querySelector('.vp-records-empty')?.textContent === '暂无进行中的任务'`)
    assert.equal((await service.invoke('load', { sessionId, productionId })).jobs.find(item => item.id === activeJob.id)?.status, 'cancelled')
    await click(window, recordTab('closed'))
    await wait(window, `document.querySelector('[data-job-id="${activeJob.id}"]')?.textContent.includes('已取消')`)
    await click(window, recordTab('stale'))
    await wait(window, `document.querySelectorAll('.vp-record').length === 1 && document.querySelector('[data-candidate-id="${staleCandidate.id}"]')`)
    await click(window, button('预览'))
    await wait(window, button('返回记录'))
    await click(window, button('丢弃'))
    await wait(window, `document.querySelector('[role="dialog"]')?.textContent.includes('已丢弃')`)
    await click(window, button('返回记录'))
    await wait(window, `${recordTab('closed')}?.getAttribute('aria-selected') === 'true' && document.querySelectorAll('.vp-record').length === 2`)
    assert.deepEqual(await window.webContents.executeJavaScript(`[...document.querySelectorAll('.vp-records-tab-count')].map(node=>Number(node.textContent))`), [5, 0, 0, 2, 1, 0, 2])
    assert.equal((await service.invoke('load', { sessionId, productionId })).candidates.find(item => item.id === staleCandidate.id)?.status, 'discarded')
    /** 切换作品时销毁旧记录浏览状态，避免候选详情跨项目残留。 */
    await window.webContents.executeJavaScript(`window.__visualSmoke.select(${JSON.stringify(another.document.id)})`)
    await wait(window, `!document.querySelector('[role="dialog"]') && document.querySelector('.vp-top')?.textContent.includes('另一个作品')`)
    await click(window, `document.querySelector('[aria-label^="制作记录"]')`)
    await wait(window, `document.querySelector('[role="dialog"]')?.textContent.includes('暂无制作记录')`)
    await verifyMediaConfiguration(another.document.id, another.document.revision)
    assert.deepEqual(errors, [])
    console.log('PASS: real IPC + preload + persistence; asset hover/focus image previews, lazy reads, missing/video/error states, late response isolation, keyboard selection, Blob cleanup, themed checkboxes and collapsible media import; original creation/edit/media/playback/draft regressions; compact shot strip; records status tabs/counts/empty states, keyboard navigation, fixed tabs, preview/adopt/discard/back/focus, cancellation/retry, 460px content and project isolation. media config defaults/parameters/tab drafts/empty scope/disabled options/ComfyUI. No model calls or real user data.')
  } finally { window.destroy() }
}

/** Bun 负责隔离目录和子进程清理，Electron 只操作测试项目。 */
async function orchestrate(): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'dutydeck-visual-smoke-'))
  const fixtureHtml = join(process.cwd(), 'scripts', `.visual-smoke-${process.pid}.html`)
  const fixtureConfig = join(process.cwd(), 'scripts', `.visual-smoke-${process.pid}.ts`)
  const listenPort = await port()
  const url = `http://127.0.0.1:${listenPort}/@fs${fixtureHtml}`
  const { mkdir } = await import('node:fs/promises')
  await mkdir(join(root, 'project'))
  await writeFile(join(root, 'project', 'frame.png'), Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64'))
  /** 本机生成两秒色卡测试视频，不下载素材或调用生成服务。 */
  await new Promise<void>((resolve, reject) => {
    const encoder = spawn('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'color=c=blue:s=160x90:d=2', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', join(root, 'project', 'clip.mp4')])
    encoder.once('error', reject)
    encoder.once('exit', code => code === 0 ? resolve() : reject(new Error('测试视频生成失败，需要本机 ffmpeg')))
  })
  await writeFile(fixtureHtml, '<html lang="zh-CN"><head><meta charset="utf-8"></head><body><div id="root"></div><script type="module">import RefreshRuntime from "/@react-refresh";RefreshRuntime.injectIntoGlobalHook(window);window.$RefreshReg$=()=>{};window.$RefreshSig$=()=>type=>type;</script><script type="module" src="./visual-production-ui-smoke-renderer.tsx"></script></body></html>')
  await writeFile(fixtureConfig, "import config from '../vite.config';export default {...config,server:{...config.server,hmr:false,watch:null}}")
  const vite = spawn(process.execPath, [join(process.cwd(), 'node_modules/vite/bin/vite.js'), '--config', fixtureConfig, '--host', '127.0.0.1', '--port', String(listenPort), '--strictPort'], { stdio: 'inherit' })
  try {
    for (let count = 0; count < 100; count++) { try { if ((await fetch(url)).ok) break } catch { /* 等待 Vite 启动。 */ } await new Promise(resolve => setTimeout(resolve, 100)) }
    const build = await Bun.build({ entrypoints: ['scripts/visual-production-ui-smoke.ts', 'scripts/visual-production-ui-smoke-preload.ts'], outdir: root, target: 'node', format: 'cjs', external: ['electron'] })
    if (!build.success) throw new Error(build.logs.join('\n'))
    const child = spawn(join(process.cwd(), 'node_modules/.bin/electron'), [join(root, 'visual-production-ui-smoke.js')], { env: { ...process.env, VISUAL_SMOKE_CHILD: '1', VISUAL_SMOKE_DIR: root, VISUAL_SMOKE_URL: url }, stdio: 'inherit' })
    const code = await new Promise<number>((resolve, reject) => {
      const timeout = setTimeout(() => { console.error('影像 UI smoke 超过100秒，终止测试子进程'); child.kill('SIGKILL') }, 100000)
      child.once('error', error => { clearTimeout(timeout); reject(error) })
      child.once('exit', (code, signal) => { clearTimeout(timeout); if (signal) reject(new Error(`影像 UI smoke 被信号终止：${signal}`)); else resolve(code ?? 1) })
    })
    assert.equal(code, 0)
  } finally {
    vite.kill('SIGTERM')
    await rm(fixtureHtml, { force: true }); await rm(fixtureConfig, { force: true }); await rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 })
  }
}
if (process.env.VISUAL_SMOKE_CHILD === '1') void runChild().then(() => (require('electron') as typeof import('electron')).app.quit()).catch(error => { console.error(error); (require('electron') as typeof import('electron')).app.exit(1) })
else void orchestrate().catch(error => { console.error(error); process.exitCode = 1 })
