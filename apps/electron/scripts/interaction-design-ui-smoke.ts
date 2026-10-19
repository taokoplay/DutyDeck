import { strict as assert } from 'node:assert'
import { spawn } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { BrowserWindow } from 'electron'
import { PROTOTYPE_DEVICES } from '../src/renderer/components/interaction-design/interaction-design-devices'

/** 从系统申请空闲端口，避免和用户正在运行的 dev 实例冲突。 */
async function availablePort(): Promise<number> {
  return await new Promise<number>((resolve, reject) => {
    const server = createServer()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      if (!address || typeof address === 'string') return reject(new Error('无法分配 smoke 端口'))
      server.close((error) => error ? reject(error) : resolve(address.port))
    })
  })
}

/** 等待真实 DOM 或内存状态成立，超时附带当前页面文本。 */
async function waitFor(window: BrowserWindow, expression: string, message: string): Promise<void> {
  const deadline = Date.now() + 15_000
  while (Date.now() < deadline) {
    if (await window.webContents.executeJavaScript(`Boolean(${expression})`)) return
    await new Promise<void>((resolve) => setTimeout(resolve, 40))
  }
  const evidence = await window.webContents.executeJavaScript(`({ text: document.body.innerText.slice(0, 1800), html: document.body.innerHTML.slice(0, 1200), devices: [...document.querySelectorAll('[data-device]')].map(node => ({ className: node.className, device: node.getAttribute('data-device'), width: node.getBoundingClientRect().width, height: node.getBoundingClientRect().height })), calls: window.__interactionSmoke?.state?.calls?.slice(-8) })`)
  console.error(`[Interaction Design UI smoke] 等待失败：${message}`, evidence)
  throw new Error(message)
}

/** 从当前活动画板取得 frame，缓存页也留在主进程 frames 中，不能按总数或旧名字推断。 */
async function activeFrame(window: BrowserWindow, stateId = ''): Promise<import('electron').WebFrameMain | undefined> {
  /** DOM 上实际活动画板声明的唯一名称，用于匹配跨源 Electron frame。 */
  const name = await window.webContents.executeJavaScript<string | null>(`document.querySelector('.id-cached-page[data-active="true"] [data-state-id=\"'+CSS.escape(${JSON.stringify(stateId)})+'\"] iframe')?.name ?? null`)
  return name ? window.webContents.mainFrame.frames.find(frame => frame.name === name) : undefined
}

/** 等待当前页面 iframe 的正文就绪；仅存在 iframe 节点不能证明页面已显示。 */
async function waitForPreviewText(window: BrowserWindow, expected: string): Promise<void> {
  const deadline = Date.now() + 15_000
  while (Date.now() < deadline) {
    const frame = await activeFrame(window)
    if (frame) {
      try {
        const text = await Promise.race([frame.executeJavaScript<string>('document.body?.innerText ?? ""'), new Promise<string>(resolve => setTimeout(() => resolve(''), 500))])
        if (text.includes(expected)) return
      } catch { /* iframe 尚在切换文档，下一轮继续读取。 */ }
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 40))
  }
  console.error('[Interaction Design UI smoke] 正文等待诊断', await window.webContents.executeJavaScript(`({text:document.body.innerText.slice(0,1800),frames:[...document.querySelectorAll('.id-cached-page iframe')].map(frame=>({name:frame.name,active:frame.closest('.id-cached-page').dataset.active,sourceLength:frame.srcdoc.length})),reads:window.__interactionSmoke.state.assetReadCounts,active:window.__interactionSmoke.state.assetsInFlight})`))
  throw new Error(`当前页面正文未加载：${expected}`)
}

/**
 * 等待当前页面所有示例图片完成解码，验证单张资产失败不会拖垮整页。
 * @param window 当前 Electron 窗口。
 * @returns 已完成解码的图片属性，供调用方核对数据 URL 和占位图。
 */
async function waitForPreviewImages(window: BrowserWindow): Promise<Array<{ alt: string; src: string; naturalWidth: number }>> {
  const deadline = Date.now() + 15_000
  while (Date.now() < deadline) {
    const frame = await activeFrame(window)
    if (frame) {
      try {
        /** 子文档切换期间 Chromium 可能暂不响应脚本执行，单次读取必须有界。 */
        const images = await Promise.race([
          frame.executeJavaScript<Array<{ alt: string; src: string; naturalWidth: number; complete: boolean }>>(`([...document.querySelectorAll('img[alt]')]).map(image => ({ alt: image.getAttribute('alt') ?? '', src: image.getAttribute('src') ?? '', naturalWidth: image.naturalWidth, complete: image.complete }))`),
          new Promise<null>(resolve => setTimeout(() => resolve(null), 500)),
        ])
        if (images && images.length >= 2 && images.every(image => image.complete && image.naturalWidth > 0)) return images
      } catch { /* iframe 尚在切换文档，下一轮继续读取。 */ }
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 40))
  }
  throw new Error('当前页面图片未完成加载')
}

/** 在宿主坐标发送完整可信点击；鼠标移动确保跨 iframe 后命中目标窗口。 */
async function clickPoint(window: BrowserWindow, point: { x: number; y: number }): Promise<void> {
  window.focus()
  window.webContents.debugger.attach('1.3')
  try {
    await window.webContents.debugger.sendCommand('Input.dispatchMouseEvent', { type: 'mouseMoved', ...point })
    await window.webContents.debugger.sendCommand('Input.dispatchMouseEvent', { type: 'mousePressed', ...point, button: 'left', buttons: 1, clickCount: 1 })
    await window.webContents.debugger.sendCommand('Input.dispatchMouseEvent', { type: 'mouseReleased', ...point, button: 'left', buttons: 0, clickCount: 1 })
  } finally { window.webContents.debugger.detach() }
}

/** 等待有限的弹窗/菜单动画和下一帧布局，避免真实点击落到退出遮罩或移动中的按钮。 */
async function settleUi(window: BrowserWindow): Promise<void> {
  await window.webContents.executeJavaScript(`Promise.all(document.getAnimations().filter(animation=>Number.isFinite(animation.effect?.getComputedTiming().endTime)).map(animation=>animation.finished.catch(()=>undefined))).then(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))))`)
}

/** 点击精确文本的可见按钮或 Radix Tab。 */
async function click(window: BrowserWindow, label: string): Promise<void> {
  const expression = `[...(document.querySelector('[role="alertdialog"]') ?? document.querySelector('[role="dialog"]') ?? document).querySelectorAll('button,[role="tab"],[role="menuitem"]')].find((element) => element.textContent?.trim() === ${JSON.stringify(label)} && element.getBoundingClientRect().width > 0)`
  await waitFor(window, expression, `缺少可见入口：${label}`)
  await settleUi(window)
  const point = await window.webContents.executeJavaScript(`(async () => {
    const element = ${expression};
    if (!(element instanceof HTMLElement)) return null;
    element.scrollIntoView({ block: 'nearest' });
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    const rect = element.getBoundingClientRect();
    return { x: Math.round(rect.left + rect.width / 2), y: Math.round(rect.top + rect.height / 2) };
  })()`)
  assert.ok(point, `无法点击：${label}`)
  await clickPoint(window, point)
}


/** 真实指针事件覆盖 Radix pointerdown。 */
async function clickSelector(window: BrowserWindow, selector: string): Promise<void> {
  /** 缓存页可能包含同名按钮，只允许真实可见的活动节点接收测试点击。 */
  const expression = `[...document.querySelectorAll(${JSON.stringify(selector)})].find(node=>node.getBoundingClientRect().width>0)`
  await waitFor(window, expression, `缺少可见节点 ${selector}`)
  await settleUi(window)
  const point = await window.webContents.executeJavaScript(`(async () => {const node=${expression};node.scrollIntoView({block:'nearest'});await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));const rect=node.getBoundingClientRect();return {x:Math.round(rect.x+rect.width/2),y:Math.round(rect.y+rect.height/2)}})()`)
  await clickPoint(window, point)
}

/** 点击包含指定文字的原型菜单项，覆盖 Radix 不暴露 RadioItem value 属性的实现。
 * @param window 当前 Electron smoke 窗口。
 * @param name 要选择的原型名称。
 * @returns 点击完成后的异步结果。
 */
async function clickPrototypeOption(window: BrowserWindow, name: string): Promise<void> {
  const expression = `[...document.querySelectorAll('[role="menuitemradio"]')].find(node=>node.textContent?.includes(${JSON.stringify(name)})&&node.getBoundingClientRect().width>0)`
  await waitFor(window, expression, `缺少可见原型菜单项 ${name}`)
  await settleUi(window)
  const point = await window.webContents.executeJavaScript(`(async () => {const node=${expression};node.scrollIntoView({block:'nearest'});await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));const rect=node.getBoundingClientRect();return {x:Math.round(rect.x+rect.width/2),y:Math.round(rect.y+rect.height/2)}})()`)
  assert.ok(point, `无法点击原型菜单项：${name}`)
  await clickPoint(window, point)
}
/**
 * 按页面选择按钮的可访问标签点击目录页面，忽略入口和状态元数据。
 * @param window 当前 Electron 窗口。
 * @param pageName 要选择的页面名称。
 * @returns 页面按钮点击完成后的异步结果。
 */
async function clickPage(window: BrowserWindow, pageName: string): Promise<void> {
  // 根据页面名组装稳定的可访问标签选择器。
  const selector = `.id-page-select[aria-label=${JSON.stringify(`${pageName}页面`)}]`
  await clickSelector(window, selector)
}
/** 在指定状态沙箱内定位元素，再由宿主发送可信指针事件，覆盖真实选区/路由桥。 */
async function clickStateElement(window: BrowserWindow, stateId: string, selector: string): Promise<void> {
  // 缓存页面复显时正文已就绪，仍需等待 ResizeObserver 与两帧布局后计算真实点击坐标。
  await settleUi(window)
  /** 带状态名称的子 frame 与宿主画板匹配，不尝试跨源 DOM 访问。 */
  const deadline = Date.now() + 8_000
  /** srcDoc iframe 节点挂载先于导航完成，等待目标正文后再做坐标验收。 */
  let inner: { x: number; y: number } | null = null
  while (Date.now() < deadline && !inner) {
    const frame = await activeFrame(window, stateId)
    if (frame) inner = await frame.executeJavaScript(`(() => { const node = document.querySelector(${JSON.stringify(selector)}); if (!node) return null; const rect = node.getBoundingClientRect(); return {x:rect.x + rect.width / 2,y:rect.y + rect.height / 2} })()`)
    if (!inner) await new Promise<void>(resolve => setTimeout(resolve, 40))
  }
  assert.ok(inner, `缺少状态元素：${stateId} / ${selector}`)
  /** 用实际 iframe 变换比例换算到宿主窗口坐标。 */
  const outer = await window.webContents.executeJavaScript(`(() => { const frame = [...document.querySelectorAll('.id-cached-page[data-active="true"] iframe')].find(item => item.closest('[data-state-id]')?.getAttribute('data-state-id') === ${JSON.stringify(stateId)}); const rect = frame.getBoundingClientRect(); return {x:rect.x,y:rect.y,scale:rect.width / parseFloat(frame.style.width)} })()`)
  const point = { x: Math.round(outer.x + inner.x * outer.scale), y: Math.round(outer.y + inner.y * outer.scale) }
  /** Electron sendInputEvent 直接投给主 frame，OOPIF 需经 Chromium 输入路由生成可信事件。 */
  window.webContents.debugger.attach('1.3')
  try {
    await window.webContents.debugger.sendCommand('Input.dispatchMouseEvent', { type: 'mouseMoved', ...point })
    await window.webContents.debugger.sendCommand('Input.dispatchMouseEvent', { type: 'mousePressed', ...point, button: 'left', buttons: 1, clickCount: 1 })
    await window.webContents.debugger.sendCommand('Input.dispatchMouseEvent', { type: 'mouseReleased', ...point, button: 'left', buttons: 0, clickCount: 1 })
  } finally { window.webContents.debugger.detach() }

}
/** 读取指定状态六面体的真实计算矩阵；等待独立 iframe 初始化完成。 */
async function geometryMatrix(window: BrowserWindow, stateId: string): Promise<string> {
  /** 初始导航与 srcDoc 挂载不同步，轮询只用于测试等待。 */
  const deadline = Date.now() + 8_000
  while (Date.now() < deadline) {
    const frame = await activeFrame(window, stateId)
    if (frame) {
      const matrix = await frame.executeJavaScript<string>(`document.querySelectorAll('#cube .face').length === 6 ? getComputedStyle(document.querySelector('#cube')).transform : ''`)
      if (matrix.startsWith('matrix3d(')) return matrix
    }
    await new Promise<void>(resolve => setTimeout(resolve, 40))
  }
  throw new Error(`状态未渲染三维几何：${stateId}`)
}

/** 用 Chromium 可信输入路由在指定状态拖动或滚轮缩放，不派发合成 DOM 事件。 */
async function manipulateGeometry(window: BrowserWindow, stateId: string, gesture: 'drag' | 'wheel'): Promise<void> {
  /** 使用与真实画板相同的缩放比例定位，不跨源访问 iframe DOM。 */
  const frame = await activeFrame(window, stateId)
  assert.ok(frame)
  const inner = await frame.executeJavaScript<{ x: number; y: number }>(`(() => { const rect=document.querySelector('#viewport').getBoundingClientRect();return {x:rect.x+rect.width/2,y:rect.y+rect.height/2} })()`)
  const outer = await window.webContents.executeJavaScript(`(() => {const frame=[...document.querySelectorAll('.id-cached-page[data-active="true"] iframe')].find(item=>item.closest('[data-state-id]')?.getAttribute('data-state-id')===${JSON.stringify(stateId)});const rect=frame.getBoundingClientRect();return {x:rect.x,y:rect.y,scale:rect.width/parseFloat(frame.style.width)}})()`)
  const point = { x: Math.round(outer.x + inner.x * outer.scale), y: Math.round(outer.y + inner.y * outer.scale) }
  window.webContents.debugger.attach('1.3')
  try {
    await window.webContents.debugger.sendCommand('Input.dispatchMouseEvent', { type: 'mouseMoved', ...point })
    if (gesture === 'wheel') {
      await window.webContents.debugger.sendCommand('Input.dispatchMouseEvent', { type: 'mouseWheel', ...point, deltaX: 0, deltaY: -100 })
    } else {
      await window.webContents.debugger.sendCommand('Input.dispatchMouseEvent', { type: 'mousePressed', ...point, button: 'left', buttons: 1, clickCount: 1 })
      await window.webContents.debugger.sendCommand('Input.dispatchMouseEvent', { type: 'mouseMoved', x: point.x + 45, y: point.y + 10, button: 'left', buttons: 1 })
      await window.webContents.debugger.sendCommand('Input.dispatchMouseEvent', { type: 'mouseReleased', x: point.x + 45, y: point.y + 10, button: 'left', buttons: 0, clickCount: 1 })
    }
    // 等输入跨进程送达并完成绘制后再读取矩阵，避免异步投递假阴性。
    await new Promise<void>(resolve => setTimeout(resolve, 100))
  } finally { window.webContents.debugger.detach() }
}

/** 默认与附加状态均验证真实投影变化、复位、本地表单和选择模式隔离。 */
async function verifyGeometryInteraction(window: BrowserWindow): Promise<void> {
  window.setSize(1180, 850)
  await window.webContents.executeJavaScript(`(() => {
    const smoke=window.__interactionSmoke,page=smoke.state.snapshot.document.pages[0];
    page.html=smoke.geometryHtml;page.defaultStateName='默认场景';page.states=[{id:'selected',name:'选中场景',html:smoke.geometryHtml}];
    smoke.state.snapshot.document.revision+=1;smoke.change('workspace-a','proto-a');
  })()`)
  await waitFor(window, `document.querySelectorAll('.id-cached-page[data-active="true"] .id-state-board iframe').length===2 && document.querySelector('.id-cached-page[data-active="true"] [data-state-id="selected"]')`, '三维状态画板未就绪')
  await window.webContents.executeJavaScript(`document.querySelector('.id-cached-page[data-active="true"] .id-state-space').scrollTop=0`)
  await click(window, '体验')
  await waitFor(window, `document.querySelector('.id-mode button:first-child')?.getAttribute('aria-pressed')==='true'`, '三维回归未进入体验模式')
  for (const stateId of ['', 'selected']) {
    /** 同一个几何场景在不同状态中独立初始化，复位应返回原投影。 */
    const original = await geometryMatrix(window, stateId)
    await manipulateGeometry(window, stateId, 'drag')
    const rotated = await geometryMatrix(window, stateId)
    assert.notEqual(rotated, original, `${stateId} 拖动未改变三维投影`)
    await manipulateGeometry(window, stateId, 'wheel')
    assert.notEqual(await geometryMatrix(window, stateId), rotated, `${stateId} 滚轮未改变缩放`)
    await clickStateElement(window, stateId, '#reset')
    assert.equal(await geometryMatrix(window, stateId), original, `${stateId} 复位未恢复原视角`)
    /** 表单不得导航或重载；同时保留当前 iframe 身份和文档 URL 作为提交前基线。 */
    const frame = (await activeFrame(window, stateId))!
    const documentUrl = await frame.executeJavaScript<string>('location.href')
    await clickStateElement(window, stateId, 'button[type="submit"]')
    await new Promise<void>(resolve => setTimeout(resolve, 100))
    assert.equal(await activeFrame(window, stateId), frame, `${stateId} 本地表单替换了 iframe`)
    assert.equal(await frame.executeJavaScript('location.href'), documentUrl, `${stateId} 本地表单发生导航`)
    assert.equal(await frame.executeJavaScript(`document.querySelector('#result').textContent`), '1', `${stateId} 本地 onsubmit 未执行或发生导航`)
    await click(window, '选择修改')
    await waitFor(window, `document.querySelector('.id-mode button:last-child')?.getAttribute('aria-pressed')==='true'`, '三维回归未进入选择模式')
    assert.equal(await window.webContents.executeJavaScript(`(() => { const top=document.querySelector('.id-stage-top')?.textContent ?? ''; return !document.querySelector('.id-stage-hint') && top.includes('仅支持声明过身份的受控元素') && top.includes('引用到主会话') })()`), true, '选择模式说明未合并到顶部')
    await manipulateGeometry(window, stateId, 'drag')
    assert.equal(await geometryMatrix(window, stateId), original, `${stateId} 选择模式触发了页面拖动`)
    await clickStateElement(window, stateId, 'button[type="submit"]')
    assert.equal(await frame.executeJavaScript(`document.querySelector('#result').textContent`), '1', `${stateId} 选择模式触发了表单提交`)
    await click(window, '体验')
    await waitFor(window, `document.querySelector('.id-mode button:first-child')?.getAttribute('aria-pressed')==='true'`, '三维回归未恢复体验模式')
  }
  await writeFile('/private/tmp/interaction-design-geometry-states.png', (await window.webContents.capturePage()).toPNG())
}

/** Given 已打开页面 When 切页再返回 Then 保留现场、暂停隐藏脚本，并按容量与版本淘汰。 */
async function verifyPageCache(window: BrowserWindow): Promise<void> {
  await window.webContents.executeJavaScript(`(() => {
    // 隔离夹具组合可操作几何、图片、长页面和定时器，不读取真实业务数据。
    const smoke=window.__interactionSmoke,page=smoke.state.snapshot.document.pages[0];
    page.html=smoke.geometryHtml.replace('</body>', '<input placeholder="缓存输入"><img src="prototype-asset:asset-good"><div style="height:1800px">缓存长页面</div><script>window.__ticks=0;window.__rafs=0;window.__timeout=0;setInterval(()=>window.__ticks++,30);function tick(){window.__rafs++;requestAnimationFrame(tick)}requestAnimationFrame(tick);</'+'script></body>');
    smoke.state.snapshot.document.pages.push({id:'third',name:'第三页',groupId:'group-a',html:'<h1>第三页</h1>'},{id:'fourth',name:'第四页',groupId:'group-a',html:'<h1>第四页</h1>'});
    smoke.state.snapshot.document.revision+=1;smoke.change('workspace-a','proto-a');
  })()`)
  await waitForPreviewText(window, '缓存长页面')
  await click(window, '体验')
  await manipulateGeometry(window, '', 'drag')
  /** 几何投影、iframe 身份与资源次数共同证明回访复用真实文档。 */
  const matrix = await geometryMatrix(window, '')
  const original = (await activeFrame(window))!
  const assetReads = await window.webContents.executeJavaScript<number>(`window.__interactionSmoke.state.calls.filter(call=>call==='assetContent:session-a').length`)
  await original.executeJavaScript(`window.__cacheBoot='first';document.querySelector('input').value='切页保留';window.scrollTo(0,220)`)
  await clickSelector(window, '[aria-label="原始尺寸预览"]')
  await window.webContents.executeJavaScript(`window.__cachedHome=document.querySelector('.id-cached-page[data-active="true"] iframe');document.querySelector('.id-cached-page[data-active="true"] .id-preview-space').scrollTop=80;window.__cachedScroll=document.querySelector('.id-cached-page[data-active="true"] .id-preview-space').scrollTop`)
  await click(window, '页面'); await clickPage(window, '今日习惯')
  await waitForPreviewText(window, '今日习惯')
  await window.webContents.executeJavaScript(`new Promise(resolve=>setTimeout(resolve,100))`)
  /** 隐藏 iframe 仍存在，但重复计时器和 RAF 必须停止消耗。 */
  const paused = await original.executeJavaScript<number[]>('[window.__ticks,window.__rafs]')
  await original.executeJavaScript(`setTimeout(()=>window.__timeout++,60)`)
  await window.webContents.executeJavaScript(`new Promise(resolve=>setTimeout(resolve,180))`)
  assert.deepEqual(await original.executeJavaScript('[window.__ticks,window.__rafs]'), paused, '隐藏页仍执行计时器或 RAF')
  assert.equal(await original.executeJavaScript('window.__timeout'), 0, '隐藏页新建的 timeout 未暂停')
  /** 使用合法令牌和真实隐藏来源伪造导航，父端仍必须检查活动页身份。 */
  const config = await window.webContents.executeJavaScript<{ token: string; pageId: string; revision: number }>(`JSON.parse(window.__cachedHome.srcdoc.match(/const config=(.*?);document.currentScript/)[1])`)
  await original.executeJavaScript(`parent.postMessage(${JSON.stringify({ ...config, type: 'prototype-navigate', targetPageId: 'third' })},'*')`)
  await window.webContents.executeJavaScript(`new Promise(resolve=>setTimeout(resolve,100))`)
  await waitForPreviewText(window, '今日习惯')
  await click(window, '选择修改')
  await original.executeJavaScript(`parent.postMessage(${JSON.stringify({ ...config, type: 'prototype-select', elementId: 'scene' })},'*')`)
  await window.webContents.executeJavaScript(`new Promise(resolve=>setTimeout(resolve,100))`)
  assert.equal(await window.webContents.executeJavaScript(`Boolean(document.querySelector('.id-selection'))`), false, '隐藏页伪消息修改了当前选区')
  await click(window, '体验')
  await click(window, '页面'); await clickPage(window, '欢迎')
  await waitForPreviewText(window, '缓存长页面')
  assert.equal(await window.webContents.executeJavaScript(`window.__cachedHome===document.querySelector('.id-cached-page[data-active="true"] iframe')`), true, '回访页面重新创建了 iframe，交互现场丢失')
  assert.equal(await original.executeJavaScript(`window.__cacheBoot==='first' && document.querySelector('input').value==='切页保留' && window.scrollY===220`), true, '回访未保留 JS、输入或 iframe 滚动位置')
  assert.equal(await geometryMatrix(window, ''), matrix, '回访丢失三维投影')
  assert.equal(await window.webContents.executeJavaScript(`document.querySelector('.id-cached-page[data-active="true"] .id-preview-space').scrollTop===window.__cachedScroll`), true, '回访丢失外层画板滚动位置')
  assert.equal(await window.webContents.executeJavaScript(`window.__interactionSmoke.state.calls.filter(call=>call==='assetContent:session-a').length`), assetReads, '回访重复读取图片')
  await window.webContents.executeJavaScript(`new Promise(resolve=>setTimeout(resolve,180))`)
  assert.equal(await original.executeJavaScript(`window.__ticks>${paused[0]} && window.__rafs>${paused[1]} && window.__timeout===1`), true, '回访未恢复定时器或恢复了多次 timeout')
  /** 整个模块隐藏也应暂停；恢复时使用同一 iframe 和页面现场。 */
  await window.webContents.executeJavaScript(`window.__interactionSmoke.switchPaneActive(false);new Promise(resolve=>setTimeout(resolve,100))`)
  const panePaused = await original.executeJavaScript<number[]>('[window.__ticks,window.__rafs]')
  await window.webContents.executeJavaScript(`new Promise(resolve=>setTimeout(resolve,150))`)
  assert.deepEqual(await original.executeJavaScript('[window.__ticks,window.__rafs]'), panePaused, '模块隐藏后脚本未暂停')
  await window.webContents.executeJavaScript(`window.__interactionSmoke.switchPaneActive(true)`)
  /** 重置仅重建当前页，已打开的其他业务页保持原 iframe。 */
  await window.webContents.executeJavaScript(`window.__cachedDetail=document.querySelector('iframe[name="prototype-state:detail:"]')`)
  await clickSelector(window, '[aria-label="重新体验"]')
  await waitForPreviewText(window, '缓存长页面')
  assert.equal(await window.webContents.executeJavaScript(`window.__cachedHome!==document.querySelector('.id-cached-page[data-active="true"] iframe') && window.__cachedDetail.isConnected`), true, '重新体验没有局部重建或误清理其他页')
  await click(window, '页面'); await clickPage(window, '今日习惯')
  await waitForPreviewText(window, '今日习惯')
  assert.equal(await window.webContents.executeJavaScript(`window.__cachedDetail===document.querySelector('.id-cached-page[data-active="true"] iframe')`), true, '重新体验影响其他页面')
  /** 活动页可信导航仍生效；随后按 LRU 打开两页淘汰最久未访问的详情页。 */
  await clickStateElement(window, '', '[data-prototype-page="home"]')
  await waitForPreviewText(window, '缓存长页面')
  await click(window, '页面'); await clickPage(window, '第三页'); await waitForPreviewText(window, '第三页')
  await click(window, '页面'); await clickPage(window, '第四页'); await waitForPreviewText(window, '第四页')
  assert.equal(await window.webContents.executeJavaScript(`document.querySelectorAll('.id-cached-page').length<=3 && !window.__cachedDetail.isConnected`), true, '页面缓存没有按最近三页淘汰')
  await click(window, '页面'); await clickPage(window, '今日习惯'); await waitForPreviewText(window, '今日习惯')
  assert.equal(await window.webContents.executeJavaScript(`window.__cachedDetail!==document.querySelector('.id-cached-page[data-active="true"] iframe')`), true, '淘汰后未重新初始化')
  /** 正式版本变化清除全部旧正文，避免展示过期交互现场。 */
  await window.webContents.executeJavaScript(`window.__beforeVersion=[...document.querySelectorAll('.id-cached-page iframe')];window.__interactionSmoke.state.snapshot.document.revision+=1;window.__interactionSmoke.change('workspace-a','proto-a')`)
  await waitFor(window, `window.__beforeVersion.every(frame=>!frame.isConnected)`, '版本更新未清理旧缓存')
  await waitForPreviewText(window, '今日习惯')
  /** 候选和项目有独立身份，不复用正式版或上一个项目的沙箱。 */
  await window.webContents.executeJavaScript(`window.__beforeCandidate=[...document.querySelectorAll('.id-cached-page iframe')]`)
  await previewHistoryCandidate(window)
  await waitFor(window, `window.__beforeCandidate.every(frame=>!frame.isConnected)`, '候选预览复用了正式版缓存')
  await returnFromHistory(window)
  await waitForPreviewText(window, '今日习惯')
  await window.webContents.executeJavaScript(`window.__beforeProject=[...document.querySelectorAll('.id-cached-page iframe')];window.__interactionSmoke.switchHost()`)
  await waitFor(window, `window.__beforeProject.every(frame=>!frame.isConnected) && window.__interactionSmoke.state.calls.includes('load:session-b')`, '切项目没有清理旧缓存')
  await waitForPreviewText(window, '拾光')
  console.log('[Interaction Design UI smoke] 切页现场、资源复用、隐藏暂停与消息隔离、局部重置、LRU 和版本/候选/项目失效通过')
}

/** Given 图片仍在读取 When A→B→A Then 复用在途请求且跨页始终至多四路并发。 */
async function verifyInFlightPageCache(window: BrowserWindow): Promise<void> {
  await waitForPreviewImages(window)
  console.log('[Interaction Design UI smoke] 在途资源夹具开始')
  await window.webContents.executeJavaScript(`(() => {
    // 六张延迟图片保证首轮占满四路并留有排队任务。
    const smoke=window.__interactionSmoke,ids=Array.from({length:6},(_,index)=>'cache-slow-'+index);
    smoke.state.maxAssetsInFlight=0;
    for(const id of ids){smoke.delayedAssets.add(id);smoke.state.snapshot.assets.push({id,name:id,hash:'e'.repeat(64),mime:'image/png',byteSize:68,createdAt:1});}
    smoke.state.snapshot.document.pages[0].html='<h1>在途资源页</h1>'+ids.map(id=>'<img alt="'+id+'" src="prototype-asset:'+id+'">').join('');
    smoke.state.snapshot.document.revision+=1;smoke.change('workspace-a','proto-a');
  })()`)
  await waitFor(window, `window.__interactionSmoke.state.assetsInFlight===4`, '资源队列没有启动四路读取')
  console.log('[Interaction Design UI smoke] 四路在途资源已挂起')
  await click(window, '页面'); await clickPage(window, '今日习惯'); await waitForPreviewText(window, '今日习惯')
  await click(window, '页面'); await clickPage(window, '欢迎')
  await waitFor(window, `document.querySelector('.id-cached-page[data-active="true"] [role="status"]')`, '返回在途页未显示加载状态')
  console.log('[Interaction Design UI smoke] 在途资源页切回完成')
  await window.webContents.executeJavaScript(`new Promise(resolve=>setTimeout(resolve,120))`)
  assert.equal(await window.webContents.executeJavaScript(`Object.entries(window.__interactionSmoke.state.assetReadCounts).filter(([id])=>id.startsWith('cache-slow-')).every(([,count])=>count===1) && window.__interactionSmoke.state.maxAssetsInFlight<=4`), true, '快速切页重复读取在途资源或突破四路并发')
  await window.webContents.executeJavaScript(`Array.from({length:6},(_,index)=>window.__interactionSmoke.releaseAsset('cache-slow-'+index))`)
  await waitForPreviewText(window, '在途资源页')
  assert.equal((await waitForPreviewImages(window)).length, 6, '回访资源结果丢失或未完成解码')
  assert.equal(await window.webContents.executeJavaScript(`Array.from({length:6},(_,index)=>window.__interactionSmoke.state.assetReadCounts['cache-slow-'+index]).every(count=>count===1) && window.__interactionSmoke.state.maxAssetsInFlight<=4`), true, '排队资源没有恰好读取一次')
  console.log('[Interaction Design UI smoke] 快速切页在途资源复用与四路并发上限通过')
}

/** 通过真实 Radix 菜单选择机型，并等待尺寸完成更新。 */
async function selectPreviewDevice(window: BrowserWindow, device: string): Promise<void> {
  await clickSelector(window, '[aria-label="选择预览设备"]')
  await clickSelector(window, `[data-preview-device="${device}"]`)
  await waitFor(window, `document.querySelector('.id-cached-page[data-active="true"] .id-preview-model')?.dataset.device === ${JSON.stringify(device)} && !document.querySelector('[role="menu"]')`, '机型选择没有生效')
  await settleUi(window)
}

/** Given 全部设备 When 连续切换 Then 视口/媒体查询生效、保留脚本与表单现场，并完整显示外壳。 */
async function verifyDeviceMenu(window: BrowserWindow): Promise<void> {
  await window.webContents.executeJavaScript(`window.__deviceFrame=document.querySelector('.id-cached-page[data-active="true"] iframe');window.__deviceSource=window.__deviceFrame.srcdoc`)
  /** 保存浏览上下文内的输入与脚本标记，防止仅验证 DOM 身份而漏掉 iframe 导航。 */
  const frame = (await activeFrame(window))!
  await frame.executeJavaScript(`(() => {
    window.__deviceBoot='original';
    const input=document.createElement('input');input.id='device-state-input';input.value='保留设备切换现场';document.body.append(input);
    const style=document.createElement('style');style.textContent='body{--device-wide:no}@media(min-width:600px){body{--device-wide:yes}}';document.head.append(style);
  })()`)
  await clickSelector(window, '[aria-label="选择预览设备"]')
  assert.equal(await window.webContents.executeJavaScript(`document.querySelectorAll('[data-preview-device]').length`), 13, '设备菜单没有覆盖全部库模型与浏览器 Web')
  await settleUi(window)
  await writeFile('/private/tmp/interaction-design-device-menu.png', (await window.webContents.capturePage()).toPNG())
  await escape(window)
  for (const device of PROTOTYPE_DEVICES) {
    await selectPreviewDevice(window, device.id)
    await verifyPreviewFrameBounds(window, true)
    assert.equal(await window.webContents.executeJavaScript(`window.__deviceFrame===document.querySelector('.id-cached-page[data-active="true"] iframe') && window.__deviceSource===window.__deviceFrame.srcdoc && document.querySelectorAll('.id-cached-page[data-active="true"] iframe').length===1`), true, `${device.id} 重建或复制了正文`)
    assert.equal(await window.webContents.executeJavaScript(`document.querySelector('[aria-label="当前预览设备"]').textContent`), `${device.id} · ${device.width} × ${device.height}`, '设备页脚与视口不一致')
    /** 在真实子 frame 内取宽高与媒体查询结果，确保内容并非只有外观缩放。 */
    const state = await frame.executeJavaScript(`({width:innerWidth,height:innerHeight,wide:getComputedStyle(document.body).getPropertyValue('--device-wide').trim(),boot:window.__deviceBoot,input:document.querySelector('#device-state-input')?.value})`)
    assert.deepEqual(state, { width: device.width, height: device.height, wide: device.width >= 600 ? 'yes' : 'no', boot: 'original', input: '保留设备切换现场' }, `${device.id} 视口或交互状态不正确`)
    if (device.id === '浏览器 Web') {
      assert.equal(await window.webContents.executeJavaScript(`(() => {
        const model=document.querySelector('.id-cached-page[data-active="true"] .id-preview-model');
        const toolbar=model.querySelector('.id-browser-toolbar')?.getBoundingClientRect();
        const screen=model.querySelector('.id-preview-screen').getBoundingClientRect();
        return !model.querySelector('.mockframe') && toolbar && Math.abs(toolbar.bottom-screen.top)<1 && toolbar.width>=screen.width-1;
      })()`), true, '浏览器顶栏挤占网页视口或仍显示硬件外壳')
      await clickSelector(window, '[aria-label="原始尺寸预览"]')
      await verifyPreviewFrameBounds(window)
      assert.equal(await window.webContents.executeJavaScript(`document.querySelector('.id-cached-page[data-active="true"] iframe').getBoundingClientRect().width`), 1280, '浏览器 100% 缩放没有保持完整网页视口')
      await clickSelector(window, '[aria-label="适应预览区域"]')
      await settleUi(window)
      await writeFile('/private/tmp/interaction-design-browser-web.png', (await window.webContents.capturePage()).toPNG())
    }
    if (['iPhone Duo', 'MacBook Pro', 'iPad Pro'].includes(device.id)) await writeFile(`/private/tmp/interaction-design-device-${device.id.replaceAll(' ', '-').toLowerCase()}.png`, (await window.webContents.capturePage()).toPNG())
  }
  window.setSize(390, 850)
  await settleUi(window)
  await verifyPreviewFrameBounds(window, true)
  await clickSelector(window, '[aria-label="选择预览设备"]')
  assert.equal(await window.webContents.executeJavaScript(`(() => {const menu=document.querySelector('[role="menu"]');const rect=menu.getBoundingClientRect();return rect.left>=0 && rect.right<=innerWidth && rect.bottom<=innerHeight})()`), true, '窄屏设备菜单超出窗口')
  await escape(window)
  await selectPreviewDevice(window, 'iPhone 17')
  await verifyPreviewFrameBounds(window, true)
  window.setSize(1180, 850)
  await settleUi(window)
  await clickSelector(window, '[aria-label="选择预览设备"]')
  /** Chromium 协议明确指定 DOM 键值，避免 Electron 把 ArrowDown 当作无效加速键。 */
  window.webContents.debugger.attach('1.3')
  try {
    for (const [key, code] of [['Home', 36], ['ArrowDown', 40], ['Enter', 13]] as const) {
      await window.webContents.debugger.sendCommand('Input.dispatchKeyEvent', { type: 'keyDown', key, code: key, windowsVirtualKeyCode: code })
      await window.webContents.debugger.sendCommand('Input.dispatchKeyEvent', { type: 'keyUp', key, code: key, windowsVirtualKeyCode: code })
      await settleUi(window)
    }
  } finally { window.webContents.debugger.detach() }
  await waitFor(window, `document.querySelector('[aria-label="当前预览设备"]')?.textContent.includes('iPhone 18 Pro') && !document.querySelector('[role="menu"]')`, '键盘选择设备未生效')
  await selectPreviewDevice(window, 'iPhone 17')
  console.log('[Interaction Design UI smoke] 全部 12 种模型与浏览器 Web、视口媒体查询、脚本与表单现场、外壳几何及窄屏菜单通过')
}

/** Given 宿主分隔线与慢资源 When 专注、缩放与独立加载 Then 画面可操作且不重复初始化。 */
async function verifyPreviewUsability(window: BrowserWindow): Promise<void> {
  await window.webContents.executeJavaScript(`window.__stableFrame=document.querySelector('.id-cached-page[data-active="true"] iframe');window.__stableSource=window.__stableFrame.srcdoc`)
  await clickSelector(window, '[aria-label="专注预览"]')
  assert.equal(await window.webContents.executeJavaScript(`getComputedStyle(document.querySelector('.agent-right-panel-host')).zIndex`), '90', '专注预览仍被宿主分隔线覆盖')
  assert.equal(await window.webContents.executeJavaScript(`getComputedStyle(document.querySelector('.agent-side-panel')).zIndex`), '30', '专注预览仍被右侧边界覆盖')
  assert.equal(await window.webContents.executeJavaScript(`document.querySelector('.id-focus').getBoundingClientRect().bottom <= innerHeight`), true, '专注预览底部溢出窗口')
  await clickSelector(window, '[aria-label="更多原型操作"]')
  await waitFor(window, `document.querySelector('[role="menu"]')`, '专注预览菜单没有打开')
  assert.equal(await window.webContents.executeJavaScript(`Number(getComputedStyle(document.querySelector('[role="menu"]').parentElement).zIndex)>Number(getComputedStyle(document.querySelector('.agent-right-panel-host')).zIndex)`), true, '菜单虽然可穿透点击，但被专注面板遮住')
  await window.webContents.executeJavaScript(`Promise.all(document.getAnimations().filter(animation=>Number.isFinite(animation.effect?.getComputedTiming().endTime)).map(animation=>animation.finished.catch(()=>undefined)))`)
  await writeFile('/private/tmp/interaction-design-focus-menu.png', (await window.webContents.capturePage()).toPNG())
  await click(window, '导入项目 HTML')
  await waitFor(window, `document.querySelector('[role="dialog"]')`, '专注预览菜单被宿主层级遮挡')
  await click(window, '取消')
  await waitFor(window, `!document.querySelector('[role="dialog"]')`, '专注预览表单没有关闭')
  await waitFor(window, `(() => { const button = document.querySelector('.id-cached-page[data-active="true"] [aria-label="放大预览"]'); const controls = button?.closest('.id-zoom-controls'); const viewport = button?.closest('.id-cached-page')?.querySelector('.id-preview-viewport'); return Boolean(button && controls && viewport && controls.getBoundingClientRect().top >= viewport.getBoundingClientRect().bottom - 1) })()`, '缺少预览区下方缩放入口')
  /** 固定设计视口下的实际几何尺寸，缩放不修改 srcDoc。 */
  const before = await window.webContents.executeJavaScript(`document.querySelector('.id-cached-page[data-active="true"] iframe').getBoundingClientRect().width`)
  await clickSelector(window, '[aria-label="放大预览"]')
  await waitFor(window, `document.querySelector('.id-cached-page[data-active="true"] iframe').getBoundingClientRect().width > ${before}`, '放大按钮未改变画面尺寸')
  assert.equal(await window.webContents.executeJavaScript(`window.__stableFrame===document.querySelector('.id-cached-page[data-active="true"] iframe') && window.__stableSource===window.__stableFrame.srcdoc && window.__stableFrame.style.width==='402px'`), true, '缩放重载正文或修改了设计视口')
  await clickSelector(window, '[aria-label="缩小预览"]')
  await clickSelector(window, '[aria-label="适应预览区域"]')
  await clickSelector(window, '[aria-label="原始尺寸预览"]')
  await waitFor(window, `Math.abs(document.querySelector('.id-cached-page[data-active="true"] iframe').getBoundingClientRect().width-402)<1`, '原始尺寸不是 100%')
  /** 上下限通过真实组件的点击事件验证，放大后仍保留原始设计宽度。 */
  await window.webContents.executeJavaScript(`(async()=>{for(let i=0;i<25;i++){document.querySelector('.id-cached-page[data-active="true"] [aria-label="放大预览"]').click();await new Promise(requestAnimationFrame)}})()`)
  assert.equal(await window.webContents.executeJavaScript(`document.querySelector('.id-cached-page[data-active="true"] [aria-label="放大预览"]').disabled && Math.abs(document.querySelector('.id-cached-page[data-active="true"] iframe').getBoundingClientRect().width-1206)<1`), true, '最大缩放未限制在300%或尺寸不正确')
  await verifyPreviewFrameBounds(window)
  await window.webContents.executeJavaScript(`(async()=>{for(let i=0;i<35;i++){document.querySelector('.id-cached-page[data-active="true"] [aria-label="缩小预览"]').click();await new Promise(requestAnimationFrame)}})()`)
  assert.equal(await window.webContents.executeJavaScript(`document.querySelector('.id-cached-page[data-active="true"] [aria-label="缩小预览"]').disabled && Math.abs(document.querySelector('.id-cached-page[data-active="true"] iframe').getBoundingClientRect().width-40.2)<1`), true, '最小缩放未限制在10%或尺寸不正确')
  await verifyPreviewFrameBounds(window)
  await selectPreviewDevice(window, 'MacBook Pro')
  assert.equal(await window.webContents.executeJavaScript(`document.querySelectorAll('.id-cached-page[data-active="true"] .mockframe.iphone17').length`), 0, '桌面预览错误保留移动端 iPhone 机身')
  assert.equal(await window.webContents.executeJavaScript(`document.querySelectorAll('.id-cached-page[data-active="true"] .mockframe.macbook-pro').length`), 1, '桌面预览缺少稳定外壳容器')
  assert.equal(await window.webContents.executeJavaScript(`document.querySelectorAll('.id-cached-page[data-active="true"] .id-device-frame').length`), 1, '桌面预览缺少普通画板')
  await verifyPreviewFrameBounds(window)
  assert.equal(await window.webContents.executeJavaScript(`(() => { const frame=document.querySelector('.id-cached-page[data-active="true"] .id-preview-mockframe');return frame.classList.contains('macbook-pro') && !frame.querySelector('.dynamic-island') })()`), true, '桌面画板残留手机听筒或动态岛')
  await clickSelector(window, '[aria-label="原始尺寸预览"]')
  await waitFor(window, `Math.abs(document.querySelector('.id-cached-page[data-active="true"] iframe').getBoundingClientRect().width-960)<1 && document.querySelector('.id-cached-page[data-active="true"] .id-preview-space').scrollWidth > document.querySelector('.id-cached-page[data-active="true"] .id-preview-space').clientWidth`, '放大的桌面预览无法横向滚动')
  await selectPreviewDevice(window, 'iPhone 17')
  await clickSelector(window, '[aria-label="适应预览区域"]')
  await verifyPreviewFrameBounds(window, true)
  await writeFile('/private/tmp/interaction-design-focus-zoom.png', (await window.webContents.capturePage()).toPNG())
  await clickSelector(window, '[aria-label="退出专注"]')
  assert.equal(await window.webContents.executeJavaScript(`getComputedStyle(document.querySelector('.agent-right-panel-host')).zIndex`), '60', '退出专注后宿主层级没有恢复')
  assert.equal(await window.webContents.executeJavaScript(`window.__stableFrame===document.querySelector('.id-cached-page[data-active="true"] iframe') && window.__stableSource===window.__stableFrame.srcdoc`), true, '专注或设备切换重建了 iframe')
  /** 先缓存另一页，资源重试只能重建当前页，不得破坏其他页面。 */
  await click(window, '页面'); await clickPage(window, '今日习惯'); await waitForPreviewText(window, '今日习惯')
  await window.webContents.executeJavaScript(`window.__retryOther=document.querySelector('.id-cached-page[data-active="true"] iframe')`)
  await click(window, '页面'); await clickPage(window, '欢迎'); await waitForPreviewText(window, '拾光')
  /** Given 读取失败已经恢复 When 显式重试 Then 占位图可更新且加载正常结束。 */
  await window.webContents.executeJavaScript(`window.__interactionSmoke.recoveredAssets.add('asset-broken');window.__interactionSmoke.change('workspace-a','proto-a')`)
  await waitFor(window, `document.querySelector('.id-error')`, '重新读取摘要后未恢复图片失败提示')
  await click(window, '重新加载')
  await waitForPreviewImages(window)
  await waitFor(window, `!document.querySelector('.id-error') && !document.querySelector('.id-cached-page[data-active="true"] .id-preview-loading')`, '重试没有恢复资源或结束加载')
  assert.equal((await waitForPreviewImages(window)).find(image=>image.alt==='损坏图片')?.src.startsWith('data:image/png;base64,'), true, '重试后仍使用失败占位图')
  assert.equal(await window.webContents.executeJavaScript(`window.__retryOther.isConnected`), true, '图片重试清理了其他页缓存')
  /** 同版本刷新摘要只复用本页资源，不重复读取已完成的大图。 */
  const assetReadCount = await window.webContents.executeJavaScript(`window.__interactionSmoke.state.calls.filter(call=>call==='assetContent:session-a').length`)
  await window.webContents.executeJavaScript(`window.__interactionSmoke.change('workspace-a','proto-a')`)
  await waitFor(window, `document.querySelector('.id-title p').textContent.includes('已保存')`, '同版本重载未完成')
  assert.equal(await window.webContents.executeJavaScript(`window.__interactionSmoke.state.calls.filter(call=>call==='assetContent:session-a').length`), assetReadCount, '同版本刷新重复读取已缓存资源')
  /** 两个画板的图片独立延迟，后一个完成时不能重载前一个的交互现场。 */
  await window.webContents.executeJavaScript(`(() => {
    const smoke=window.__interactionSmoke,page=smoke.state.snapshot.document.pages[0];
    smoke.delayedAssets.add('slow-default');smoke.delayedAssets.add('slow-state');
    smoke.state.snapshot.assets.push(...['slow-default','slow-state'].map(id=>({id,name:id,hash:'c'.repeat(64),mime:'image/png',byteSize:68,createdAt:1})));
    page.html='<h1>独立加载</h1><img src="prototype-asset:slow-default"><input placeholder="保留输入">';
    page.states=[{id:'slow',name:'慢状态',html:'<h1>慢状态</h1><img src="prototype-asset:slow-state">'}];
    smoke.state.snapshot.document.revision+=1;smoke.change('workspace-a','proto-a');
  })()`)
  await waitFor(window, `document.querySelectorAll('.id-cached-page[data-active="true"] .id-device-frame [role="status"]').length===2`, '每个手机画面未显示独立转圈加载')
  await selectPreviewDevice(window, 'MacBook Pro')
  assert.equal(await window.webContents.executeJavaScript(`document.querySelectorAll('.id-cached-page[data-active="true"] .id-device-frame [role="status"]').length`), 2, '桌面画板没有保留加载态')
  await selectPreviewDevice(window, 'iPhone 17')
  await writeFile('/private/tmp/interaction-design-loading.png', (await window.webContents.capturePage()).toPNG())
  await window.webContents.executeJavaScript(`window.__interactionSmoke.releaseAsset('slow-default')`)
  await waitForPreviewText(window, '独立加载')
  await waitFor(window, `!document.querySelector('.id-cached-page[data-active="true"] [data-state-id=""] [role="status"]') && document.querySelector('.id-cached-page[data-active="true"] [data-state-id="slow"] [role="status"]')`, '一个画面加载完成却错误清除了另一个画面的加载态')
  /** 直接写入测试输入作为页面现场，后续资源回流不得清空。 */
  const defaultFrame = (await activeFrame(window))!
  await defaultFrame.executeJavaScript(`document.querySelector('input').value='保留现场';window.__bootId='first-document'`)
  await window.webContents.executeJavaScript(`window.__interactionSmoke.releaseAsset('slow-state')`)
  await waitFor(window, `document.querySelectorAll('.id-cached-page[data-active="true"] .id-state-board iframe').length===2 && !document.querySelector('.id-cached-page[data-active="true"] .id-device-frame [role="status"]')`, '资源完成后转圈没有结束')
  assert.equal(await defaultFrame.executeJavaScript(`document.querySelector('input').value==='保留现场' && window.__bootId==='first-document'`), true, '附加状态的资源完成导致默认状态重新初始化')
  /** Given 当前页读取中 When 切到无图片页 Then 旧失败不能污染新页。 */
  await window.webContents.executeJavaScript(`(() => { const smoke=window.__interactionSmoke;smoke.recoveredAssets.delete('asset-broken');smoke.delayedAssets.add('asset-broken');smoke.state.snapshot.document.pages[0].html='<h1>旧页面</h1><img src="prototype-asset:asset-broken">';smoke.state.snapshot.document.revision+=1;smoke.change('workspace-a','proto-a') })()`)
  await waitFor(window, `document.querySelector('.id-cached-page[data-active="true"] [data-state-id=""] [role="status"]')`, '迟到回归未开始加载')
  await click(window, '页面'); await clickPage(window, '今日习惯')
  await waitForPreviewText(window, '今日习惯')
  await window.webContents.executeJavaScript(`window.__interactionSmoke.releaseAsset('asset-broken')`)
  await window.webContents.executeJavaScript(`new Promise(resolve=>setTimeout(resolve,100))`)
  assert.equal(await window.webContents.executeJavaScript(`Boolean(document.querySelector('.id-error'))`), false, '旧页图片失败污染了当前页')
  /** Given 当前页资源超过预算 When 预览 Then 不分配大图且不永久转圈。 */
  const readsBeforeBudget = await window.webContents.executeJavaScript(`window.__interactionSmoke.state.calls.filter(call=>call==='assetContent:session-a').length`)
  await window.webContents.executeJavaScript(`(() => {const smoke=window.__interactionSmoke;smoke.state.snapshot.assets.push({id:'too-large',name:'超限图片',hash:'d'.repeat(64),mime:'image/png',byteSize:65*1024*1024,createdAt:1});smoke.state.snapshot.document.pages[1].html='<h1>预算受限页面</h1><img src="prototype-asset:too-large">';smoke.state.snapshot.document.revision+=1;smoke.change('workspace-a','proto-a')})()`)
  await waitForPreviewText(window, '预算受限页面')
  await waitFor(window, `document.querySelector('.id-error')?.textContent.includes('64 MiB') && !document.querySelector('.id-cached-page[data-active="true"] .id-preview-loading')`, '资源超限后没有明确反馈或仍永久转圈')
  assert.equal(await window.webContents.executeJavaScript(`window.__interactionSmoke.state.calls.filter(call=>call==='assetContent:session-a').length`), readsBeforeBudget, '超限资源仍开始了读取')
  console.log('[Interaction Design UI smoke] 专注层级、手机/桌面缩放、逐画板加载、初始化保留与迟到隔离通过')
}

/** 打开历史窗口；候选操作统一由此入口发现。 */
async function openHistory(window: BrowserWindow): Promise<void> {
  if (await window.webContents.executeJavaScript(`Boolean(document.querySelector('.id-history-dialog[data-state="open"]'))`)) return
  // Radix 关闭动画会暂留旧 DOM，先等卸载，避免将退出中的弹窗误判为已打开。
  await waitFor(window, `!document.querySelector('.id-history-dialog')`, '上一历史窗口退出动画未完成')
  await settleUi(window)
  await waitFor(window, `(()=>{const button=document.querySelector('[aria-label="查看版本与候选"]');if(!button)return false;const rect=button.getBoundingClientRect();return button.contains(document.elementFromPoint(rect.left+rect.width/2,rect.top+rect.height/2))&&getComputedStyle(document.body).pointerEvents!=='none'})()`, '历史入口仍被退出遮罩遮挡')
  await clickSelector(window, '[aria-label="查看版本与候选"]')
  await waitFor(window, `document.querySelector('.id-history-dialog[data-state="open"] .id-history')`, '历史版本窗口没有打开')
}

/** 从历史记录预览候选，关闭弹窗后检查正文。 */
async function previewHistoryCandidate(window: BrowserWindow): Promise<void> {
  await openHistory(window)
  await click(window, '预览')
  await waitFor(window, `!document.querySelector('.id-history-dialog')`, '预览候选后历史未关闭')
}

/** 从历史窗口退出候选体验，回到正式版本。 */
async function returnFromHistory(window: BrowserWindow): Promise<void> {
  await openHistory(window)
  await click(window, '返回当前版本')
  await waitFor(window, `!document.querySelector('.id-history')`, '返回正式版本后历史未关闭')
}

/** Given 多种候选状态 When 查看、采纳、取消和删除 Then 入口统一且红点准确变化。 */
async function verifyHistoryRecords(window: BrowserWindow): Promise<void> {
  assert.equal(await window.webContents.executeJavaScript(`Boolean(document.querySelector('.id-candidates,.id-candidate-preview'))`), false, '候选卡片仍占用预览区域')
  await waitFor(window, `document.querySelector('.id-version-button .id-pending-dot') && document.querySelector('.id-actions .id-pending-dot')`, '未采纳候选未标红点')
  /** 模拟升级前未保存影响页的候选，按需解析一次后在当前上下文缓存。 */
  await window.webContents.executeJavaScript(`(() => {const smoke=window.__interactionSmoke;smoke.state.snapshot.candidates=smoke.state.snapshot.candidates.map(item=>{const next={...item};delete next.affectedPageIds;return next});smoke.change('workspace-a','proto-a')})()`)
  await click(window, '页面')
  await waitFor(window, `window.__interactionSmoke.state.calls.filter(call=>call.startsWith('getCandidateImpact:')).length===1`, '旧候选没有按需读取影响页')
  await waitFor(window, `document.querySelector('[aria-label="欢迎页面"] .id-pending-dot')`, '有候选变更的页面没有红点')
  assert.equal(await window.webContents.executeJavaScript(`Boolean(document.querySelector('[aria-label="今日习惯页面"] .id-pending-dot'))`), false, '未变更页面被误标红点')
  await escape(window)
  await waitFor(window, `!document.querySelector('.id-directory')`, '目录未关闭')
  await click(window, '页面')
  await waitFor(window, `document.querySelector('[aria-label="欢迎页面"] .id-pending-dot')`, '缓存影响页后红点丢失')
  await escape(window)
  await waitFor(window, `!document.querySelector('.id-directory')`, '重复打开的目录未关闭')
  await openHistory(window)
  await click(window, '关闭')
  await waitFor(window, `!document.querySelector('.id-history-dialog')`, '缓存检查历史未关闭')
  await openHistory(window)
  assert.equal(await window.webContents.executeJavaScript(`window.__interactionSmoke.state.calls.filter(call=>call.startsWith('getCandidateImpact:')).length`), 1, '重复打开目录或历史再次读取旧候选影响页')
  assert.equal(await window.webContents.executeJavaScript(`window.__interactionSmoke.state.calls.filter(call=>call.startsWith('getCandidate:')).length`), 0, '仅查看目录或历史不应读取候选正文')
  await waitFor(window, `document.querySelector('[data-history-key="candidate:candidate-a"] [data-history-status="pending"]')`, '候选未显示未采纳状态')
  assert.equal(await window.webContents.executeJavaScript(`Boolean(document.querySelector('[data-history-key="version:1"] [data-history-status="adopted"]'))`), true, '正式版本没有已采纳状态')
  await click(window, '对比')
  await waitFor(window, `document.querySelector('.id-compare-dialog[data-state="open"]') && document.querySelector('.id-compare-dialog')?.textContent.includes('页面版本对比')`, '历史记录缺少页面对比弹窗')
  assert.equal(await window.webContents.executeJavaScript(`window.__interactionSmoke.state.calls.some(call=>call.startsWith('comparePage:'))`), true, '页面对比没有调用只读领域命令')
  await clickSelector(window, '.id-compare-dialog button')
  await waitFor(window, `!document.querySelector('.id-compare-dialog')`, '页面对比弹窗未关闭')
  await openHistory(window)
  await click(window, '预览')
  await waitFor(window, `!document.querySelector('.id-history-dialog')`, '预览候选后历史未关闭')
  await waitForPreviewText(window, '开始你的第一天')
  assert.equal(await window.webContents.executeJavaScript(`!document.querySelector('.id-candidates,.id-candidate-preview') && document.querySelector('.id-title p').textContent.includes('候选预览')`), true, '预览候选时重新出现了占位卡片或丢失预览标识')
  await openHistory(window)
  await clickSelector(window, '[data-history-key="candidate:candidate-a"] [aria-label="取消候选"]')
  await waitFor(window, `document.querySelector('[data-history-key="candidate:candidate-a"] [data-history-status="cancelled"]')`, '取消候选后状态未更新')
  assert.equal(await window.webContents.executeJavaScript(`Boolean(document.querySelector('.id-version-button .id-pending-dot'))`), false, '取消全部候选后红点没有消失')
  await clickSelector(window, '[aria-label="筛选已取消"]')
  assert.equal(await window.webContents.executeJavaScript(`document.querySelectorAll('.id-history-entry').length`), 1, '状态筛选未过滤正式版本')
  await clickSelector(window, '[data-history-key="candidate:candidate-a"] [aria-label="删除记录"]')
  await waitFor(window, `document.querySelector('[role="alertdialog"]')`, '删除候选缺少确认')
  await click(window, '取消')
  assert.equal(await window.webContents.executeJavaScript(`window.__interactionSmoke.state.calls.some(call=>call.startsWith('deleteHistory:'))`), false, '取消确认仍提交了删除')
  await clickSelector(window, '[data-history-key="candidate:candidate-a"] [aria-label="删除记录"]')
  await clickSelector(window, '[role="alertdialog"] button.bg-destructive')
  await waitFor(window, `!document.querySelector('[role="alertdialog"]') && !document.querySelector('[data-history-key="candidate:candidate-a"]')`, '已取消记录未从历史删除')
  await click(window, '关闭')
  await waitForPreviewText(window, '拾光')
  /** 再注入一份未采纳结果，检查采纳合并及过期状态，不访问真实项目。 */
  await window.webContents.executeJavaScript(`(() => {const smoke=window.__interactionSmoke;smoke.state.snapshot.candidates=[structuredClone(smoke.candidate)];smoke.change('workspace-a','proto-a')})()`)
  await openHistory(window)
  await clickSelector(window, '[data-history-key="candidate:candidate-a"] [aria-label="采纳候选"]')
  await waitFor(window, `document.querySelector('[data-history-key="version:2"] [data-history-status="adopted"]')`, '采纳后没有正式版本记录')
  assert.equal(await window.webContents.executeJavaScript(`Boolean(document.querySelector('[data-history-key="candidate:candidate-a"]'))`), false, '已采纳候选与正式版本重复列出')
  assert.equal(await window.webContents.executeJavaScript(`Boolean(document.querySelector('[data-history-key="version:2"] [aria-label="删除 v2"]'))`), false, '当前正式版本不应可删除')
  assert.equal(await window.webContents.executeJavaScript(`Boolean(document.querySelector('.id-version-button .id-pending-dot'))`), false, '采纳后红点没有消失')
  await window.webContents.executeJavaScript(`(() => {const smoke=window.__interactionSmoke;smoke.state.snapshot.candidates.push({...structuredClone(smoke.candidate),id:'stale-candidate',status:'stale',summary:'过期候选'+ '需要检查的说明。'.repeat(70),affectedPageIds:['detail']});smoke.change('workspace-a','proto-a')})()`)
  await waitFor(window, `document.querySelector('[data-history-key="candidate:stale-candidate"]')`, '旧基线候选未刷新到历史')
  assert.equal(await window.webContents.executeJavaScript(`document.querySelector('[data-history-key="candidate:stale-candidate"] [aria-label="采纳候选"]').disabled`), true, '过期候选仍允许直接采纳')
  assert.equal(await window.webContents.executeJavaScript(`document.querySelector('[data-history-key="candidate:stale-candidate"] details').open`), false, '长说明没有默认收起')
  for (const width of [1180,390]) {
    window.setSize(width,850)
    await window.webContents.executeJavaScript(`new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))`)
    await settleUi(window)
    /** 保留实际几何证据，区分窗口重排和内容撑宽。 */
    const historyGeometry = await window.webContents.executeJavaScript(`(()=>{const dialog=document.querySelector('[role="dialog"]'),r=dialog.getBoundingClientRect();return {left:r.left,right:r.right,bottom:r.bottom,width:innerWidth,height:innerHeight,scroll:dialog.scrollWidth,client:dialog.clientWidth,classes:dialog.className,cssWidth:getComputedStyle(dialog).width}})()`)
    await writeFile(`/private/tmp/interaction-design-history-${width}.png`,(await window.webContents.capturePage()).toPNG())
    assert.ok(historyGeometry.left>=0&&historyGeometry.right<=historyGeometry.width+1&&historyGeometry.bottom<=historyGeometry.height+1&&historyGeometry.scroll<=historyGeometry.client+1, `历史窗口窄屏溢出 ${JSON.stringify(historyGeometry)}`)
  }
  await window.webContents.executeJavaScript(`document.documentElement.classList.add('dark')`)
  await settleUi(window)
  assert.equal(await window.webContents.executeJavaScript(`getComputedStyle(document.querySelector('.id-history-dialog')).backgroundColor`), 'rgb(41, 41, 41)', '历史窗口没有应用深色弹窗背景')
  assert.equal(await window.webContents.executeJavaScript(`getComputedStyle(document.querySelector('.id-history-dialog')).color`), 'rgb(250, 250, 250)', '历史窗口深色文字对比不足')
  await writeFile('/private/tmp/interaction-design-history-narrow.png',(await window.webContents.capturePage()).toPNG())
  window.setSize(1180,850)
  await window.webContents.executeJavaScript(`new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))`)
  await settleUi(window)
  await writeFile('/private/tmp/interaction-design-history.png',(await window.webContents.capturePage()).toPNG())
  /** 删除未采纳记录失败必须保留候选与红点，成功后再同步清理。 */
  await clickSelector(window, '[data-history-key="candidate:stale-candidate"] [aria-label="删除记录"]')
  await waitFor(window, `document.querySelector('[role="alertdialog"]')`, '未采纳记录缺少删除确认')
  await window.webContents.executeJavaScript(`window.__interactionSmoke.state.failNext=true`)
  await click(window, '删除记录')
  await waitFor(window, `document.querySelector('[role="alertdialog"] [role="alert"]')?.textContent.includes('fixture 读取失败')`, '删除记录失败没有明确反馈')
  assert.equal(await window.webContents.executeJavaScript(`window.__interactionSmoke.state.snapshot.candidates.some(item=>item.id==='stale-candidate') && Boolean(document.querySelector('[data-history-key="candidate:stale-candidate"]'))`), true, '删除失败丢失未采纳记录')
  assert.equal(await window.webContents.executeJavaScript(`Boolean(document.querySelector('.id-version-button .id-pending-dot'))`), true, '删除失败提前清除了红点')
  await click(window, '删除记录')
  await waitFor(window, `!document.querySelector('[role="alertdialog"]') && !document.querySelector('[data-history-key="candidate:stale-candidate"]')`, '未采纳记录重试删除失败')
  assert.equal(await window.webContents.executeJavaScript(`Boolean(document.querySelector('.id-version-button .id-pending-dot') || document.querySelector('.id-actions .id-pending-dot'))`), false, '删除最后未采纳记录后红点没有消失')
  await click(window, '关闭')
  await waitFor(window, `!document.querySelector('.id-history-dialog')`, '删除验证后历史未关闭')
  await click(window, '页面')
  assert.equal(await window.webContents.executeJavaScript(`Boolean(document.querySelector('.id-directory .id-pending-dot'))`), false, '删除最后未采纳记录后页面红点仍保留')
  await escape(window)
  console.log('[Interaction Design UI smoke] 历史状态、旧候选影响页缓存、候选迁移、筛选、红点、取消、删除失败重试、采纳合并与窄屏通过')
}

/** Escape 逐层关闭真实菜单。 */
async function escape(window: BrowserWindow): Promise<void> {
  window.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Escape' })
  window.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Escape' })
}
/** 校验缩放后机身与占位框对齐，防止宽高正确但从中心缩放造成半台手机被裁掉。 */
async function verifyPreviewFrameBounds(window: BrowserWindow, fitsViewport = false): Promise<void> {
  /** 收集真实布局几何；屏幕负责唯一裁剪，iframe 不应再自行缩放。 */
  const geometry = await window.webContents.executeJavaScript(`(() => {
    const frame=document.querySelector('.id-cached-page[data-active="true"] .id-preview-model');
    const slot=frame.parentElement;
    const screen=frame.querySelector('.id-preview-screen');
    const libraryScreen=frame.querySelector('.mockframe .screen') ?? screen;
    const libraryRect=libraryScreen.getBoundingClientRect();
    const iframe=screen.querySelector('iframe');
    const rect=frame.getBoundingClientRect(), bounds=slot.getBoundingClientRect(), display=screen.getBoundingClientRect(), content=iframe.getBoundingClientRect();
    const viewport=frame.closest('.id-preview-viewport').getBoundingClientRect();
    const clipMargin=parseFloat(getComputedStyle(slot).overflowClipMargin) || 0;
    return {
      origin:getComputedStyle(frame).transformOrigin,
      libraryDelta:Math.max(Math.abs(libraryRect.left-display.left),Math.abs(libraryRect.top-display.top),Math.abs(libraryRect.width-display.width),Math.abs(libraryRect.height-display.height)),
      radiusMatches:getComputedStyle(screen).borderRadius===getComputedStyle(libraryScreen).borderRadius,
      offsetX:rect.left-bounds.left, offsetY:rect.top-bounds.top,
      overflowX:rect.right-bounds.right, overflowY:rect.bottom-bounds.bottom,
      contentWidthDelta:Math.abs(display.width-content.width), contentHeightDelta:Math.abs(display.height-content.height),
      screenOverflow:getComputedStyle(screen).overflow, contentTransform:getComputedStyle(iframe).transform,
      contentRadius:getComputedStyle(iframe.parentElement).borderRadius,
      fitsViewport:rect.left>=viewport.left-1 && rect.right<=viewport.right+1 && rect.top>=viewport.top-1 && rect.bottom<=viewport.bottom+1,
      visibleSideButtons:[...frame.querySelectorAll('.action,.volume,.sleep')].filter(node=>getComputedStyle(node).display!=='none').every(node=>{const button=node.getBoundingClientRect();return button.left>=bounds.left-clipMargin-1 && button.right<=bounds.right+clipMargin+1}),
    };
  })()`)
  assert.ok(Math.abs(geometry.offsetX)<1 && Math.abs(geometry.offsetY)<1 && geometry.overflowX<=1 && geometry.overflowY<=1, `手机机身偏离占位框或被裁切：${JSON.stringify(geometry)}`)
  assert.ok(geometry.contentWidthDelta<1 && geometry.contentHeightDelta<1 && geometry.screenOverflow==='hidden' && geometry.contentTransform==='none', `屏幕与正文尺寸不一致或重复缩放：${JSON.stringify(geometry)}`)
  assert.ok(geometry.libraryDelta<1 && geometry.radiusMatches, `内容与库的屏幕裁剪不一致：${JSON.stringify(geometry)}`)
  assert.equal(geometry.contentRadius, '0px', '正文容器额外添加了圆角，覆盖手机屏幕裁剪')
  assert.equal(geometry.visibleSideButtons, true, '手机侧键被占位框裁切')
  if (fitsViewport) assert.equal(geometry.fitsViewport, true, `自动适应没有完整显示手机：${JSON.stringify(geometry)}`)
}

/** 隔离 userData，业务 API 全为内存 fixture。 */
async function runElectronSmoke(app: import('electron').App, BrowserWindowCtor: typeof import('electron').BrowserWindow): Promise<void> {
  const url = process.env.PROMA_INTERACTION_DESIGN_FIXTURE_URL
  if (!url) throw new Error('缺少 fixture URL')
  await app.whenReady()
  const window = new BrowserWindowCtor({ width: 1180, height: 850, show: true, webPreferences: { backgroundThrottling: false } })
  const errors: string[] = []
  window.webContents.on('console-message', event => { if (event.level === 'error') { errors.push(event.message); console.error('[Interaction Design UI smoke] 浏览器错误', event.message) } })
  try {
    await window.loadURL(url)
    console.log('[Interaction Design UI smoke] 初始页面载入')
    await waitFor(window, `document.querySelector('.id-cached-page[data-active="true"] iframe') && document.body.textContent.includes('已保存 v1')`, '工作区未就绪')
    await waitForPreviewText(window, '拾光')
    assert.equal(await window.webContents.executeJavaScript(`(() => { const top=document.querySelector('.id-stage-top')?.textContent ?? ''; return !document.querySelector('.id-stage-hint') && top.includes('独立沙箱') && top.includes('预览已运行') })()`), true, '预览辅助说明未合并到顶部')
    await waitFor(window, `document.querySelector('.id-cached-page[data-active="true"] .mockframe.iphone17')`, '移动预览缺少 iPhone 17 机身')
    assert.equal(await window.webContents.executeJavaScript(`document.querySelectorAll('.id-cached-page[data-active="true"] .mockframe.iphone17 .dynamic-island').length`), 1, 'iPhone 缺少 Dynamic Island')
    assert.equal(await window.webContents.executeJavaScript(`document.querySelectorAll('.id-cached-page[data-active="true"] .mockframe.iphone17 .screen').length`), 1, 'iPhone 缺少屏幕裁剪层')
    assert.equal(await window.webContents.executeJavaScript(`(() => { const shell=document.querySelector('.id-cached-page[data-active="true"] .mockframe.iphone17'); const frame=shell?.parentElement.querySelector('.id-device-frame'); return Boolean(shell && frame && shell.getBoundingClientRect().width > frame.getBoundingClientRect().width && shell.getBoundingClientRect().height > frame.getBoundingClientRect().height) })()`), true, 'iPhone 机身没有包住设备内容视口')
    await verifyPreviewFrameBounds(window, true)
    console.log('[Interaction Design UI smoke] 初始 iframe 就绪')
    window.show(); window.focus()
    /** 每个子进程只运行一个有界场景，避免跨项目 OOPIF 重载等待污染后续验证。 */
    const scenario = process.env.PROMA_INTERACTION_DESIGN_SMOKE_SCENARIO
    if (scenario === 'cache' || scenario === 'inflight') {
      if (scenario === 'cache') await verifyPageCache(window)
      else await verifyInFlightPageCache(window)
      assert.deepEqual(errors, [])
      return
    }
    await verifyDeviceMenu(window)
    if (scenario === 'devices') { assert.deepEqual(errors, []); return }
    await verifyHistoryRecords(window)
    await window.loadURL(url)
    await waitForPreviewText(window, '拾光')
    await verifyPreviewUsability(window)
    await window.loadURL(url)
    await waitForPreviewText(window, '拾光')
    await verifyGeometryInteraction(window)
    console.log('[Interaction Design UI smoke] 三维交互通过')
    await window.loadURL(url)
    await waitForPreviewText(window, '拾光')
    /** 首屏图片结果，覆盖成功读取与失败隔离。 */
    const previewImages = await waitForPreviewImages(window)
    assert.equal(previewImages.find(image => image.alt === '可用图片')?.src.startsWith('data:image/png;base64,'), true, '可用图片没有注入已授权数据 URL')
    assert.equal(previewImages.find(image => image.alt === '损坏图片')?.src.startsWith('data:image/'), true, '读取失败图片没有得到可渲染的占位图')
    console.log('[Interaction Design UI smoke] 图片与目录回归开始')
    for (const width of [1180, 820, 390]) {
      window.setSize(width, 850)
      await window.webContents.executeJavaScript(`new Promise(resolve=>setTimeout(resolve,180))`)
      await window.webContents.executeJavaScript(`window.__frame=document.querySelector('.id-cached-page[data-active="true"] iframe');window.__rect=JSON.stringify(window.__frame.getBoundingClientRect().toJSON());window.__src=window.__frame.srcdoc`)
      if (width === 1180) {
        await waitFor(window, `document.querySelector('[aria-label="生成开发交接包"]') && !document.querySelector('[aria-label="生成开发交接包"]').hasAttribute('disabled')`, '开发交接入口未启用')
        await clickSelector(window, '[aria-label="生成开发交接包"]')
        await waitFor(window, `window.__interactionSmoke.prompt()?.message.includes('prototype_read_version')`, '开发交接未引用到主会话')
        const handoffPrompt = await window.webContents.executeJavaScript(`window.__interactionSmoke.prompt().message`)
        assert.ok(handoffPrompt.includes('"revision": 1') && handoffPrompt.includes('"width": 390') && handoffPrompt.includes('next'), '开发交接未携带固定版本、视口和元素身份')
        await settleUi(window)
        await window.webContents.executeJavaScript(`window.__frame=document.querySelector('.id-cached-page[data-active="true"] iframe');window.__rect=JSON.stringify(window.__frame.getBoundingClientRect().toJSON());window.__src=window.__frame.srcdoc`)
      }
      await click(window, '页面'); await waitFor(window, `document.querySelector('.id-directory')`, '目录未展开')
      /** 分别记录正文身份与几何差异，避免把布局时序误报为 iframe 重建。 */
      const directoryGeometry = await window.webContents.executeJavaScript(`({sameFrame:window.__frame===document.querySelector('.id-cached-page[data-active="true"] iframe'),sameSource:window.__src===window.__frame.srcdoc,before:window.__rect,after:JSON.stringify(window.__frame.getBoundingClientRect().toJSON())})`)
      assert.ok(directoryGeometry.sameFrame && directoryGeometry.sameSource && directoryGeometry.before===directoryGeometry.after, `${width}px 目录挤压或重建预览 ${JSON.stringify(directoryGeometry)}`)
      assert.equal(await window.webContents.executeJavaScript(`getComputedStyle(document.querySelector('.id-directory-backdrop')).backgroundColor === 'rgba(0, 0, 0, 0)'`), true, '页面目录遮罩不应压暗预览画面')
      assert.equal(await window.webContents.executeJavaScript(`(() => { const tree = document.querySelector('.id-directory-content[role="tree"]'); const root = tree?.querySelector('.id-group[role="treeitem"][aria-level="1"]'); const nested = tree?.querySelector('.id-group-children .id-group[role="treeitem"][aria-level="2"]'); const page = tree?.querySelector('.id-page[role="treeitem"][aria-level="2"]'); return Boolean(tree && root && nested && page && page.querySelector('.id-page-meta')) })()`), true, '页面目录未呈现分组、页面和多级树形语义')
      assert.equal(await window.webContents.executeJavaScript(`document.querySelector('.id-title strong')?.textContent === '交互设计'`), true, '交互模块标题未使用默认名称')
      assert.equal(await window.webContents.executeJavaScript(`Boolean(document.querySelector('.id-directory-header-actions [aria-label="新建页面"]')?.getBoundingClientRect().width) && Boolean(document.querySelector('.id-directory-header-actions [aria-label="新建分组"]')?.getBoundingClientRect().width) && !document.querySelector('.id-directory-create')`), true, '新增入口未放入目录标题右侧')
      assert.equal(await window.webContents.executeJavaScript(`(() => { const version = document.querySelector('.id-toolbar [aria-label="查看版本与候选"]'); const phone = document.querySelector('.id-toolbar [aria-label="选择预览设备"]'); const mode = document.querySelector('.id-mode'); return !document.querySelector('.id-actions [aria-label="查看版本与候选"]') && version instanceof HTMLElement && phone instanceof HTMLElement && mode instanceof HTMLElement && version.getBoundingClientRect().left > mode.getBoundingClientRect().right && version.getBoundingClientRect().right < phone.getBoundingClientRect().left })()`), true, `${width}px 版本按钮未移到第二排工具栏空位`)
      await clickSelector(window, '[aria-label="今日习惯页面操作"]'); await waitFor(window, `document.querySelector('[role="menu"]')`, '页面菜单未显示')
      const menu = await window.webContents.executeJavaScript(`document.querySelector('[role="menu"]').textContent`)
      for (const label of ['复制', '重命名', '设为入口', '删除']) assert.ok(menu.includes(label), `缺少菜单 ${label}`)
      assert.ok(menu.includes('移动到'), '页面应支持移动到多级分组')
      /** 检查菜单自身和屏幕命中层，避免只验证 Portal 节点存在而忽略被遮挡。 */
      const menuHit = await window.webContents.executeJavaScript(`(() => { const menu = document.querySelector('[role="menu"]'); if (!(menu instanceof HTMLElement)) return null; const rect = menu.getBoundingClientRect(); const point = { x: Math.round(rect.left + rect.width / 2), y: Math.round(rect.top + rect.height / 2) }; const hit = document.elementFromPoint(point.x, point.y); return { width: rect.width, height: rect.height, zIndex: getComputedStyle(menu).zIndex, wrapperZIndex: menu.parentElement ? getComputedStyle(menu.parentElement).zIndex : '', hitInside: hit instanceof Element && Boolean(hit.closest('[role="menu"]')) } })()`)
      assert.ok(menuHit && menuHit.width > 0 && menuHit.height > 0 && menuHit.hitInside, '页面菜单虽挂载但不可点击')
      if (width === 1180) {
        await click(window, '重命名'); await waitFor(window, `document.querySelector('[role="dialog"]')`, '页面菜单项点击未打开重命名表单')
        await click(window, '取消'); await waitFor(window, `!document.querySelector('[role="dialog"]')`, '重命名表单未关闭')
        await clickSelector(window, '[aria-label="核心分组操作"]'); await waitFor(window, `document.querySelector('[role="menu"]')`, '分组菜单未显示')
        const groupMenu = await window.webContents.executeJavaScript(`document.querySelector('[role="menu"]').textContent`)
        for (const label of ['新建子分组', '重命名', '删除分组']) assert.ok(groupMenu.includes(label), `缺少分组菜单 ${label}`)
      }
      if (width === 1180) { await window.webContents.executeJavaScript(`Promise.all(document.getAnimations().filter(animation=>Number.isFinite(animation.effect?.getComputedTiming().endTime)).map(animation=>animation.finished.catch(()=>undefined))).then(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))))`); await writeFile('/private/tmp/interaction-design-ui-directory-menu.png', (await window.webContents.capturePage()).toPNG()) }
      await escape(window); await waitFor(window, `!document.querySelector('[role="menu"]')`, '菜单未收起')
      await escape(window); await waitFor(window, `!document.querySelector('.id-directory')`, '目录未收起')
      assert.equal(await window.webContents.executeJavaScript(`window.__frame===document.querySelector('.id-cached-page[data-active="true"] iframe')`), true)
    }
    console.log('[Interaction Design UI smoke] 三档目录回归通过')
    /** 项目级变更事件刷新原型记录目录，并允许从选择器进入新候选。 */
    await window.webContents.executeJavaScript(`window.__interactionSmoke.change('workspace-a', 'proto-remote')`)
    assert.equal(await window.webContents.executeJavaScript(`window.__interactionSmoke.state.calls.filter(call => call === 'list:session-a').length > 1`), true, '其他原型事件未触发目录读取')
    await waitFor(window, `document.querySelector('.id-prototype-selector')?.textContent.includes('拾光测试')`, '原型选择器未显示当前原型')
    await clickSelector(window, '.id-prototype-selector')
    await waitFor(window, `document.querySelector('[role="menu"]')?.textContent.includes('缓存与空间')`, '原型选择器未显示新原型')
    await clickPrototypeOption(window, '缓存与空间')
    await waitFor(window, `document.querySelector('.id-prototype-selector')?.textContent.includes('缓存与空间') && document.querySelector('.id-title p')?.textContent.includes('已保存 v1')`, '选择新原型后未加载目标内容')
    await previewHistoryCandidate(window); await waitFor(window, `!document.querySelector('.id-history') && document.querySelector('.id-title p')?.textContent.includes('候选预览')`, '候选预览未打开')
    assert.equal(await window.webContents.executeJavaScript(`document.querySelector('.id-title p')?.textContent === '候选预览 · 2 个页面 · 基于 v1'`), true, '候选预览仍显示正式版本页数')
    await click(window, '页面'); await waitFor(window, `document.querySelectorAll('.id-page').length===2`, '候选预览缺少页面列表入口'); await escape(window)
    await waitForPreviewText(window, '缓存页')
    await returnFromHistory(window)
    /** 无原型项目的新建页面表单不应被外部变更事件误判为旧版本冲突。 */
    await window.webContents.executeJavaScript(`window.__interactionSmoke.switchEmpty()`)
    await waitFor(window, `!document.querySelector('.id-prototype-selector') && document.body.textContent.includes('从需求或现有项目开始')`, '无原型项目未就绪')
    await click(window, '页面'); await waitFor(window, `document.querySelector('.id-directory')`, '无原型项目目录未展开')
    await waitFor(window, `document.body.textContent.includes('当前项目还没有交互设计模块')`, '无页面目录内容未就绪')
    await clickSelector(window, '.id-directory-header-actions [aria-label="新建页面"]'); await waitFor(window, `document.querySelector('[role="dialog"]')`, '新建页面表单未打开')
    await window.webContents.executeJavaScript(`window.__interactionSmoke.change('workspace-c')`)
    await waitFor(window, `document.querySelector('[role="dialog"]') && !document.body.textContent.includes('外部版本已变化')`, '新建页面表单被误报外部版本变化')
    await clickSelector(window, 'input[aria-label="新建页面"]')
    await window.webContents.executeJavaScript(`(() => { const input = document.querySelector('input[aria-label="新建页面"]'); if (!(input instanceof HTMLInputElement)) return false; const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set; setter?.call(input, '你好'); input.dispatchEvent(new Event('input', { bubbles: true })); return true })()`)
    await click(window, '保存')
    await waitFor(window, `document.body.textContent.includes('已保存 v1') && document.body.textContent.includes('你好') && !document.querySelector('[role="dialog"]')`, '新建页面表单提交失败')
    await window.loadURL(url)
    await waitFor(window, `document.querySelector('.id-cached-page[data-active="true"] iframe') && document.body.textContent.includes('已保存 v1')`, '新建回归后工作区未重置')
    await window.webContents.executeJavaScript(`window.__frame=document.querySelector('.id-cached-page[data-active="true"] iframe');window.__src=window.__frame.srcdoc`)
    window.setSize(1180, 850)
    await click(window, '选择修改'); await click(window, '体验')
    assert.equal(await window.webContents.executeJavaScript(`window.__frame===document.querySelector('.id-cached-page[data-active="true"] iframe') && window.__src===window.__frame.srcdoc`), true, '切换选择模式重建正文')
    await selectPreviewDevice(window, 'MacBook Pro')
    assert.equal(await window.webContents.executeJavaScript(`window.__frame===document.querySelector('.id-cached-page[data-active="true"] iframe') && window.__src===window.__frame.srcdoc`), true, '设备切换重建正文')
    await selectPreviewDevice(window, 'iPhone 17')
    const lightBackground = await window.webContents.executeJavaScript(`getComputedStyle(document.querySelector('.interaction-design')).backgroundColor`)
    await window.webContents.executeJavaScript(`document.documentElement.classList.add('dark');new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))`)
    const darkBackground = await window.webContents.executeJavaScript(`getComputedStyle(document.querySelector('.interaction-design')).backgroundColor`)
    assert.notEqual(darkBackground, lightBackground, '深色主题未生效')
    assert.equal(darkBackground, 'rgb(26, 26, 26)', '深色主题背景不匹配宿主变量')
    await window.webContents.executeJavaScript(`Promise.all(document.getAnimations().filter(animation=>Number.isFinite(animation.effect?.getComputedTiming().endTime)).map(animation=>animation.finished.catch(()=>undefined))).then(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))))`)
    await writeFile('/private/tmp/interaction-design-ui-dark.png', (await window.webContents.capturePage()).toPNG())
    await window.webContents.executeJavaScript(`document.documentElement.classList.remove('dark')`)
    await previewHistoryCandidate(window); await waitFor(window, `!document.querySelector('.id-history') && document.querySelector('.id-title p')?.textContent.includes('候选预览')`, '候选未预览')
    assert.equal(await window.webContents.executeJavaScript(`window.__interactionSmoke.state.snapshot.document.revision`), 1, '预览自动采纳')
    await returnFromHistory(window); await openHistory(window); await clickSelector(window, '[data-history-key="candidate:candidate-a"] [aria-label="采纳候选"]')
    await waitFor(window, `document.body.textContent.includes('已保存 v2')`, '采纳未形成版本')
    await openHistory(window); await clickSelector(window, '[data-history-key="version:1"] .id-history-actions button:first-child')
    await waitFor(window, `document.body.textContent.includes('已保存 v1') && document.body.textContent.includes('未新增版本') && !document.querySelector('[role="dialog"]')`, '恢复未切换当前版本')
    await openHistory(window); await waitFor(window, `document.querySelector('.id-history') && document.body.textContent.includes('历史版本')`, '版本记录未打开')
    assert.equal(await window.webContents.executeJavaScript(`document.querySelector('[aria-label="删除 v1"]')`), null, '当前版本暴露了删除入口')
    await clickSelector(window, '[aria-label="删除 v2"]'); await waitFor(window, `document.querySelector('[role="alertdialog"]') && document.body.textContent.includes('删除 v2？')`, '历史版本删除确认未打开')
    await click(window, '取消'); await waitFor(window, `!document.querySelector('[role="alertdialog"]')`, '删除确认未取消')
    assert.equal(await window.webContents.executeJavaScript(`window.__interactionSmoke.state.calls.filter(call=>call.startsWith('deleteVersion:')).length`), 0, '取消仍提交了删除请求')
    await clickSelector(window, '[aria-label="删除 v2"]'); await waitFor(window, `document.querySelector('[role="alertdialog"]')`, '再次删除未确认')
    await window.webContents.executeJavaScript(`window.__interactionSmoke.state.failNext=true`)
    await click(window, '删除版本'); await waitFor(window, `document.querySelector('[role="alertdialog"] [role="alert"]')?.textContent.includes('fixture 读取失败')`, '删除失败未在确认框内显示')
    assert.equal(await window.webContents.executeJavaScript(`window.__interactionSmoke.state.snapshot.versions.some(version=>version.revision===2)`), true, '删除失败丢失了历史版本')
    await click(window, '删除版本'); await waitFor(window, `document.querySelector('[role="dialog"]') && !document.querySelector('[data-history-key="version:2"]') && document.body.textContent.includes('已删除 v2')`, '历史版本删除未完成')
    assert.equal(await window.webContents.executeJavaScript(`document.querySelectorAll('.id-history-entry').length`), 1, '删除 v2 后历史没有仅保留 v1')
    assert.equal(await window.webContents.executeJavaScript(`Boolean(document.querySelector('[data-history-key="candidate:candidate-a"]'))`), false, '删除正式版本后已采纳候选重新回流')
    await click(window, '关闭'); await waitFor(window, `!document.querySelector('[role="dialog"]')`, '版本记录未关闭')
    await waitFor(window, `!document.querySelector('[role="dialog"]') && !document.querySelector('[role="menu"]')`, '截图前对话框和菜单尚未退出')
    await window.webContents.executeJavaScript(`Promise.all(document.getAnimations().filter(animation=>Number.isFinite(animation.effect?.getComputedTiming().endTime)).map(animation=>animation.finished.catch(()=>undefined))).then(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))))`)
    await writeFile('/private/tmp/interaction-design-ui-desktop.png', (await window.webContents.capturePage()).toPNG())
    /** 外部更新不得把已经打开的删除确认自动绑定到新基线。 */
    await window.loadURL(url); await waitFor(window, `document.body.textContent.includes('已保存 v1')`, '删除上下文场景未就绪')
    await window.webContents.executeJavaScript(`window.__interactionSmoke.state.snapshot.versions.push({revision:2,summary:'历史版本',createdAt:5});window.__interactionSmoke.change('workspace-a','proto-a')`)
    await openHistory(window); await clickSelector(window, '[aria-label="删除 v2"]')
    await waitFor(window, `document.querySelector('[role="alertdialog"]')`, '上下文删除确认未打开')
    await window.webContents.executeJavaScript(`window.__interactionSmoke.change('workspace-a','proto-a')`)
    await waitFor(window, `document.querySelector('[role="alertdialog"] [role="alert"]')?.textContent.includes('版本记录已变化')`, '外部更新未提示删除冲突')
    await click(window, '删除版本')
    assert.equal(await window.webContents.executeJavaScript(`window.__interactionSmoke.state.calls.filter(call=>call.startsWith('deleteVersion:')).length`), 0, '旧删除确认跟随了新的版本状态')
    /** 同编号历史不能在切换项目后继承上一个项目的确认。 */
    await window.webContents.executeJavaScript(`window.__interactionSmoke.switchHost()`)
    await waitFor(window, `window.__interactionSmoke.state.calls.includes('load:session-b') && !document.querySelector('[role="alertdialog"]')`, '切换项目后保留了旧删除确认')
    assert.equal(await window.webContents.executeJavaScript(`window.__interactionSmoke.state.calls.includes('deleteVersion:session-b')`), false, '旧确认误删新项目历史')
    await window.loadURL(url); await waitFor(window, `document.body.textContent.includes('已保存 v1')`, '迟到场景未就绪')
    await window.webContents.executeJavaScript(`window.__interactionSmoke.state.holdCandidate=true`)
    // 此处故意挂起候选响应，不等待预览完成或历史关闭。
    await openHistory(window); await click(window, '预览'); await waitFor(window, `window.__interactionSmoke.state.pendingCandidate`, '候选请求未挂起')
    await window.webContents.executeJavaScript(`window.__interactionSmoke.switchHost()`)
    await waitFor(window, `window.__interactionSmoke.state.calls.includes('load:session-b') && document.querySelector('.id-title strong')?.textContent === '交互设计'`, '新项目尚未加载')
    await window.webContents.executeJavaScript(`window.__interactionSmoke.release()`)
    await waitFor(window, `!window.__interactionSmoke.state.pendingCandidate`, '旧请求未释放')
    assert.equal(await window.webContents.executeJavaScript(`Boolean(document.querySelector('.id-title p')?.textContent.includes('候选预览'))`), false, '旧候选污染新项目')
    assert.equal(await window.webContents.executeJavaScript(`window.__interactionSmoke.prompt()`), null, '旧响应污染新会话')
    console.log('[Interaction Design UI smoke] 版本与上下文回归通过')
    /** Given 一页两状态 When 展示与编辑 Then 平面展开且只修改所选状态。 */
    window.show(); window.focus()
    await window.loadURL(url); await waitFor(window, `document.querySelector('.id-cached-page[data-active="true"] iframe') && document.body.textContent.includes('已保存 v1')`, '状态场景未就绪')
    window.setSize(1180, 850)
    await window.webContents.executeJavaScript(`(() => {
      const state = window.__interactionSmoke.state;
      const page = state.snapshot.document.pages[0];
      page.defaultStateName = '有数据';
      page.states = [{id:'empty',name:'无数据',html:'<html><body style="font:18px system-ui;padding:28px"><h1 data-prototype-element="title">暂无记录</h1><button data-prototype-element="next" data-prototype-page="detail">查看详情</button></body></html>'}];
      state.snapshot.document.revision = 2;
      window.__interactionSmoke.change('workspace-a','proto-a');
    })()`)
    await waitFor(window, `document.querySelectorAll('.id-cached-page[data-active="true"] .id-state-board iframe').length === 2 && document.body.textContent.includes('2 个状态')`, '当前页多状态未展开')
    await window.webContents.executeJavaScript(`new Promise(resolve=>setTimeout(resolve,200))`)
    assert.equal(await window.webContents.executeJavaScript(`(() => { const boards=[...document.querySelectorAll('.id-cached-page[data-active="true"] .id-state-board')].map(node=>node.getBoundingClientRect()); return Math.abs(boards[0].top-boards[1].top)<2 && boards[1].left>=boards[0].right && document.querySelectorAll('.id-cached-page[data-active="true"] iframe').length===2 })()`), true, '数据态和空态未并排或错误加载邻页')
    await window.webContents.executeJavaScript(`window.__frames=[...document.querySelectorAll('.id-cached-page[data-active="true"] iframe')];window.__rects=window.__frames.map(frame=>JSON.stringify(frame.getBoundingClientRect().toJSON()))`)
    await click(window, '页面')
    await waitFor(window, `document.querySelector('.id-directory')`, '状态目录未打开')
    assert.equal(await window.webContents.executeJavaScript(`window.__frames.every((frame,index)=>frame===document.querySelectorAll('.id-cached-page[data-active="true"] iframe')[index] && window.__rects[index]===JSON.stringify(frame.getBoundingClientRect().toJSON())) && document.querySelectorAll('.id-page').length===2`), true, '状态被错误拆成目录页面，或目录挤压画板')
    await escape(window)
    await waitFor(window, `!document.querySelector('.id-directory')`, '状态目录未关闭')
    await click(window, '选择修改')
    await waitFor(window, `document.querySelector('.id-mode button:last-child')?.getAttribute('aria-pressed')==='true'`, '选择模式尚未生效')
    await window.webContents.executeJavaScript(`new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))`)
    await clickStateElement(window, 'empty', '[data-prototype-element="title"]')
    await waitFor(window, `document.querySelector('.id-selection')?.textContent.includes('无数据 / title')`, '选区未携带状态身份')
    await click(window, '引用到会话'); await waitFor(window, `document.querySelector('[role="dialog"]')`, '引用表单未打开'); await click(window, '引用到会话')
    await waitFor(window, `window.__interactionSmoke.prompt()?.message.includes('stateId: empty')`, 'Agent 引用丢失状态身份')
    await click(window, '编辑文字')
    await waitFor(window, `document.querySelector('textarea')`, '状态文字表单未打开')
    assert.equal(await window.webContents.executeJavaScript(`document.querySelector('textarea').value`), '暂无记录', '空态编辑误读默认态同名元素')
    await window.webContents.executeJavaScript(`(() => { const input=document.querySelector('textarea');Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(input,'还没有记录');input.dispatchEvent(new Event('input',{bubbles:true})) })()`)
    await click(window, '保存'); await waitFor(window, `document.body.textContent.includes('已保存 v3') && !document.querySelector('[role="dialog"]')`, '状态文字保存失败')
    assert.equal(await window.webContents.executeJavaScript(`window.__interactionSmoke.state.snapshot.document.pages[0].states[0].html.includes('还没有记录') && window.__interactionSmoke.state.snapshot.document.pages[0].html.includes('拾光</h1>')`), true, '空态修改污染了默认态')
    await click(window, '体验')
    await waitFor(window, `document.querySelectorAll('.id-cached-page[data-active="true"] .id-state-board iframe').length===2`, '保存后状态未恢复')
    await writeFile('/private/tmp/interaction-design-page-states.png', (await window.webContents.capturePage()).toPNG())
    await clickStateElement(window, 'empty', '[data-prototype-page="detail"]')
    await waitFor(window, `document.querySelector('.id-stage-top')?.textContent.includes('今日习惯') && document.querySelectorAll('.id-cached-page[data-active="true"] iframe').length===1`, '附加状态跨页跳转失败')
    /** Given 候选新增业务页 When 打开目录 Then 候选新页可读且不写入正式版。 */
    await window.webContents.executeJavaScript(`(() => { const smoke=window.__interactionSmoke;smoke.candidate.draft=structuredClone(smoke.state.snapshot.document);smoke.candidate.draft.pages.push({id:'settings',name:'设置',groupId:'group-a',html:'<h1>候选设置页</h1>'}); })()`)
    await previewHistoryCandidate(window); await waitFor(window, `!document.querySelector('.id-history') && document.querySelector('.id-title p')?.textContent.includes('候选预览')`, '候选新增页面未预览'); await click(window, '页面')
    await waitFor(window, `document.querySelectorAll('.id-page').length===3 && document.body.textContent.includes('设置')`, '候选新增业务页未进入目录')
    assert.equal(await window.webContents.executeJavaScript(`document.querySelector('.id-title p')?.textContent === '候选预览 · 3 个页面 · 基于 v1'`), true, '候选新增页面数量未同步到顶部状态')
    assert.equal(await window.webContents.executeJavaScript(`document.querySelector('[aria-label="设置页面操作"]').disabled`), true, '候选目录允许误写正式版')
    await click(window, '设置')
    await waitFor(window, `document.querySelector('.id-title p')?.textContent.includes('候选预览') && document.querySelector('.id-stage-top')?.textContent.includes('设置')`, '切换候选业务页退出了候选预览')
    await waitForPreviewText(window, '候选设置页')
    assert.equal(await window.webContents.executeJavaScript(`window.__interactionSmoke.state.snapshot.document.pages.length`), 2, '浏览候选自动采纳页面')
    await returnFromHistory(window)
    /** Given 目标页拥有附加状态 When 从目录进入 Then 默认状态立即有可读正文。 */
    await window.webContents.executeJavaScript(`(() => {
      const state = window.__interactionSmoke.state
      const page = state.snapshot.document.pages.find(item => item.id === 'detail')
      if (!page) throw new Error('状态回归缺少今日习惯页')
      page.states = [{ id: 'summary', name: '摘要', html: '<html><body><h1>今日习惯摘要</h1></body></html>' }]
      state.snapshot.document.revision += 1
      window.__interactionSmoke.change('workspace-a', 'proto-a')
    })()`)
    await waitFor(window, `document.body.textContent.includes('2 个状态')`, '多状态目标页未加载')
    await click(window, '页面'); await clickPage(window, '欢迎'); await waitForPreviewText(window, '拾光')
    await click(window, '页面'); await clickPage(window, '今日习惯')
    await waitForPreviewText(window, '今日习惯')
    /** Given 用户正在查看业务页 When 点击刷新 Then 只重载当前页，不跳回入口页。 */
    for (const pageName of ['今日习惯', '欢迎', '今日习惯', '欢迎', '今日习惯']) {
      await click(window, '页面'); await clickPage(window, pageName)
      await waitFor(window, `document.querySelector('.id-stage-top')?.textContent.includes(${JSON.stringify(pageName)})`, `切换后标题未更新：${pageName}`)
      await waitForPreviewText(window, pageName === '欢迎' ? '拾光' : pageName)
    }
    await clickSelector(window, '[aria-label="重新体验"]')
    await waitFor(window, `document.querySelector('.id-stage-top')?.textContent.includes('今日习惯')`, '刷新后错误跳回入口页')
    await waitForPreviewText(window, '今日习惯')
    await click(window, '页面'); await clickPage(window, '欢迎')
    await waitFor(window, `document.querySelector('.id-stage-top')?.textContent.includes('欢迎')`, '刷新回归后的状态场景未恢复')
    await waitForPreviewText(window, '拾光')
    window.setSize(390, 850)
    await window.webContents.executeJavaScript(`new Promise(resolve=>setTimeout(resolve,180))`)
    /** 留下窄屏几何证据，避免只报告断言真假而无法定位滚动问题。 */
    const narrowLayout = await window.webContents.executeJavaScript(`(() => {const space=document.querySelector('.id-cached-page[data-active="true"] .id-state-space');return {scrollHeight:space.scrollHeight,clientHeight:space.clientHeight,scrollWidth:space.scrollWidth,clientWidth:space.clientWidth,boardWidths:[...space.children].map(node=>node.getBoundingClientRect().width)}})()`)
    assert.ok(narrowLayout.scrollHeight>narrowLayout.clientHeight && narrowLayout.scrollWidth<=narrowLayout.clientWidth+1, `窄窗口状态没有平铺滚动或横向溢出：${JSON.stringify(narrowLayout)}`)
    await window.webContents.executeJavaScript(`document.querySelector('.id-cached-page[data-active="true"] .id-state-space').scrollTop=10000`)
    await waitFor(window, `document.querySelector('.id-cached-page[data-active="true"] [data-state-id="empty"] iframe')`, '滚动未加载附加状态')
    assert.deepEqual(errors, [])
    console.log('[Interaction Design UI smoke] PASS: 默认与附加状态三维旋转/缩放/复位/本地提交/选择隔离、状态平铺/独立编辑/引用/跳转/候选目录、开发交接、3种宽度目录覆盖无位移/重建、页面菜单、模式/设备稳定、深色、候选/采纳/恢复、删除确认/取消/错误/重试/上下文隔离及迟到隔离；未访问真实业务数据')
  } finally { window.destroy() }
}
/** Bun 父进程启动临时 Vite，再构建并执行 Electron 子进程。 */
async function orchestrate(): Promise<void> {
  const port = await availablePort()
  const baseUrl = `http://127.0.0.1:${port}`
  /** HTML 只在 smoke 运行期间存在，结束后删除，仓库仍只保留两份脚本。 */
  const fixtureHtmlPath = join(process.cwd(), 'scripts', `.interaction-design-ui-smoke-${process.pid}.html`)
  const fixtureUrl = `${baseUrl}/@fs${fixtureHtmlPath}`
  await writeFile(fixtureHtmlPath, '<!doctype html><html lang="zh-CN"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Interaction Design UI Smoke</title></head><body><div id="root"></div><script type="module">import RefreshRuntime from "/@react-refresh"; RefreshRuntime.injectIntoGlobalHook(window); window.$RefreshReg$ = () => undefined; window.$RefreshSig$ = () => (type) => type;</script><script type="module" src="./interaction-design-ui-smoke-renderer.tsx"></script></body></html>')
  const fixtureConfigPath = join(process.cwd(), 'scripts', `.interaction-design-smoke-config-${process.pid}.ts`)
  await writeFile(fixtureConfigPath, "import config from '../vite.config';export default {...config,server:{...config.server,hmr:false,watch:null}}")
  const vite = spawn(process.execPath, [join(process.cwd(), 'node_modules/vite/bin/vite.js'), '--config', fixtureConfigPath, '--host', '127.0.0.1', '--port', String(port), '--strictPort'], { cwd: process.cwd(), stdio: 'inherit' })
  try {
    const deadline = Date.now() + 20_000
    let ready = false
    while (Date.now() < deadline) {
      try {
        const response = await fetch(fixtureUrl)
        if (response.ok) { ready = true; break }
      } catch { /* 等待 Vite */ }
      await new Promise<void>((resolve) => setTimeout(resolve, 100))
    }
    if (!ready) throw new Error('Vite smoke renderer 启动超时')

    const buildDir = await mkdtemp(join(tmpdir(), 'proma-interaction-design-ui-smoke-build-'))
    try {
      const build = await Bun.build({ entrypoints: [join(process.cwd(), 'scripts/interaction-design-ui-smoke.ts')], outdir: buildDir, target: 'node', format: 'cjs', external: ['electron'] })
      if (!build.success || !build.outputs[0]) throw new Error('构建 Interaction Design UI smoke 入口失败')
      const electronPath = process.env.PROMA_ELECTRON_PATH ?? join(process.cwd(), 'node_modules/.bin/electron')
      /** 默认依序运行三段；显式场景只运行该段，便于定位且不复用跨项目的渲染进程。 */
      const scenarios = process.env.PROMA_INTERACTION_DESIGN_SMOKE_SCENARIO ? [process.env.PROMA_INTERACTION_DESIGN_SMOKE_SCENARIO] : ['cache', 'inflight', 'regression']
      for (const scenario of scenarios) {
        if (!['cache', 'inflight', 'regression', 'devices'].includes(scenario)) throw new Error(`未知 smoke 场景：${scenario}`)
        /** 每段隔离 userData，子进程完全退出后统一清理，避免退出写入与删除竞争。 */
        const userDataPath = await mkdtemp(join(buildDir, `user-data-${scenario}-`))
        console.log(`[Interaction Design UI smoke] 开始独立场景：${scenario}`)
        const electron = spawn(electronPath, [build.outputs[0].path], {
          cwd: process.cwd(),
          env: { ...process.env, PROMA_INTERACTION_DESIGN_UI_SMOKE_CHILD: '1', PROMA_INTERACTION_DESIGN_SMOKE_SCENARIO: scenario, PROMA_INTERACTION_DESIGN_FIXTURE_URL: fixtureUrl, PROMA_INTERACTION_DESIGN_SMOKE_USER_DATA: userDataPath },
          stdio: 'inherit',
        })
        const code = await new Promise<number>((resolve, reject) => {
          /** 每段单独有界；超时仍等待退出后才清理临时目录。 */
          let timedOut = false
          const timeout = setTimeout(() => { timedOut = true; electron.kill('SIGKILL') }, 180_000)
          electron.once('error', (error) => { clearTimeout(timeout); reject(error) })
          electron.once('exit', (value) => {
            clearTimeout(timeout)
            if (timedOut) reject(new Error(`Interaction Design UI smoke ${scenario} 超时`))
            else resolve(value ?? 1)
          })
        })
        assert.equal(code, 0, `Electron smoke ${scenario} 退出码 ${code}`)
        console.log(`[Interaction Design UI smoke] 独立场景通过：${scenario}`)
      }
    } finally {
      await rm(buildDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 })
    }
  } finally {
    vite.kill('SIGTERM')
    await rm(fixtureHtmlPath, { force: true })
    await rm(fixtureConfigPath, { force: true })
  }
}

if (process.env.PROMA_INTERACTION_DESIGN_UI_SMOKE_CHILD === '1') {
  const electron = require('electron') as typeof import('electron')
  const userDataPath = process.env.PROMA_INTERACTION_DESIGN_SMOKE_USER_DATA
  if (!userDataPath) throw new Error('缺少隔离 userData 目录')
  electron.app.setPath('userData', userDataPath)
  /** 失败时 finally 会先销毁窗口；阻止默认生命周期抢在 catch 前以 0 退出。 */
  electron.app.on('window-all-closed', () => undefined)
  const keepAlive = setInterval(() => undefined, 1_000)
  void runElectronSmoke(electron.app, electron.BrowserWindow)
    .then(() => { clearInterval(keepAlive); electron.app.quit() })
    .catch((error: unknown) => {
      clearInterval(keepAlive)
      console.error('[Interaction Design UI smoke] FAIL', error)
      electron.app.exit(1)
    })
} else {
  void orchestrate().catch((error: unknown) => { console.error('[Interaction Design UI smoke] FAIL', error); process.exitCode = 1 })
}
