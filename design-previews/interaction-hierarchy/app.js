/** 原型页面的稳定身份数据；仅用于交互演示，不代表正式持久化结构。 */
const pages = {
  home: { title: '首页', group: '发现与探索', groupKey: 'discover', index: 'PAGE 01', states: '默认 · 加载中', refs: ['ref-02', 'ref-03'] },
  discover: { title: '发现活动', group: '发现与探索', groupKey: 'discover', index: 'PAGE 02', states: '默认', refs: ['ref-03'] },
  search: { title: '活动搜索', group: '发现与探索', groupKey: 'discover', index: 'PAGE 03', states: '默认', refs: ['ref-06'] },
  detail: { title: '活动详情', group: '浏览与决策', groupKey: 'decision', index: 'PAGE 04', states: '默认 · 已报名 · 已满员', refs: ['ref-01', 'ref-02'] },
  speakers: { title: '嘉宾阵容', group: '浏览与决策', groupKey: 'decision', index: 'PAGE 05', states: '默认', refs: ['ref-04'] },
  ticket: { title: '选择票种', group: '浏览与决策', groupKey: 'decision', index: 'PAGE 06', states: '默认', refs: ['ref-01', 'ref-04'] },
  signin: { title: '登录确认', group: '浏览与决策', groupKey: 'decision', index: 'STATE', states: '页面级弹层', refs: [] },
  confirm: { title: '订单确认', group: '报名与完成', groupKey: 'complete', index: 'PAGE 08', states: '默认', refs: ['ref-05'] },
  success: { title: '报名成功', group: '报名与完成', groupKey: 'complete', index: 'PAGE 09', states: '成功 · 待审核 · 失败', refs: ['ref-01'] },
  pass: { title: '我的票夹', group: '报名与完成', groupKey: 'complete', index: 'PAGE 10', states: '默认', refs: ['ref-06'] }
}

/** 参考图演示数据；真实模块需要绑定 assetId、hash 与关联角色。 */
const references = [
  { id: 'ref-01', title: '活动详情页结构', type: 'structure', label: '结构', source: 'Figma · 4 页', className: 'ref-thumb-01' },
  { id: 'ref-02', title: 'Neon Nights 视觉方向', type: 'visual', label: '视觉', source: 'Pinterest · 3 张', className: 'ref-thumb-02' },
  { id: 'ref-03', title: '发现页卡片栅格', type: 'structure', label: '结构', source: '竞品截图', className: 'ref-thumb-03' },
  { id: 'ref-04', title: '票务信息层级', type: 'copy', label: '文案', source: '活动复盘', className: 'ref-thumb-04' },
  { id: 'ref-05', title: '支付成功反馈', type: 'visual', label: '视觉', source: 'Mobbin', className: 'ref-thumb-05' },
  { id: 'ref-06', title: '票夹与凭证布局', type: 'structure', label: '结构', source: '本地参考', className: 'ref-thumb-06' }
]

/** 业务流程演示；画布只渲染，不允许通过拖线直接改写正式 Flow。 */
const flows = [
  ['home', 'discover', 'primary'],
  ['home', 'detail', 'primary'],
  ['discover', 'detail', 'primary'],
  ['search', 'detail', 'secondary'],
  ['detail', 'speakers', 'secondary'],
  ['detail', 'ticket', 'primary'],
  ['detail', 'success', 'secondary'],
  ['ticket', 'confirm', 'primary'],
  ['confirm', 'success', 'primary'],
  ['success', 'pass', 'primary'],
  ['pass', 'home', 'secondary']
]

let selectedPage = 'detail'
let selectedReference = null
let selectedDialogReferences = new Set()
let zoom = 0.86
let pan = { x: 0, y: 0 }
let isPanning = false
let panStart = null

const canvasWorld = document.querySelector('#canvasWorld')
const canvasViewport = document.querySelector('#canvasViewport')
const flowPaths = document.querySelector('#flowPaths')
const inspectorTitle = document.querySelector('#inspectorTitle')
const inspectorBreadcrumb = document.querySelector('#inspectorBreadcrumb')
const inspectorReferenceList = document.querySelector('#inspectorReferenceList')
const inspectorRefCount = document.querySelector('#inspectorRefCount')
const toast = document.querySelector('#toast')

/** 根据当前缩放与平移更新画布世界。 */
function updateCanvasTransform() {
  canvasWorld.style.transform = `translate(${pan.x}px, ${pan.y}px) scale(${zoom})`
  document.querySelector('#zoomReset').textContent = `${Math.round(zoom * 100)}%`
}

/** 从节点中心计算一条稳定的曲线路径。 */
function edgePath(from, to, index) {
  const source = document.querySelector(`[data-node="${from}"]`)
  const target = document.querySelector(`[data-node="${to}"]`)
  if (!source || !target) return ''
  const sx = source.offsetLeft + source.offsetWidth
  const sy = source.offsetTop + source.offsetHeight / 2
  const tx = target.offsetLeft
  const ty = target.offsetTop + target.offsetHeight / 2
  const bend = Math.max(18, Math.abs(tx - sx) * 0.44)
  const direction = tx >= sx ? 1 : -1
  const offset = (index % 3) * 5 * direction
  return `M ${sx} ${sy} C ${sx + bend + offset} ${sy}, ${tx - bend + offset} ${ty}, ${tx} ${ty}`
}

/** 将业务跳转绘制为独立 SVG，避免节点 DOM 结构被边缘关系污染。 */
function drawFlows() {
  flowPaths.replaceChildren()
  flows.forEach(([from, to, kind], index) => {
    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path')
    path.setAttribute('d', edgePath(from, to, index))
    path.setAttribute('class', kind)
    flowPaths.append(path)
  })
}

/** 更新右侧 inspector，并同步画布与目录中的选中状态。 */
function selectPage(pageId, options = {}) {
  if (!pages[pageId]) return
  selectedPage = pageId
  selectedReference = null
  const page = pages[pageId]
  document.querySelectorAll('.page-node').forEach(node => node.classList.toggle('is-selected', node.dataset.node === pageId))
  document.querySelectorAll('.page-row').forEach(row => row.classList.toggle('is-selected', row.dataset.page === pageId))
  inspectorTitle.textContent = page.title
  inspectorBreadcrumb.innerHTML = `<span>${page.group}</span><i>/</i><strong>${page.title}</strong><i>/</i><em>${page.states.split(' · ')[0]}</em>`
  renderInspectorReferences(page.refs)
  document.querySelector('#previewTitle').textContent = page.title
  document.querySelector('#dialogTargetName').textContent = page.title
  if (options.openPreview) {
    document.querySelector('[data-view="preview"]').click()
  }
}

/** 渲染目标页面已关联的参考图。 */
function renderInspectorReferences(ids) {
  inspectorRefCount.textContent = String(ids.length)
  inspectorReferenceList.replaceChildren()
  if (!ids.length) {
    const empty = document.createElement('p')
    empty.className = 'reference-empty'
    empty.textContent = '还没有关联参考图。'
    inspectorReferenceList.append(empty)
    return
  }
  ids.forEach(id => {
    const reference = references.find(item => item.id === id)
    if (!reference) return
    const button = document.createElement('button')
    button.className = 'inspector-ref'
    button.dataset.ref = reference.id
    button.innerHTML = `<span class="ref-preview ${reference.className}"></span><span class="ref-copy"><strong>${reference.title}</strong><small>${reference.label}参考 · ${reference.source}</small></span><span class="ref-role ${reference.type === 'visual' ? 'visual' : ''}">${reference.label}</span>`
    button.addEventListener('click', () => selectReference(reference.id))
    inspectorReferenceList.append(button)
  })
}

/** 将参考图作为独立对象选中，不改变当前业务页面。 */
function selectReference(referenceId) {
  const reference = references.find(item => item.id === referenceId)
  if (!reference) return
  selectedReference = referenceId
  document.querySelectorAll('.reference-card').forEach(card => card.classList.toggle('is-selected', card.dataset.ref === referenceId))
  document.querySelectorAll('.inspector-ref').forEach(row => row.classList.toggle('is-selected', row.dataset.ref === referenceId))
  inspectorTitle.textContent = reference.title
  inspectorBreadcrumb.innerHTML = `<span>参考图</span><i>/</i><strong>${reference.label}参考</strong><i>/</i><em>${reference.source}</em>`
  const relatedPages = Object.entries(pages).filter(([, page]) => page.refs.includes(referenceId))
  inspectorRefCount.textContent = String(relatedPages.length)
  inspectorReferenceList.innerHTML = relatedPages.length
    ? relatedPages.map(([id, page]) => `<button class="inspector-ref related-page" data-related-page="${id}"><span class="ref-preview ${page.refs[0] ? references.find(item => item.id === page.refs[0]).className : 'ref-thumb-03'}"></span><span class="ref-copy"><strong>${page.title}</strong><small>${page.group}</small></span><span class="ref-role">关联</span></button>`).join('')
    : '<p class="reference-empty">当前没有页面引用这张参考图。</p>'
  inspectorReferenceList.querySelectorAll('[data-related-page]').forEach(button => button.addEventListener('click', () => selectPage(button.dataset.relatedPage)))
  showToast(`已选中参考图：${reference.title}`)
}

/** 生成参考图图库与关联对话框；使用同一数据源避免两处状态漂移。 */
function renderReferenceLibrary() {
  const grid = document.querySelector('#referenceGrid')
  grid.replaceChildren()
  references.forEach(reference => {
    const card = document.createElement('button')
    card.className = 'reference-card'
    card.dataset.ref = reference.id
    card.dataset.type = reference.type
    card.innerHTML = `<span class="reference-image ${reference.className}"><i class="reference-type">${reference.label}</i></span><span class="reference-copy"><strong>${reference.title}</strong><span>${reference.source}</span></span>`
    card.addEventListener('click', () => selectReference(reference.id))
    grid.append(card)
  })
  renderDialogReferences()
}

/** 关系选择先暂存在弹窗内，确认后才修改页面关联。 */
function renderDialogReferences() {
  const grid = document.querySelector('#dialogRefGrid')
  grid.replaceChildren()
  references.forEach(reference => {
    const button = document.createElement('button')
    button.className = 'dialog-ref-card'
    button.dataset.ref = reference.id
    button.innerHTML = `<span class="reference-image ${reference.className}"></span><strong>${reference.title}</strong>`
    button.classList.toggle('is-selected', selectedDialogReferences.has(reference.id))
    button.addEventListener('click', () => {
      if (selectedDialogReferences.has(reference.id)) selectedDialogReferences.delete(reference.id)
      else selectedDialogReferences.add(reference.id)
      renderDialogReferences()
    })
    grid.append(button)
  })
}

/** 工具栏状态、空结果和提示使用统一反馈。 */
function showToast(message) {
  toast.textContent = message
  toast.classList.add('is-visible')
  window.clearTimeout(showToast.timer)
  showToast.timer = window.setTimeout(() => toast.classList.remove('is-visible'), 1900)
}

document.querySelectorAll('.page-row').forEach(row => row.addEventListener('click', () => selectPage(row.dataset.page)))
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

document.querySelectorAll('.view-tab').forEach(tab => tab.addEventListener('click', () => {
  document.querySelectorAll('.view-tab').forEach(item => item.classList.toggle('is-active', item === tab))
  const preview = tab.dataset.view === 'preview'
  document.querySelector('.canvas-header').hidden = preview
  document.querySelector('.canvas-toolbar').hidden = preview
  document.querySelector('#canvasViewport').hidden = preview
  document.querySelector('#previewView').hidden = !preview
}))

document.querySelectorAll('.library-tab').forEach(tab => tab.addEventListener('click', () => {
  document.querySelectorAll('.library-tab').forEach(item => {
    const active = item === tab
    item.classList.toggle('is-active', active)
    item.setAttribute('aria-selected', String(active))
  })
  document.querySelectorAll('[data-library-content]').forEach(content => content.hidden = content.dataset.libraryContent !== tab.dataset.library)
}))

document.querySelectorAll('[data-ref-filter]').forEach(chip => chip.addEventListener('click', () => {
  document.querySelectorAll('[data-ref-filter]').forEach(item => item.classList.toggle('is-active', item === chip))
  const filter = chip.dataset.refFilter
  document.querySelectorAll('.reference-card').forEach(card => card.hidden = filter !== 'all' && card.dataset.type !== filter)
}))

document.querySelector('#pageSearch').addEventListener('input', event => {
  const query = event.target.value.trim().toLowerCase()
  Object.entries(pages).forEach(([id, page]) => {
    const row = document.querySelector(`[data-page="${id}"]`)
    if (row) row.hidden = Boolean(query) && !`${page.title} ${page.group} ${page.index}`.toLowerCase().includes(query)
  })
  document.querySelectorAll('.tree-group').forEach(group => {
    const rows = [...group.querySelectorAll('.page-row')]
    group.hidden = rows.every(row => row.hidden)
  })
})

document.querySelectorAll('.group-heading').forEach(heading => heading.addEventListener('click', () => {
  const expanded = heading.getAttribute('aria-expanded') === 'true'
  heading.setAttribute('aria-expanded', String(!expanded))
  heading.querySelector('.chevron').textContent = expanded ? '›' : '⌄'
  const pagesContainer = heading.nextElementSibling
  pagesContainer.hidden = expanded
}))

document.querySelectorAll('.canvas-filter').forEach(chip => chip.addEventListener('click', () => {
  document.querySelectorAll('.canvas-filter').forEach(item => item.classList.toggle('is-active', item === chip))
  const filter = chip.dataset.filter
  document.querySelectorAll('.page-node').forEach(node => {
    const visible = filter === 'all' ||
      (filter === 'primary' && node.dataset.primary === 'true') ||
      (filter === 'issues' && node.dataset.issue === 'true')
    node.classList.toggle('is-filtered', !visible)
  })
  document.querySelector('#visibleNodeCount').textContent = String([...document.querySelectorAll('.page-node')].filter(node => !node.classList.contains('is-filtered')).length)
  showToast(filter === 'all' ? '显示全部页面' : filter === 'primary' ? '仅显示主流程' : '仅显示待处理项')
}))

document.querySelector('#zoomIn').addEventListener('click', () => { zoom = Math.min(1.25, zoom + 0.08); updateCanvasTransform() })
document.querySelector('#zoomOut').addEventListener('click', () => { zoom = Math.max(0.45, zoom - 0.08); updateCanvasTransform() })
document.querySelector('#zoomReset').addEventListener('click', () => { zoom = 0.86; pan = { x: 0, y: 0 }; updateCanvasTransform() })
document.querySelector('#fitCanvas').addEventListener('click', () => { zoom = 0.86; pan = { x: 0, y: 0 }; updateCanvasTransform(); showToast('已适应全部页面') })
document.querySelector('#autoLayoutButton').addEventListener('click', () => {
  document.querySelectorAll('.page-node').forEach(node => node.style.transform = '')
  drawFlows()
  showToast('已按分组重新排版，正式流程未被修改')
})

canvasViewport.addEventListener('pointerdown', event => {
  if (event.target.closest('.page-node') || event.target.closest('.canvas-legend') || event.target.closest('.reference-pin')) return
  isPanning = true
  panStart = { x: event.clientX - pan.x, y: event.clientY - pan.y }
  canvasViewport.classList.add('is-panning')
  canvasViewport.setPointerCapture(event.pointerId)
})
canvasViewport.addEventListener('pointermove', event => {
  if (!isPanning || !panStart) return
  pan = { x: event.clientX - panStart.x, y: event.clientY - panStart.y }
  updateCanvasTransform()
})
canvasViewport.addEventListener('pointerup', () => {
  isPanning = false
  panStart = null
  canvasViewport.classList.remove('is-panning')
})

document.addEventListener('keydown', event => {
  if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
    event.preventDefault()
    document.querySelector('[data-library="pages"]').click()
    document.querySelector('#pageSearch').focus()
  }
})

document.querySelector('#attachReferenceButton').addEventListener('click', () => {
  selectedDialogReferences = new Set(pages[selectedPage].refs)
  renderDialogReferences()
  document.querySelector('#referenceDialog').showModal()
})
document.querySelector('#closeDialogButton').addEventListener('click', () => document.querySelector('#referenceDialog').close())
document.querySelector('#cancelDialogButton').addEventListener('click', () => document.querySelector('#referenceDialog').close())
document.querySelector('#confirmDialogButton').addEventListener('click', () => {
  pages[selectedPage].refs = [...selectedDialogReferences]
  selectPage(selectedPage)
  document.querySelector('#referenceDialog').close()
  showToast('参考图关联已更新')
})
document.querySelector('.reference-dialog').addEventListener('click', event => {
  if (event.target === event.currentTarget) event.currentTarget.close()
})

document.querySelector('#agentButton').addEventListener('click', () => showToast('已准备引用当前原型基线到主会话'))
document.querySelector('#agentInspectorButton').addEventListener('click', () => showToast(`已准备引用 ${pages[selectedPage].title} 的层级与版本到主会话`))
document.querySelector('#exportButton').addEventListener('click', () => showToast('已生成当前版本的原型导出预览'))
document.querySelector('#historyButton').addEventListener('click', () => showToast('版本记录：v12 当前版本 · 2 个候选待处理'))
document.querySelector('#newGroupButton').addEventListener('click', () => showToast('新建分组将在正式模块中生成候选'))
document.querySelector('#addReferenceButton').addEventListener('click', () => document.querySelector('#referenceUpload').click())
document.querySelector('#referenceUpload').addEventListener('change', event => {
  const files = [...event.target.files]
  if (files.length) showToast(`已选择 ${files.length} 张参考图，正式模块将登录 assetId 与 hash`)
})
document.querySelector('#dropZone').addEventListener('dragover', event => {
  event.preventDefault()
  event.currentTarget.classList.add('is-dragging')
})
document.querySelector('#dropZone').addEventListener('dragleave', event => event.currentTarget.classList.remove('is-dragging'))
document.querySelector('#dropZone').addEventListener('drop', event => {
  event.preventDefault()
  event.currentTarget.classList.remove('is-dragging')
  showToast(`已接收 ${event.dataTransfer.files.length} 张参考图`)
})
document.querySelectorAll('.preview-actions [data-preview-state]').forEach(button => button.addEventListener('click', () => {
  document.querySelectorAll('.preview-actions [data-preview-state]').forEach(item => item.classList.toggle('is-active', item === button))
  const state = button.dataset.previewState
  const cta = document.querySelector('.prototype-cta')
  cta.textContent = state === 'joined' ? '已报名 · 查看电子票' : state === 'full' ? '已满员 · 加入候补' : '选择票种 · ¥168 起'
  document.querySelector('#inspectorBreadcrumb em').textContent = button.textContent
  document.querySelector('.hierarchy-stack div:nth-child(3) strong').textContent = button.textContent
  showToast(`预览状态：${button.textContent}`)
}))

renderReferenceLibrary()

/** 读取仅用于设计评审的 URL 初始状态，方便直接打开指定页面与预览状态。 */
const reviewParams = new URLSearchParams(window.location.search)
const initialPage = reviewParams.get('page')
selectPage(initialPage && pages[initialPage] ? initialPage : 'detail')
if (reviewParams.get('view') === 'preview') document.querySelector('[data-view="preview"]').click()
if (reviewParams.get('library') === 'references') document.querySelector('[data-library="references"]').click()
const initialPreviewState = ['default', 'joined', 'full'].includes(reviewParams.get('state') ?? '') ? reviewParams.get('state') : null
if (initialPreviewState) document.querySelector(`[data-preview-state="${initialPreviewState}"]`)?.click()
drawFlows()
updateCanvasTransform()

window.addEventListener('resize', drawFlows)
