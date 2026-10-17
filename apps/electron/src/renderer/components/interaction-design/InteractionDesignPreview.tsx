import * as React from 'react'
import { LoaderCircle, Minus, Plus, Scan } from 'lucide-react'
import type { PrototypeDraft } from '@dutydeck/shared'
import { buildPrototypePreview, parsePrototypePreviewMessage } from '@dutydeck/shared'

/** 预览只接受已冻结正文，所有消息仍需父页面校验来源与身份。 */
export interface InteractionDesignPreviewProps {
  /** 仅当前可见页面能加载、动画和上报交互；隐藏缓存保留 DOM。 */
  active: boolean
  draft: PrototypeDraft
  pageId: string
  revision: number
  identity: string
  mode: 'play' | 'select'
  device: 'mobile' | 'desktop'
  /** 用户选择的绝对比例；缺省自动适应。 */
  zoom?: number
  /** 更新当前项目的预览比例，undefined 恢复自动适应。 */
  onZoomChange: (zoom: number | undefined) => void
  assets: Record<string, string>
  /** 本轮尚未完成读取的资源，失败项已经结算，不阻塞页面展示。 */
  pendingAssets: string[]
  onSelect: (elementId: string, stateId?: string) => void
  onNavigate: (pageId: string) => void
}

/** 单个状态的沙箱参数；缩放只影响外框，不修改设计视口。 */
interface StatePreviewProps extends InteractionDesignPreviewProps {
  /** 缺省表示 page.html 默认状态。 */
  stateId?: string
  /** 状态显示名称，只有并排展示时显示。 */
  stateName: string
  /** 状态画板的统一缩放比例。 */
  scale: number
  /** 单状态沿用旧预览标题和布局。 */
  multiple: boolean
}

/** 每个状态拥有独立沙箱；页面目录和模式切换保持已加载的交互现场。 */
function StatePreview(props: StatePreviewProps): React.ReactElement {
  /** 隔离正文身份和临时体验实例；只重置或换版本才生成新令牌。 */
  const token = React.useMemo(() => crypto.randomUUID(), [props.identity, props.pageId, props.stateId])
  const frameRef = React.useRef<HTMLIFrameElement>(null)
  /** 默认状态随页面立即加载，附加状态首次进入滚动视区后再加载；已加载状态保留临时表单。 */
  const boardRef = React.useRef<HTMLDivElement>(null)
  const [loaded, setLoaded] = React.useState(!props.multiple || props.stateId === undefined)
  /** 正文与资源一次性冻结，其他画板的图片回流不重建本画板的脚本。 */
  const [html, setHtml] = React.useState<string>()
  /** 浏览器完成本画板的文档和图片加载前，保持独立加载反馈。 */
  const [ready, setReady] = React.useState(false)
  /** 导航失败提供可读反馈，避免只留下永久转圈。 */
  const [failed, setFailed] = React.useState(false)
  const callbacks = React.useRef(props)
  callbacks.current = props
  /** 每个状态只等待自己的图片，正文扫描只随冻结的设计身份变化。 */
  const assetIds = React.useMemo(() => {
    /** 当前画板正文与引用身份，不扫描其他状态的大型 HTML。 */
    const page = props.draft.pages.find(item => item.id === props.pageId)
    const content = props.stateId === undefined ? page?.html : page?.states?.find(state => state.id === props.stateId)?.html
    return new Set([...(content ?? '').matchAll(/prototype-asset:([A-Za-z0-9_-]+)/g)].map(match => match[1]!))
  }, [props.draft, props.pageId, props.stateId])
  /** 已挂载画板不再因同页其他资源的状态改变而撤销。 */
  const waitingForAssets = props.pendingAssets.some(id => assetIds.has(id))
  React.useEffect(() => {
    if (!props.active || !loaded || waitingForAssets || html !== undefined) return
    setHtml(buildPrototypePreview(props.draft, props.pageId, {
      mode: 'play', active: props.active, token, revision: props.revision, assets: props.assets, stateId: props.stateId,
    }))
  }, [props.active, loaded, waitingForAssets, html, props.draft, props.pageId, props.revision, props.assets, props.stateId, token])

  /** 模式切换走父端受控消息，避免重建页面丢失表单与交互状态。 */
  const syncMode = React.useCallback((): void => {
    frameRef.current?.contentWindow?.postMessage({ type: 'prototype-mode', token, mode: callbacks.current.mode }, '*')
  }, [token])
  React.useEffect(() => { syncMode() }, [props.mode, syncMode])
  /** 隐藏/恢复通过先行桥控制调度，不更换 srcDoc 或浏览上下文。 */
  const syncVisibility = React.useCallback((): void => {
    frameRef.current?.contentWindow?.postMessage({ type: 'prototype-visibility', token, active: callbacks.current.active }, '*')
  }, [token])
  React.useLayoutEffect(() => { syncVisibility() }, [props.active, syncVisibility])

  React.useEffect(() => {
    /** 延迟加载只作用于当前业务页面，不渲染目录内其他页面。 */
    const node = boardRef.current
    if (!node || loaded || !props.active) return
    const observer = new IntersectionObserver(entries => {
      if (entries.some(entry => entry.isIntersecting)) { setLoaded(true); observer.disconnect() }
    }, { root: node.closest('.id-preview-space'), rootMargin: '120px' })
    observer.observe(node)
    return () => observer.disconnect()
  }, [loaded, props.active])

  React.useEffect(() => {
    /** 只允许当前 iframe 当前文档的声明式消息；消息不能调用写入接口。 */
    const receive = (event: MessageEvent<unknown>): void => {
      if (!callbacks.current.active || event.source !== frameRef.current?.contentWindow) return
      const message = parsePrototypePreviewMessage(event.data)
      if (!message || message.token !== token || message.pageId !== props.pageId || message.revision !== props.revision || message.stateId !== props.stateId) return
      if (message.type === 'prototype-select' && callbacks.current.mode === 'select' && message.elementId) callbacks.current.onSelect(message.elementId, props.stateId)
      if (message.type === 'prototype-navigate' && callbacks.current.mode === 'play' && message.targetPageId && callbacks.current.draft.pages.some(page => page.id === message.targetPageId)) callbacks.current.onNavigate(message.targetPageId)
    }
    window.addEventListener('message', receive)
    return () => window.removeEventListener('message', receive)
  }, [token, props.pageId, props.revision, props.stateId])

  /** 缩放只改变外框几何，保留 iframe DOM 与表单临时状态。 */
  const width = props.device === 'mobile' ? 390 : 1280
  const height = props.device === 'mobile' ? 844 : 800
  return <div ref={boardRef} className={props.multiple ? 'id-state-board' : 'id-single-board'} data-state-id={props.stateId ?? ''} style={{ width: width * props.scale }}>
    {props.multiple && <div className="id-state-label">{props.stateName}</div>}
    <div className="id-device-frame" aria-busy={loaded && !ready && !failed} style={{ width: width * props.scale, height: height * props.scale }}>
      {html !== undefined && <iframe key={`${props.identity}:${props.pageId}:${props.stateId ?? 'default'}`} ref={frameRef} name={`prototype-state:${props.pageId}:${props.stateId ?? ''}`} title={props.multiple ? `${props.stateName}预览` : '当前原型预览'} sandbox="allow-scripts allow-forms" srcDoc={html} onLoad={() => { syncMode(); syncVisibility(); setReady(true) }} onError={() => setFailed(true)} style={{ width, height, transform: `scale(${props.scale})`, transformOrigin: 'top left' }} />}
      {!loaded ? <div className="id-state-placeholder">{props.stateName} · 滚动到此处加载</div> : failed ? <div className="id-preview-loading" role="alert">页面加载失败，请点击工具栏重新体验</div> : !ready && <div className="id-preview-loading" role="status" aria-label={`${props.stateName}加载中`}><LoaderCircle className="id-preview-spinner" size={22} aria-hidden="true" /><span>{waitingForAssets ? '正在加载图片…' : '正在加载页面…'}</span></div>}
    </div>
  </div>
}

/** 同一业务页面的状态在同一工作区平面展开；旧页面保持单画板体验。 */
export function InteractionDesignPreview(props: InteractionDesignPreviewProps): React.ReactElement {
  /** 可用空间与设计视口分开测量，目录浮层不参与布局。 */
  const spaceRef = React.useRef<HTMLDivElement>(null)
  const [bounds, setBounds] = React.useState({ width: 0, height: 0 })
  /** 隐藏时保留上次可见尺寸，防止 display:none 把缓存缩成零尺寸。 */
  const activeRef = React.useRef(props.active)
  activeRef.current = props.active
  /** 默认正文和附加状态共同构成当前页画板，不把状态变成目录页面。 */
  const page = props.draft.pages.find(item => item.id === props.pageId)
  const multiple = Boolean(page?.states?.length)
  const width = props.device === 'mobile' ? 390 : 1280
  const height = props.device === 'mobile' ? 844 : 800
  /** 多状态保证可读尺寸，超出空间后滚动；不把十几个画板缩成缩略图。 */
  const availableWidth = Math.max(1, bounds.width - 32)
  const columns = multiple ? Math.min((page?.states?.length ?? 0) + 1, Math.max(1, Math.floor((availableWidth + 24) / (props.device === 'mobile' ? 284 : 504)))) : 1
  /** 状态画板优先保证可读宽度；高度不足时滚动，避免窄屏把两台手机压成缩略图。 */
  const readableScale = (props.device === 'mobile' ? 260 : 480) / width
  const fitScale = multiple
    ? Math.max(0.05, Math.min(1, (availableWidth - (columns - 1) * 24) / columns / width, Math.max(readableScale, (bounds.height - 28) / height)))
    : Math.max(0.05, Math.min(1, availableWidth / width, (bounds.height - 24) / height))
  /** 手动缩放有界；设备宽高仍保持原设计尺寸。 */
  const scale = props.zoom === undefined ? fitScale : Math.max(0.1, Math.min(3, props.zoom))
  React.useEffect(() => {
    const node = spaceRef.current
    if (!node) return
    const observer = new ResizeObserver(([entry]) => {
      if (entry && activeRef.current && entry.contentRect.width > 0 && entry.contentRect.height > 0) setBounds({ width: entry.contentRect.width, height: entry.contentRect.height })
    })
    observer.observe(node)
    return () => observer.disconnect()
  }, [])
  React.useEffect(() => { spaceRef.current?.scrollTo(0, 0) }, [props.identity, props.pageId])
  return <div className="id-preview-viewport"><div className={`id-preview-space${multiple ? ' id-state-space' : ''}`} ref={spaceRef} aria-label={multiple ? '当前页面的状态画板' : '当前页面预览'}>
    <StatePreview {...props} key={`${props.identity}:${props.pageId}:default`} stateName={page?.defaultStateName ?? '默认状态'} scale={scale} multiple={multiple} />
    {page?.states?.map(state => <StatePreview {...props} key={`${props.identity}:${props.pageId}:state:${state.id}`} stateId={state.id} stateName={state.name} scale={scale} multiple={multiple} />)}
  </div><div className="id-zoom-controls" role="group" aria-label="预览缩放">
    <button aria-label="缩小预览" title="缩小预览" disabled={scale <= 0.1} onClick={() => props.onZoomChange(Math.max(0.1, (Math.round(scale * 10) - 1) / 10))}><Minus size={14} /></button>
    <button className="id-zoom-value" aria-label="原始尺寸预览" title="恢复 100% 原始尺寸" onClick={() => props.onZoomChange(1)}>{Math.round(scale * 100)}%</button>
    <button aria-label="放大预览" title="放大预览" disabled={scale >= 3} onClick={() => props.onZoomChange(Math.min(3, (Math.round(scale * 10) + 1) / 10))}><Plus size={14} /></button>
    <span className="id-rule" />
    <button className="id-zoom-fit" aria-label="适应预览区域" title="适应预览区域" aria-pressed={props.zoom === undefined} onClick={() => props.onZoomChange(undefined)}><Scan size={14} /><span>适应</span></button>
  </div></div>
}
