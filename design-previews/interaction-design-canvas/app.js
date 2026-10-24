/** 原型演示数据；正式实现中由 PrototypeDraft 派生，不形成第二套业务事实。 */
const pages = {
  home: { title: '首页', group: '发现与探索', groupKey: 'discover', index: '01', states: ['默认', '加载中'], entry: true, issue: false, refs: ['ref-visual-1', 'ref-structure-2'] },
  discover: { title: '发现活动', group: '发现与探索', groupKey: 'discover', index: '02', states: ['默认'], entry: false, issue: false, refs: ['ref-structure-2'] },
  search: { title: '活动搜索', group: '发现与探索', groupKey: 'discover', index: '03', states: ['默认'], entry: false, issue: false, refs: ['ref-structure-3'] },
  detail: { title: '活动详情', group: '浏览与决策', groupKey: 'decision', index: '04', states: ['默认', '已报名', '已满员'], entry: false, issue: true, refs: ['ref-structure-1', 'ref-visual-1'] },
  speakers: { title: '嘉宾阵容', group: '浏览与决策', groupKey: 'decision', index: '05', states: ['默认'], entry: false, issue: false, refs: ['ref-copy-1'] },
  ticket: { title: '选择票种', group: '浏览与决策', groupKey: 'decision', index: '06', states: ['默认'], entry: false, issue: false, refs: ['ref-copy-1', 'ref-structure-1'] },
  signin: { title: '登录确认', group: '浏览与决策', groupKey: 'decision', index: '07', states: ['页面级弹层'], entry: false, issue: true, refs: [] },
  confirm: { title: '订单确认', group: '报名与完成', groupKey: 'complete', index: '08', states: ['默认'], entry: false, issue: false, refs: ['ref-visual-2'] },
  success: { title: '报名成功', group: '报名与完成', groupKey: 'complete', index: '09', states: ['成功', '待审核', '失败'], entry: false, issue: false, refs: ['ref-structure-1'] },
  pass: { title: '我的票夹', group: '报名与完成', groupKey: 'complete', index: '10', states: ['默认'], entry: false, issue: false, refs: ['ref-structure-3'] }
}

/** 参考图角色与页面关联分开表达，避免把“结构参考”误当成流程节点。 */
const references = [
  { id: 'ref-structure-1', title: '活动详情页结构', type: 'structure', typeLabel: '结构', source: 'Figma · 4 页', className: 'ref-structure-1', aspectRatio: 4 / 3 },
  { id: 'ref-visual-1', title: 'Neon Nights 视觉方向', type: 'visual', typeLabel: '视觉', source: 'Pinterest · 3 张', className: 'ref-visual-1', aspectRatio: 3 / 4 },
  { id: 'ref-structure-2', title: '发现页卡片栅格', type: 'structure', typeLabel: '结构', source: '竞品截图', className: 'ref-structure-2', aspectRatio: 4 / 3 },
  { id: 'ref-copy-1', title: '票务信息层级', type: 'copy', typeLabel: '文案', source: '活动复盘', className: 'ref-copy-1', aspectRatio: 1 },
  { id: 'ref-visual-2', title: '支付成功反馈', type: 'visual', typeLabel: '视觉', source: 'Mobbin', className: 'ref-visual-2', aspectRatio: 16 / 10 },
  { id: 'ref-structure-3', title: '票夹与凭证布局', type: 'structure', typeLabel: '结构', source: '本地参考', className: 'ref-structure-3', aspectRatio: 16 / 9 }
]

/** 实际跳转只渲染为图边；拖动画布或节点不会改变业务关系。 */
const flows = [
  { from: 'home', to: 'discover', action: '点击发现', primary: true },
  { from: 'home', to: 'detail', action: '点击推荐活动', primary: true },
  { from: 'discover', to: 'detail', action: '打开活动', primary: true },
  { from: 'search', to: 'detail', action: '选择搜索结果', primary: false },
  { from: 'detail', to: 'speakers', action: '查看嘉宾', primary: false },
  { from: 'detail', to: 'ticket', action: '选择票种', primary: true },
  { from: 'detail', to: 'success', action: '已报名', primary: false },
  { from: 'ticket', to: 'confirm', action: '确认票种', primary: true },
  { from: 'confirm', to: 'success', action: '支付完成', primary: true },
  { from: 'success', to: 'pass', action: '查看电子票', primary: true },
  { from: 'pass', to: 'home', action: '返回首页', primary: false }
]

/** 设备比例同时驱动画布页面图、底部选中图和 inspector 缩略图。 */
const devices = {
  'iphone-15-pro': { label: 'iPhone 15 Pro', width: 393, height: 852 },
  'pixel-8': { label: 'Pixel 8', width: 412, height: 915 },
  desktop: { label: '桌面浏览器', width: 1440, height: 900 },
}

/** 两行五列的交互图布局；页面卡片本身按设备比例决定高度。 */
const nodeGrid = {
  home: [0, 0],
  discover: [1, 0],
  detail: [2, 0],
  ticket: [3, 0],
  confirm: [4, 0],
  search: [1, 1],
  speakers: [2, 1],
  signin: [3, 1],
  success: [4, 1],
  pass: [0, 1],
}
const nodeColumns = [30, 270, 510, 750, 990]
const nodeWidth = 210
const nodeRowGap = 44
const nodeMargin = 24

const tabs = [...document.querySelectorAll('[role="tab"]')]
const panels = { canvas: document.querySelector('#canvasPanel'), preview: document.querySelector('#previewPanel'), references: document.querySelector('#referencesPanel') }
const moduleShell = document.querySelector('.module-shell')
const workspace = document.querySelector('#workspace')
const directory = document.querySelector('#directory')
const directoryToggle = document.querySelector('#directoryToggle')
const actionMenu = document.querySelector('#actionMenu')
const toast = document.querySelector('#toast')
const canvasWorld = document.querySelector('#canvasWorld')
const canvasSurface = document.querySelector('#canvasSurface')
const flowPaths = document.querySelector('#flowPaths')
const flowLabels = document.querySelector('#flowLabels')
let currentView = 'preview'
let selectedPage = 'detail'
let selectedReference = null
let selectedDialogRefs = new Set()
let zoom = 0.74
let pan = { x: 0, y: 0 }
let isPanning = false
let panStart = null
let menuOwner = null
let dialogReturnFocus = null
let referenceViewerReturnFocus = null

/** 原型允许通过 URL 检查主题与指定页面，不改变正式模块偏好。 */
function applyReviewTheme() {
  const params = new URLSearchParams(window.location.search)
  const requested = params.get('theme')
  const dark = requested ? requested === 'dark' : window.matchMedia('(prefers-color-scheme: dark)').matches
  document.documentElement.classList.toggle('dark', dark)
}

/** 仅更新预览世界变换，保持节点 DOM 与交互现场。 */
function updateCanvasTransform() {
  canvasWorld.style.transform = `translate(${pan.x}px, ${pan.y}px) scale(${zoom})`
  document.querySelector('#zoomResetButton').textContent = `${Math.round(zoom * 100)}%`
}

/** 应用设备比例；节点高度由 CSS aspect-ratio 自然撑开，随后重算连线端点。 */
function applyDevice(deviceId) {
  const device = devices[deviceId] ?? devices['iphone-15-pro']
  moduleShell.dataset.device = deviceId in devices ? deviceId : 'iphone-15-pro'
  moduleShell.style.setProperty('--device-ratio', `${device.width} / ${device.height}`)
  document.querySelector('#previewDevice').value = moduleShell.dataset.device
  document.querySelector('#canvasDeviceBadge').textContent = `${device.label} · ${device.width} × ${device.height}`
  document.querySelector('#previewDeviceInfo').textContent = `${device.label} · ${device.width} × ${device.height}`
  requestAnimationFrame(() => {
    layoutCanvasNodes()
    if (currentView === 'canvas') {
      fitCanvasToView()
      drawFlows()
    }
  })
}

/** 当前设备比例变化后同步节点坐标和画布世界尺寸，避免卡片重叠。 */
function layoutCanvasNodes() {
  const device = devices[moduleShell.dataset.device] ?? devices['iphone-15-pro']
  const nodeHeight = nodeWidth * device.height / device.width
  document.querySelectorAll('.page-node').forEach(node => {
    const [column, row] = nodeGrid[node.dataset.node] ?? [0, 0]
    node.style.left = `${nodeColumns[column]}px`
    node.style.top = `${nodeMargin + row * (nodeHeight + nodeRowGap)}px`
  })
  canvasWorld.style.width = `${nodeColumns.at(-1) + nodeWidth + nodeMargin}px`
  canvasWorld.style.height = `${nodeMargin * 2 + nodeHeight * 2 + nodeRowGap}px`
}

/** 自动把当前设备下的完整交互图放进可见画布。 */
function fitCanvasToView() {
  const worldWidth = canvasWorld.offsetWidth
  const worldHeight = canvasWorld.offsetHeight
  const availableWidth = Math.max(240, canvasSurface.clientWidth - 64)
  const availableHeight = Math.max(220, canvasSurface.clientHeight - 46)
  zoom = Math.max(.42, Math.min(1, availableWidth / worldWidth, availableHeight / worldHeight))
  pan = { x: 0, y: 0 }
  updateCanvasTransform()
}

/** 求节点中心之间的三次曲线，边不参与节点点击区域。 */
function edgePath(from, to, index) {
  const source = document.querySelector(`[data-node="${from}"]`)
  const target = document.querySelector(`[data-node="${to}"]`)
  if (!source || !target) return ''
  const sourceRect = { left: source.offsetLeft, top: source.offsetTop, right: source.offsetLeft + source.offsetWidth, bottom: source.offsetTop + source.offsetHeight }
  const targetRect = { left: target.offsetLeft, top: target.offsetTop, right: target.offsetLeft + target.offsetWidth, bottom: target.offsetTop + target.offsetHeight }
  const offset = (index % 3) * 4

  if (targetRect.left >= sourceRect.right) {
    const sx = sourceRect.right
    const sy = sourceRect.top + sourceRect.bottom >> 1
    const tx = targetRect.left
    const ty = targetRect.top + targetRect.bottom >> 1
    const bend = Math.max(28, Math.abs(tx - sx) * .42)
    return `M ${sx} ${sy} C ${sx + bend + offset} ${sy}, ${tx - bend + offset} ${ty}, ${tx} ${ty}`
  }

  if (targetRect.top > sourceRect.bottom) {
    const sx = sourceRect.left + sourceRect.right >> 1
    const sy = sourceRect.bottom
    const tx = targetRect.left + targetRect.right >> 1
    const ty = targetRect.top
    return `M ${sx} ${sy} C ${sx + 42 + offset} ${sy + 54}, ${tx - 42 - offset} ${ty - 54}, ${tx} ${ty}`
  }

  const sx = sourceRect.left
  const sy = sourceRect.top + sourceRect.bottom >> 1
  const tx = targetRect.right
  const ty = targetRect.top + targetRect.bottom >> 1
  return `M ${sx} ${sy} C ${sx - 80 - offset} ${sy - 45}, ${tx + 80 + offset} ${ty + 45}, ${tx} ${ty}`
}

/** 选中页面时只高亮一跳以内的业务关系，减少长图中的视觉噪音。 */
function buildFocusSet() {
  if (!selectedPage) return null
  const focused = new Set([selectedPage])
  for (const flow of flows) {
    if (flow.from === selectedPage) focused.add(flow.to)
    if (flow.to === selectedPage) focused.add(flow.from)
  }
  return focused
}

/** 将业务跳转渲染成独立 SVG 层。 */
function drawFlows() {
  const focused = buildFocusSet()
  const visibleNodeIds = new Set([...document.querySelectorAll('.page-node')].filter(node => !node.hidden).map(node => node.dataset.node))
  flowPaths.replaceChildren()
  flowLabels.replaceChildren()
  flows.forEach((flow, index) => {
    const { from, to, primary, action } = flow
    if (!visibleNodeIds.has(from) || !visibleNodeIds.has(to)) return
    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path')
    path.setAttribute('d', edgePath(from, to, index))
    const highlighted = Boolean(focused && (from === selectedPage || to === selectedPage))
    path.setAttribute('class', highlighted ? 'is-highlighted' : primary ? 'is-primary' : '')
    flowPaths.append(path)
    if (highlighted && action) {
      const point = path.getPointAtLength(path.getTotalLength() / 2)
      const label = document.createElement('span')
      label.className = 'flow-label'
      label.style.left = `${point.x}px`
      label.style.top = `${point.y}px`
      label.textContent = action
      flowLabels.append(label)
    }
  })
  document.querySelectorAll('.page-node').forEach(node => {
    const id = node.dataset.node
    const related = focused?.has(id) ?? false
    node.classList.toggle('is-selected', id === selectedPage)
    node.classList.toggle('is-related', id !== selectedPage && related)
    node.classList.toggle('is-dimmed', Boolean(focused) && !related)
    node.setAttribute('aria-pressed', String(id === selectedPage))
  })
}

/** 将原图最大边撑满 1:1 外壳，另一条边按比例收缩且不裁切。 */
function fillReferenceFrame(frame, reference) {
  frame.replaceChildren()
  if (reference.imageUrl) {
    const image = document.createElement('img')
    image.className = 'reference-image-content'
    image.src = reference.imageUrl
    image.alt = ''
    frame.append(image)
    return
  }
  const ratio = Math.max(.1, reference.aspectRatio ?? 4 / 3)
  const inner = document.createElement('span')
  inner.className = `reference-image-content ${reference.className ?? ''}`
  inner.style.width = `${ratio >= 1 ? 100 : 100 * ratio}%`
  inner.style.height = `${ratio >= 1 ? 100 / ratio : 100}%`
  frame.append(inner)
}

/** 渲染参考图缩略图外壳；上传文件使用 Object URL，离开页面时由浏览器释放。 */
function referenceImage(reference) {
  const frame = document.createElement('span')
  frame.className = 'reference-image'
  fillReferenceFrame(frame, reference)
  return frame
}

/** 为 inspector 模板中的占位节点填充同一套参考图视觉效果。 */
function hydrateReferenceFrames(root) {
  root.querySelectorAll('[data-reference-visual]').forEach(frame => {
    const reference = references.find(item => item.id === frame.dataset.referenceVisual)
    if (reference) fillReferenceFrame(frame, reference)
  })
}

/** 页面选中后同步目录、画布、页脚和 inspector。 */
function selectPage(pageId, options = {}) {
  const page = pages[pageId]
  if (!page) return
  selectedPage = pageId
  selectedReference = null
  document.querySelectorAll('.page-row').forEach(row => row.classList.toggle('is-selected', row.dataset.pageRow === pageId))
  drawFlows()
  renderPageInspector(page)
  document.querySelector('#canvasSelectionTitle').textContent = page.title
  document.querySelector('#canvasSelectionMeta').textContent = `${page.group} · ${page.states.length} 个状态 · ${flows.filter(flow => flow.from === pageId || flow.to === pageId).length} 条交互 · ${page.refs.length} 张参考图`
  const selectionThumbnail = document.querySelector('.selection-thumbnail')
  selectionThumbnail.className = `selection-thumbnail page-thumb-${pageId}`
  selectionThumbnail.setAttribute('role', 'img')
  selectionThumbnail.setAttribute('aria-label', `${page.title}页面预览`)
  document.querySelector('#previewPageTitle').textContent = page.title
  document.querySelector('#samplePageTitle').textContent = page.title
  document.querySelector('#previewGroup').textContent = page.group
  document.querySelector('#dialogPageName').textContent = page.title
  renderPreviewReferences(page)
  if (options.openPreview) activateView('preview')
}

/** 按 DutyDeck 原生信息层级生成页面 inspector。 */
function renderPageInspector(page) {
  const refs = page.refs.map(id => references.find(reference => reference.id === id)).filter(Boolean)
  const incoming = flows.filter(flow => flow.to === selectedPage)
  const outgoing = flows.filter(flow => flow.from === selectedPage)
  const body = document.querySelector('#inspectorBody')
  body.innerHTML = `
    <div class="inspector-head"><div class="inspector-title-block"><span class="node-thumbnail page-thumb-${selectedPage}" role="img" aria-label="${escapeHtml(page.title)}页面预览"></span><div><span class="section-kicker">选中页面</span><h2>${escapeHtml(page.title)}</h2></div></div><button class="icon-button icon-button-sm" aria-label="关闭详情">×</button></div>
    <div class="breadcrumb"><span>${escapeHtml(page.group)}</span><i>/</i><span>${escapeHtml(page.title)}</span><i>/</i><span>${escapeHtml(page.states[0])}</span></div>
    <section class="inspector-section">
      <div class="section-heading"><strong>层级关系</strong><button type="button" data-inspector-action="层级编辑">编辑</button></div>
      <div class="hierarchy-list">
        <div class="hierarchy-row"><span>分组</span><strong>${escapeHtml(page.group)}</strong><em>${page.groupKey === 'decision' ? '4 页' : '3 页'}</em></div>
        <div class="hierarchy-row"><span>页面</span><strong>${escapeHtml(page.title)}</strong><em>PAGE ${page.index}</em></div>
        <div class="hierarchy-row"><span>状态</span><strong>${escapeHtml(page.states.join(' · '))}</strong><em>${page.states.length} 个</em></div>
      </div>
    </section>
    <section class="inspector-section">
      <div class="section-heading"><strong>参考图</strong><button type="button" id="inspectorAttachReference">关联</button></div>
      <div class="inspector-ref-list">${refs.length ? refs.map(reference => `<button class="inspector-ref" data-inspector-reference="${reference.id}"><span class="reference-image" data-reference-visual="${reference.id}"></span><span class="inspector-ref-copy"><strong>${escapeHtml(reference.title)}</strong><small>${reference.typeLabel}参考 · ${escapeHtml(reference.source)}</small></span><span class="reference-role">${reference.typeLabel}</span></button>`).join('') : '<p class="inspector-muted">还没有关联参考图。</p>'}</div>
    </section>
    <section class="inspector-section">
      <div class="section-heading"><strong>跳转关系</strong><span>${incoming.length} 入 · ${outgoing.length} 出</span></div>
      ${[...incoming.map(flow => ({ direction: '←', page: flow.from, label: flow.action })), ...outgoing.map(flow => ({ direction: '→', page: flow.to, label: flow.action }))].map(item => `<button class="inspector-flow" data-inspector-page="${item.page}"><span class="flow-icon">${item.direction}</span><span><strong>${escapeHtml(pages[item.page].title)}</strong><small>${escapeHtml(item.label)}</small></span><em>${pages[item.page].group}</em></button>`).join('') || '<p class="inspector-muted">当前页面没有已声明交互。</p>'}
    </section>
    <section class="inspector-agent">
      <div class="agent-note"><svg viewBox="0 0 24 24"><path d="M12 3v3M12 18v3M3 12h3M18 12h3M5.6 5.6l2.1 2.1M16.3 16.3l2.1 2.1M18.4 5.6l-2.1 2.1M7.7 16.3l-2.1 2.1"/><circle cx="12" cy="12" r="3"/></svg><div><strong>让 Agent 整理这一组</strong><p>检查未连接动作、同名页面和遗漏状态，先生成候选。</p></div></div>
      <button class="button button-outline button-sm" id="inspectorAgentButton">引用当前层级到主会话</button>
    </section>`
  hydrateReferenceFrames(body)
  body.querySelector('#inspectorAttachReference')?.addEventListener('click', openReferenceDialog)
  body.querySelector('#inspectorAgentButton')?.addEventListener('click', () => showToast(`已准备引用「${page.title}」的层级、版本与参考图`))
  body.querySelectorAll('[data-inspector-reference]').forEach(button => button.addEventListener('click', () => selectReference(button.dataset.inspectorReference, { openViewer: true, returnFocus: button })))
  body.querySelectorAll('[data-inspector-page]').forEach(button => button.addEventListener('click', () => selectPage(button.dataset.inspectorPage)))
  body.querySelectorAll('[data-inspector-action]').forEach(button => button.addEventListener('click', () => showToast('层级编辑将在正式模块中生成候选改动')))
  body.querySelector('.inspector-head .icon-button')?.addEventListener('click', () => showToast('详情保留在当前页面，关闭入口待正式模块接入'))
}

/** 参考图作为独立对象选中，不改变当前业务页面。 */
function selectReference(referenceId, options = {}) {
  const reference = references.find(item => item.id === referenceId)
  if (!reference) return
  selectedReference = referenceId
  document.querySelectorAll('.reference-card').forEach(card => card.classList.toggle('is-selected', card.dataset.reference === referenceId))
  const relatedPages = Object.entries(pages).filter(([, page]) => page.refs.includes(referenceId))
  document.querySelector('#inspectorBody').innerHTML = `
    <div class="inspector-head"><div><span class="section-kicker">选中参考图</span><h2>${escapeHtml(reference.title)}</h2></div><button class="icon-button icon-button-sm" aria-label="关闭详情">×</button></div>
    <div class="breadcrumb"><span>参考图</span><i>/</i><span>${reference.typeLabel}</span><i>/</i><span>${escapeHtml(reference.source)}</span></div>
    <section class="inspector-section">
      <div class="section-heading"><strong>参考用途</strong><span>${reference.typeLabel}</span></div>
      <div class="reference-image inspector-reference-large" role="img" aria-label="${escapeHtml(reference.title)}" data-reference-visual="${reference.id}"></div>
      <p class="inspector-muted" style="margin-top:10px">参考图只描述视觉或结构依据，不代表页面和交互已经实现。</p>
    </section>
    <section class="inspector-section">
      <div class="section-heading"><strong>关联页面</strong><span>${relatedPages.length}</span></div>
      <div class="inspector-ref-list">${relatedPages.length ? relatedPages.map(([id, page]) => `<button class="inspector-ref" data-inspector-page="${id}"><span class="reference-role">页面</span><span class="inspector-ref-copy"><strong>${escapeHtml(page.title)}</strong><small>${escapeHtml(page.group)}</small></span><span>→</span></button>`).join('') : '<p class="inspector-muted">当前没有页面引用这张参考图。</p>'}</div>
    </section>`
  const body = document.querySelector('#inspectorBody')
  hydrateReferenceFrames(body)
  body.querySelectorAll('[data-inspector-page]').forEach(button => button.addEventListener('click', () => selectPage(button.dataset.inspectorPage)))
  document.querySelector('#inspectorBody .inspector-head .icon-button')?.addEventListener('click', () => selectPage(selectedPage))
  if (options.openViewer) openReferenceViewer(reference, options.returnFocus)
}

/** 参考图页签按搜索和类型筛选，结果为空时保留恢复入口。 */
function renderReferenceGrid() {
  const grid = document.querySelector('#referenceGrid')
  const query = document.querySelector('#referenceSearch').value.trim().toLowerCase()
  const type = document.querySelector('#referenceType').value
  const filtered = references.filter(reference => (type === 'all' || reference.type === type) && (!query || `${reference.title} ${reference.source}`.toLowerCase().includes(query)))
  grid.replaceChildren()
  filtered.forEach(reference => {
    const card = document.createElement('button')
    card.className = `reference-card${selectedReference === reference.id ? ' is-selected' : ''}`
    card.dataset.reference = reference.id
    card.setAttribute('aria-pressed', String(selectedReference === reference.id))
    const image = referenceImage(reference)
    image.setAttribute('role', 'img')
    image.setAttribute('aria-label', reference.title)
    const zoomHint = document.createElement('span')
    zoomHint.className = 'reference-zoom-hint'
    zoomHint.setAttribute('aria-hidden', 'true')
    zoomHint.textContent = '⤢'
    const copy = document.createElement('span')
    copy.className = 'reference-card-copy'
    copy.innerHTML = `<div><strong>${escapeHtml(reference.title)}</strong><small>${escapeHtml(reference.source)}</small></div><span class="reference-role">${reference.typeLabel}</span>`
    card.append(image, zoomHint, copy)
    card.addEventListener('click', () => selectReference(reference.id, { openViewer: true, returnFocus: card }))
    grid.append(card)
  })
  document.querySelector('#referenceEmpty').hidden = filtered.length > 0
  document.querySelector('#referenceSummary').textContent = `${references.length} 张参考图 · ${references.filter(reference => Object.values(pages).some(page => page.refs.includes(reference.id))).length} 张已关联`
  document.querySelector('#tabReferenceCount').textContent = String(references.length)
  renderDialogReferences()
}

/** 关联弹窗先暂存选择，确认后才更新演示数据。 */
function renderDialogReferences() {
  const grid = document.querySelector('#dialogReferenceGrid')
  grid.replaceChildren()
  references.forEach(reference => {
    const button = document.createElement('button')
    button.className = `dialog-reference-card${selectedDialogRefs.has(reference.id) ? ' is-selected' : ''}`
    button.dataset.reference = reference.id
    button.setAttribute('aria-pressed', String(selectedDialogRefs.has(reference.id)))
    button.append(referenceImage(reference))
    const title = document.createElement('strong')
    title.textContent = reference.title
    button.append(title)
    button.addEventListener('click', () => {
      if (selectedDialogRefs.has(reference.id)) selectedDialogRefs.delete(reference.id)
      else selectedDialogRefs.add(reference.id)
      renderDialogReferences()
    })
    grid.append(button)
  })
}

/** 预览页显示当前页面参考图，不使用彩色卡片抢过主预览。 */
function renderPreviewReferences(page) {
  const row = document.querySelector('#previewReferenceRow')
  row.replaceChildren()
  page.refs.slice(0, 3).forEach(id => {
    const reference = references.find(item => item.id === id)
    if (reference) row.append(referenceImage(reference))
  })
  const add = document.createElement('button')
  add.className = 'icon-button icon-button-sm'
  add.textContent = '+'
  add.setAttribute('aria-label', '关联参考图')
  add.addEventListener('click', openReferenceDialog)
  row.append(add)
}

/** 页签交互与 Radix Tabs 一致：方向键、Home 和 End 均可用。 */
function activateView(view, focusTab = false) {
  if (!panels[view]) return
  currentView = view
  tabs.forEach(tab => {
    const active = tab.dataset.view === view
    tab.setAttribute('aria-selected', String(active))
    tab.tabIndex = active ? 0 : -1
    if (active && focusTab) tab.focus()
  })
  Object.entries(panels).forEach(([key, panel]) => { panel.hidden = key !== view })
  if (view === 'canvas') requestAnimationFrame(() => {
    layoutCanvasNodes()
    fitCanvasToView()
    drawFlows()
  })
}

/** 使用固定定位菜单并支持方向键、Escape 和焦点返回。 */
function openMenu(owner, items) {
  closeMenu(false)
  menuOwner = owner
  actionMenu.replaceChildren()
  items.forEach(item => {
    if (item === '-') {
      const separator = document.createElement('div')
      separator.className = 'menu-separator'
      actionMenu.append(separator)
      return
    }
    if (item.label && !item.action) {
      const label = document.createElement('div')
      label.className = 'menu-label'
      label.textContent = item.label
      actionMenu.append(label)
      return
    }
    const button = document.createElement('button')
    button.type = 'button'
    button.setAttribute('role', 'menuitem')
    if (item.disabled) button.setAttribute('aria-disabled', 'true')
    button.innerHTML = item.icon ?? ''
    const text = document.createElement('span')
    text.style.marginLeft = '0'
    text.textContent = item.action
    button.append(text)
    if (item.shortcut) {
      const shortcut = document.createElement('span')
      shortcut.textContent = item.shortcut
      button.append(shortcut)
    }
    button.addEventListener('click', () => {
      if (item.disabled) return
      closeMenu()
      item.run?.()
    })
    actionMenu.append(button)
  })
  actionMenu.hidden = false
  const rect = owner.getBoundingClientRect()
  const width = actionMenu.offsetWidth
  const height = actionMenu.offsetHeight
  const left = Math.min(window.innerWidth - width - 8, Math.max(8, rect.right - width))
  const top = rect.bottom + 6 + height > window.innerHeight - 8 ? Math.max(8, rect.top - height - 6) : rect.bottom + 6
  actionMenu.style.left = `${left}px`
  actionMenu.style.top = `${top}px`
  actionMenu.querySelector('button:not([aria-disabled="true"])')?.focus()
}

function closeMenu(restoreFocus = true) {
  if (actionMenu.hidden) return
  actionMenu.hidden = true
  actionMenu.replaceChildren()
  if (restoreFocus) menuOwner?.focus()
  menuOwner = null
}

/** 页面行与图卡共用同一套页面操作菜单。 */
function openPageMenu(owner, pageId) {
  const page = pages[pageId]
  openMenu(owner, [
    { label: page.title },
    { action: '打开原型预览', shortcut: '↵', run: () => selectPage(pageId, { openPreview: true }) },
    { action: '复制页面', run: () => showToast('复制操作将在正式模块中生成新页面候选') },
    { action: '重命名', run: () => showToast('重命名入口复用模块输入弹窗') },
    { action: '移动到…', run: () => showToast('移动页面不会改变已有跳转关系') },
    '-',
    { action: page.entry ? '当前入口页' : '设为入口页', disabled: page.entry, run: () => showToast('入口页身份将在正式模块中原子保存') },
    { action: '删除页面', disabled: page.entry || Object.keys(pages).length <= 1, run: () => showToast('删除会先检查入站连接与入口保护') },
  ])
}

/** 统一轻量反馈，避免把保存类操作变成整页状态。 */
function showToast(message) {
  toast.textContent = message
  toast.classList.add('is-visible')
  window.clearTimeout(showToast.timer)
  showToast.timer = window.setTimeout(() => toast.classList.remove('is-visible'), 1800)
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character])
}

function setDirectoryOpen(open) {
  workspace.classList.toggle('directory-hidden', !open)
  directoryToggle.setAttribute('aria-expanded', String(open))
  const overlay = window.matchMedia('(max-width: 860px)').matches
  document.querySelector('#directoryBackdrop').hidden = !open || !overlay
  if (open && overlay) directory.querySelector('button, input')?.focus()
}

/** 关联弹窗沿用 Radix Dialog 的遮罩、Escape 与焦点返回语义。 */
function openReferenceDialog() {
  const dialog = document.querySelector('#referenceDialog')
  selectedDialogRefs = new Set(pages[selectedPage].refs)
  renderDialogReferences()
  dialogReturnFocus = document.activeElement
  dialog.showModal()
  document.querySelector('#closeReferenceDialog').focus()
}

function closeReferenceDialog() {
  const dialog = document.querySelector('#referenceDialog')
  if (dialog.open) dialog.close()
  dialogReturnFocus?.focus?.()
}

/** 参考图大图使用同一个方形视觉对象，点击卡片或 inspector 缩略图都可打开。 */
function openReferenceViewer(reference, returnFocus) {
  const dialog = document.querySelector('#referenceViewerDialog')
  const image = document.querySelector('#referenceViewerImage')
  referenceViewerReturnFocus = returnFocus ?? document.activeElement
  document.querySelector('#referenceViewerTitle').textContent = reference.title
  image.className = 'reference-image reference-viewer-image'
  fillReferenceFrame(image, reference)
  image.setAttribute('aria-label', reference.title)
  document.querySelector('#referenceViewerMeta').textContent = `${reference.typeLabel}参考 · ${reference.source}`
  dialog.showModal()
  document.querySelector('#closeReferenceViewer').focus()
}

function closeReferenceViewer() {
  const dialog = document.querySelector('#referenceViewerDialog')
  if (dialog.open) dialog.close()
}

applyReviewTheme()
const reviewParams = new URLSearchParams(window.location.search)
const reviewView = reviewParams.get('view')
const reviewPage = reviewParams.get('page')
applyDevice(reviewParams.get('device') ?? 'iphone-15-pro')
selectPage(reviewPage && pages[reviewPage] ? reviewPage : 'detail')
renderReferenceGrid()
updateCanvasTransform()
drawFlows()
activateView(['canvas', 'preview', 'references'].includes(reviewView ?? '') ? reviewView : 'preview')
if (window.matchMedia('(max-width: 860px)').matches) setDirectoryOpen(false)

tabs.forEach((tab, index) => {
  tab.addEventListener('click', () => activateView(tab.dataset.view))
  tab.addEventListener('keydown', event => {
    let nextIndex = null
    if (event.key === 'ArrowRight') nextIndex = (index + 1) % tabs.length
    if (event.key === 'ArrowLeft') nextIndex = (index - 1 + tabs.length) % tabs.length
    if (event.key === 'Home') nextIndex = 0
    if (event.key === 'End') nextIndex = tabs.length - 1
    if (nextIndex === null) return
    event.preventDefault()
    activateView(tabs[nextIndex].dataset.view, true)
  })
})

document.querySelectorAll('.page-select').forEach(button => button.addEventListener('click', () => selectPage(button.dataset.page)))
document.querySelectorAll('[data-page-menu]').forEach(button => button.addEventListener('click', event => {
  event.stopPropagation()
  openPageMenu(button, button.dataset.pageMenu)
}))
document.querySelectorAll('.page-node').forEach(node => {
  node.addEventListener('click', event => {
    if (event.target.closest('button')) return
    selectPage(node.dataset.node)
  })
  node.addEventListener('dblclick', () => selectPage(node.dataset.node, { openPreview: true }))
  node.addEventListener('keydown', event => {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault()
      selectPage(node.dataset.node)
    }
  })
})

document.querySelectorAll('.group-toggle').forEach(button => button.addEventListener('click', () => {
  const expanded = button.getAttribute('aria-expanded') === 'true'
  button.setAttribute('aria-expanded', String(!expanded))
  button.nextElementSibling.hidden = expanded
}))

document.querySelector('#pageSearch').addEventListener('input', event => {
  const query = event.target.value.trim().toLowerCase()
  Object.entries(pages).forEach(([id, page]) => {
    const row = document.querySelector(`[data-page-row="${id}"]`)
    if (row) row.hidden = Boolean(query) && !`${page.title} ${page.group} ${page.index}`.toLowerCase().includes(query)
  })
  let anyVisible = false
  document.querySelectorAll('.tree-group').forEach(group => {
    const visible = [...group.querySelectorAll('.page-row')].some(row => !row.hidden)
    group.hidden = !visible
    anyVisible ||= visible
  })
  document.querySelector('#pageSearchEmpty').hidden = anyVisible
})

document.querySelector('#clearPageSearch').addEventListener('click', () => {
  document.querySelector('#pageSearch').value = ''
  document.querySelector('#pageSearch').dispatchEvent(new Event('input'))
  document.querySelector('#pageSearch').focus()
})

document.querySelectorAll('[data-canvas-filter]').forEach(button => button.addEventListener('click', () => {
  document.querySelectorAll('[data-canvas-filter]').forEach(item => item.classList.toggle('is-active', item === button))
  const filter = button.dataset.canvasFilter
  let visibleCount = 0
  document.querySelectorAll('.page-node').forEach(node => {
    const visible = filter === 'all' || (filter === 'primary' && node.dataset.primary === 'true') || (filter === 'issues' && node.dataset.issue === 'true')
    node.hidden = !visible
    if (visible) visibleCount++
  })
  document.querySelector('#canvasEmpty').hidden = visibleCount > 0
  const visibleFlows = flows.filter(flow => !document.querySelector(`[data-node="${flow.from}"]`).hidden && !document.querySelector(`[data-node="${flow.to}"]`).hidden).length
  document.querySelector('#canvasTotal').textContent = `${visibleCount} 个页面 · ${visibleFlows} 条交互`
  drawFlows()
}))

document.querySelector('#resetCanvasFilter').addEventListener('click', () => document.querySelector('[data-canvas-filter="all"]').click())

document.querySelector('#zoomInButton').addEventListener('click', () => { zoom = Math.min(1.3, zoom + .08); updateCanvasTransform() })
document.querySelector('#zoomOutButton').addEventListener('click', () => { zoom = Math.max(.5, zoom - .08); updateCanvasTransform() })
document.querySelector('#zoomResetButton').addEventListener('click', () => { fitCanvasToView() })
document.querySelector('#fitCanvasButton').addEventListener('click', () => { fitCanvasToView(); showToast('已适应完整交互图') })
document.querySelector('#autoLayoutButton').addEventListener('click', () => { layoutCanvasNodes(); fitCanvasToView(); drawFlows(); showToast('已按交互关系重新排版，正式流程未被修改') })

canvasSurface.addEventListener('pointerdown', event => {
  if (event.target.closest('.page-node, .reference-pin, .canvas-empty')) return
  isPanning = true
  panStart = { x: event.clientX - pan.x, y: event.clientY - pan.y }
  canvasSurface.classList.add('is-panning')
  canvasSurface.setPointerCapture(event.pointerId)
})
canvasSurface.addEventListener('pointermove', event => {
  if (!isPanning || !panStart) return
  pan = { x: event.clientX - panStart.x, y: event.clientY - panStart.y }
  updateCanvasTransform()
})
canvasSurface.addEventListener('pointerup', () => {
  isPanning = false
  panStart = null
  canvasSurface.classList.remove('is-panning')
})

document.querySelector('#openSelectedPreview').addEventListener('click', () => selectPage(selectedPage, { openPreview: true }))
document.querySelector('#referenceSelectedPage').addEventListener('click', openReferenceDialog)
document.querySelector('[data-reference-pin]').addEventListener('click', () => { activateView('references'); selectReference('ref-structure-1') })

document.querySelector('#referenceSearch').addEventListener('input', renderReferenceGrid)
document.querySelector('#referenceType').addEventListener('change', renderReferenceGrid)
document.querySelector('#clearReferenceFilters').addEventListener('click', () => {
  document.querySelector('#referenceSearch').value = ''
  document.querySelector('#referenceType').value = 'all'
  renderReferenceGrid()
})
document.querySelector('#addReferenceButton').addEventListener('click', () => document.querySelector('#referenceUpload').click())
document.querySelector('#referenceUpload').addEventListener('change', event => addUploadedReferences([...event.target.files]))
document.querySelector('#referenceDropZone').addEventListener('dragover', event => { event.preventDefault(); event.currentTarget.classList.add('is-dragging') })
document.querySelector('#referenceDropZone').addEventListener('dragleave', event => event.currentTarget.classList.remove('is-dragging'))
document.querySelector('#referenceDropZone').addEventListener('drop', event => {
  event.preventDefault()
  event.currentTarget.classList.remove('is-dragging')
  addUploadedReferences([...event.dataTransfer.files])
})

/** 仅在当前原型中新增本地参考图缩略图，不上传或持久化文件。 */
function addUploadedReferences(files) {
  const images = files.filter(file => file.type.startsWith('image/'))
  images.forEach((file, index) => references.push({
    id: `local-${crypto.randomUUID()}`,
    title: file.name.replace(/\.[^.]+$/, ''),
    type: 'visual',
    typeLabel: '视觉',
    source: '本地上传',
    imageUrl: URL.createObjectURL(file),
  }))
  selectedReference = references.at(-1)?.id ?? selectedReference
  renderReferenceGrid()
  if (images.length) showToast(`已添加 ${images.length} 张参考图`)
}

document.querySelector('#directoryToggle').addEventListener('click', () => setDirectoryOpen(workspace.classList.contains('directory-hidden')))
document.querySelector('#closeDirectoryButton').addEventListener('click', () => setDirectoryOpen(false))
document.querySelector('#directoryBackdrop').addEventListener('click', () => setDirectoryOpen(false))
document.querySelector('#newPageButton').addEventListener('click', () => showToast('新建页面将复用模块输入弹窗'))
document.querySelector('#newGroupButton').addEventListener('click', () => showToast('新建分组不会改变现有页面路由'))
document.querySelector('#newRootGroup').addEventListener('click', () => showToast('新建分组不会改变现有页面路由'))

document.querySelector('#headerMoreButton').addEventListener('click', event => openMenu(event.currentTarget, [
  { action: '导入项目 HTML', run: () => showToast('HTML 将先作为候选导入，预览后采纳') },
  { action: '导入项目图片', run: () => showToast('图片将进入当前原型的资源清单') },
  { action: '编辑当前页面 HTML', run: () => showToast('HTML 编辑保存后会生成新版本') },
  '-',
  { action: '导出原型', run: () => showToast('导出使用当前已采纳版本') },
]))
document.querySelector('#historyButton').addEventListener('click', () => showToast('版本记录：v12 当前版本 · 2 个候选待处理'))
document.querySelector('#agentButton').addEventListener('click', () => showToast('已准备引用当前原型基线到主会话'))

document.querySelectorAll('[data-preview-mode]').forEach(button => button.addEventListener('click', () => {
  document.querySelectorAll('[data-preview-mode]').forEach(item => item.classList.toggle('is-active', item === button))
  showToast(button.dataset.previewMode === 'play' ? '体验模式：点击执行页面交互' : '选择修改：点击元素后引用到主会话')
}))
document.querySelector('#resetPreviewButton').addEventListener('click', () => showToast('已重新载入当前页面预览'))
document.querySelector('#previewDevice').addEventListener('change', event => {
  applyDevice(event.target.value)
  showToast(`页面缩略图已切换为 ${devices[event.target.value].label} 比例`)
})
document.querySelector('#focusPreviewButton').addEventListener('click', event => {
  const active = event.currentTarget.getAttribute('aria-pressed') === 'true'
  event.currentTarget.setAttribute('aria-pressed', String(!active))
  document.querySelector('.module-shell').classList.toggle('is-preview-focus', !active)
  showToast(active ? '已退出专注预览' : '已进入专注预览')
})
document.querySelector('#sampleCta').addEventListener('click', () => { document.querySelector('#previewState').textContent = '已满员'; document.querySelector('#sampleCta').textContent = '已满员 · 加入候补'; showToast('预览状态：已满员') })

document.querySelector('#referenceDialog').addEventListener('close', () => { dialogReturnFocus?.focus?.() })
document.querySelector('#closeReferenceDialog').addEventListener('click', closeReferenceDialog)
document.querySelector('#cancelReferenceDialog').addEventListener('click', closeReferenceDialog)
document.querySelector('#confirmReferenceDialog').addEventListener('click', () => {
  pages[selectedPage].refs = [...selectedDialogRefs]
  closeReferenceDialog()
  selectPage(selectedPage)
  renderReferenceGrid()
  showToast('参考图关联已更新')
})
document.querySelector('#closeReferenceViewer').addEventListener('click', closeReferenceViewer)
document.querySelector('#referenceViewerDialog').addEventListener('close', () => { referenceViewerReturnFocus?.focus?.() })
document.querySelector('#referenceViewerDialog').addEventListener('click', event => {
  if (event.target === event.currentTarget) closeReferenceViewer()
})

actionMenu.addEventListener('keydown', event => {
  const items = [...actionMenu.querySelectorAll('button:not([aria-disabled="true"])')]
  const index = items.indexOf(document.activeElement)
  if (event.key === 'Escape') { event.preventDefault(); closeMenu(); return }
  if (event.key === 'ArrowDown') { event.preventDefault(); items[(index + 1) % items.length]?.focus() }
  if (event.key === 'ArrowUp') { event.preventDefault(); items[(index - 1 + items.length) % items.length]?.focus() }
  if (event.key === 'Home') { event.preventDefault(); items[0]?.focus() }
  if (event.key === 'End') { event.preventDefault(); items.at(-1)?.focus() }
})

document.addEventListener('pointerdown', event => {
  if (!actionMenu.hidden && !actionMenu.contains(event.target) && !event.target.closest('[aria-haspopup="menu"]')) closeMenu(false)
})

document.addEventListener('keydown', event => {
  if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
    event.preventDefault()
    setDirectoryOpen(true)
    document.querySelector('#pageSearch').focus()
  }
  if (event.key === 'Escape') {
    if (!actionMenu.hidden) closeMenu()
    else if (document.querySelector('#referenceViewerDialog').open) closeReferenceViewer()
    else if (document.querySelector('#referenceDialog').open) closeReferenceDialog()
    else if (window.matchMedia('(max-width: 860px)').matches && !workspace.classList.contains('directory-hidden')) setDirectoryOpen(false)
  }
})

window.addEventListener('resize', () => {
  closeMenu(false)
  drawFlows()
  if (!window.matchMedia('(max-width: 860px)').matches) document.querySelector('#directoryBackdrop').hidden = true
})
