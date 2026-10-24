import * as React from 'react'
import { Background, BackgroundVariant, Handle, MarkerType, Position, ReactFlow, useNodesState } from '@xyflow/react'
import type { NodeChange, NodeProps, ReactFlowInstance } from '@xyflow/react'
import type { Node as FlowNode } from '@xyflow/react'
import { ExternalLink, Image as ImageIcon, Maximize, Minus, Plus } from 'lucide-react'
import type { PrototypeAsset, PrototypeDocument, PrototypePage } from '@dutydeck/shared'
import { buildPrototypePreview, getPrototypeViewport } from '@dutydeck/shared'
import { Button } from '@/components/ui/button'
import { getPrototypeDevice, type PrototypeDeviceId } from './interaction-design-devices'
import { buildPrototypeCanvasLayout } from './interaction-design-canvas-model'
import { loadPrototypePreviewAssets, type PrototypePreviewAssetData } from './interaction-design-assets'
import '@xyflow/react/dist/style.css'
import './interaction-design.css'

/** 画布节点只渲染页面默认状态的静态首帧，不执行页面脚本。 */
interface InteractionCanvasNodeData extends Record<string, unknown> {
  page: PrototypePage
  document: PrototypeDocument
  revision: number
  deviceId: PrototypeDeviceId
  orientation: 'portrait' | 'landscape'
  assetMetadata: PrototypeAsset[]
  readAsset: (asset: PrototypeAsset) => Promise<PrototypePreviewAssetData>
  selected: boolean
  /** 画布卡片逻辑宽度，用于把真实页面视口等比缩入节点。 */
  width: number
  onOpen: (pageId: string) => void
}

/** React Flow 的交互页面节点。 */
type InteractionCanvasNode = FlowNode<InteractionCanvasNodeData, 'interactionPage'>

/** 页面卡片使用与真实视口一致的纵横比，标题和元数据覆盖在图片首帧上。 */
const InteractionCanvasCard = React.memo(function InteractionCanvasCard({ data }: NodeProps<InteractionCanvasNode>): React.ReactElement {
  const rootRef = React.useRef<HTMLDivElement>(null)
  const [visible, setVisible] = React.useState(false)
  const [assetUrls, setAssetUrls] = React.useState<Record<string, string>>({})
  const [failed, setFailed] = React.useState(false)
  const viewport = getPrototypeViewport(data.document, data.page.presentation, data.deviceId, data.orientation)
  const token = React.useMemo(() => crypto.randomUUID(), [data.document.id, data.document.revision, data.page.id])
  const pageAssetIds = React.useMemo(() => new Set(
    [data.page.html, ...(data.page.states ?? []).map(state => state.html)]
      .flatMap(html => [...html.matchAll(/prototype-asset:([A-Za-z0-9_-]+)/g)].map(match => match[1]!)),
  ), [data.page])
  const pageAssets = React.useMemo(() => data.assetMetadata.filter(asset => pageAssetIds.has(asset.id)), [data.assetMetadata, pageAssetIds])
  const pending = pageAssets.filter(asset => !Object.hasOwn(assetUrls, asset.id)).length > 0

  React.useEffect(() => {
    const node = rootRef.current
    if (!node || typeof IntersectionObserver === 'undefined') { setVisible(true); return }
    const observer = new IntersectionObserver(entries => {
      if (entries.some(entry => entry.isIntersecting)) { setVisible(true); observer.disconnect() }
    }, { rootMargin: '240px' })
    observer.observe(node)
    return () => observer.disconnect()
  }, [])

  React.useEffect(() => {
    if (!visible) return
    let disposed = false
    void loadPrototypePreviewAssets({
      assets: pageAssets,
      read: data.readAsset,
      isCurrent: () => !disposed,
      onSettled: (asset, outcome) => {
        if (outcome.status === 'fulfilled' && outcome.value.assetId === asset.id) {
          setAssetUrls(previous => ({ ...previous, [asset.id]: outcome.value.dataUrl }))
        } else {
          setFailed(true)
          setAssetUrls(previous => ({ ...previous, [asset.id]: '' }))
        }
      },
    })
    return () => { disposed = true }
  }, [data.readAsset, pageAssets, visible])

  const html = React.useMemo(() => {
    if (!visible || pending || failed) return ''
    try {
      return buildPrototypePreview(data.document, data.page.id, {
        mode: 'play', active: true, token, revision: data.revision, assets: assetUrls,
        deviceId: data.deviceId, orientation: data.orientation,
      })
    } catch {
      return ''
    }
  }, [assetUrls, data.deviceId, data.document, data.orientation, data.page.id, data.revision, failed, pending, token, visible])
  const scale = data.width / viewport.width
  return <div ref={rootRef} className="id-canvas-page-node" data-selected={data.selected}>
    <Handle type="target" position={Position.Left} isConnectable={false} />
    <div className="id-canvas-page-preview" aria-hidden="true">
      {html
        ? <iframe
            title={`${data.page.name}静态缩略图`}
            srcDoc={html}
            sandbox=""
            tabIndex={-1}
            style={{ width: viewport.width, height: viewport.height, transform: `scale(${scale})` }}
          />
        : <div className="id-canvas-page-loading">{failed ? '页面缩略图读取失败' : '正在生成页面缩略图'}</div>}
    </div>
    <div className="id-canvas-page-heading"><strong>{data.page.name}</strong><small>{data.page.route ?? data.page.role ?? data.page.id}</small></div>
    <div className="id-canvas-page-footer"><span>{data.page.states?.length ? `${data.page.states.length + 1} 状态` : '默认状态'}</span><button onClick={event => { event.stopPropagation(); data.onOpen(data.page.id) }} aria-label={`打开${data.page.name}`}>打开</button></div>
    <Handle type="source" position={Position.Right} isConnectable={false} />
  </div>
})

const NODE_TYPES = { interactionPage: InteractionCanvasCard }

/** 画布组件输入；所有数据来自当前正式版本或候选正文。 */
export interface InteractionDesignCanvasProps {
  document: PrototypeDocument
  assets: PrototypeAsset[]
  revision: number
  active: boolean
  deviceId: PrototypeDeviceId
  orientation?: 'portrait' | 'landscape'
  selectedPageId: string | null
  /** 受控资产读取，和原型预览共用会话授权与并发上限。 */
  readAsset: (asset: PrototypeAsset) => Promise<PrototypePreviewAssetData>
  onSelectPage: (pageId: string) => void
  onOpenPage: (pageId: string) => void
  onOpenReferences: (pageId: string) => void
}

/** 无分组交互图：页面节点和正式跳转边是唯一结构，页面图为无脚本首帧。 */
export function InteractionDesignCanvas(props: InteractionDesignCanvasProps): React.ReactElement {
  const orientation = props.orientation ?? props.document.pages.find(page => page.id === props.selectedPageId)?.presentation?.orientation ?? 'portrait'
  const viewport = React.useMemo(() => getPrototypeViewport(props.document, undefined, props.deviceId, orientation), [orientation, props.deviceId, props.document])
  const graph = React.useMemo(() => buildPrototypeCanvasLayout(props.document, viewport, 210), [props.document, viewport])
  const [nodes, setNodes, onNodesChange] = useNodesState<InteractionCanvasNode>([])
  const [flow, setFlow] = React.useState<ReactFlowInstance<InteractionCanvasNode> | null>(null)
  const fitPending = React.useRef(true)

  React.useEffect(() => {
    setNodes(graph.nodes.map(node => ({
      id: node.id,
      type: 'interactionPage',
      position: { x: node.x, y: node.y },
      width: node.width,
      height: node.height,
      selected: node.pageId === props.selectedPageId,
      data: {
        page: node.page,
        document: props.document,
        revision: props.revision,
        deviceId: props.deviceId,
        orientation,
        assetMetadata: props.assets,
        readAsset: props.readAsset,
        selected: node.pageId === props.selectedPageId,
        onOpen: props.onOpenPage,
        width: node.width,
      },
    })))
  }, [graph.nodes, onNodesChange, orientation, props.assets, props.deviceId, props.document, props.onOpenPage, props.readAsset, props.revision, props.selectedPageId, setNodes])

  React.useEffect(() => {
    if (!flow || !fitPending.current) return
    const frame = requestAnimationFrame(() => { void flow.fitView({ padding: .14, maxZoom: .9 }); fitPending.current = false })
    return () => cancelAnimationFrame(frame)
  }, [flow, nodes])

  const edges = React.useMemo(() => graph.edges.map(edge => {
    const selected = props.selectedPageId === edge.source || props.selectedPageId === edge.target
    return {
      ...edge,
      type: 'smoothstep',
      label: `点击 ${edge.flow.elementId}`,
      markerEnd: { type: MarkerType.ArrowClosed, color: selected ? 'hsl(var(--primary))' : 'hsl(var(--muted-foreground))' },
      style: { stroke: selected ? 'hsl(var(--primary))' : 'hsl(var(--muted-foreground))', strokeWidth: selected ? 2 : 1, opacity: selected ? 1 : .46 },
    }
  }), [graph.edges, props.selectedPageId])
  const selectedPage = props.document.pages.find(page => page.id === props.selectedPageId)
  const selectedRefCount = (props.document.references ?? []).filter(reference => reference.usages.some(usage => usage.pageId === props.selectedPageId)).length
  const device = getPrototypeDevice(props.deviceId, props.document.platform, orientation)

  return <section className="id-canvas-view" aria-label="交互图">
    <div className="id-canvas-toolbar">
      <span><strong>{device.id}</strong><small>{device.width} × {device.height}</small></span>
      <div className="id-canvas-tools">
        <Button variant="ghost" size="icon-sm" aria-label="缩小画布" onClick={() => void flow?.zoomOut()}><Minus size={15} /></Button>
        <Button variant="ghost" size="icon-sm" aria-label="放大画布" onClick={() => void flow?.zoomIn()}><Plus size={15} /></Button>
        <Button variant="ghost" size="icon-sm" aria-label="适应全部页面" onClick={() => void flow?.fitView({ padding: .14, maxZoom: .9 })}><Maximize size={15} /></Button>
      </div>
    </div>
    <div className="id-canvas-stage">
      <ReactFlow<InteractionCanvasNode>
        nodes={nodes}
        edges={edges}
        nodeTypes={NODE_TYPES}
        onNodesChange={onNodesChange}
        onInit={setFlow}
        onNodeClick={(_, node) => props.onSelectPage(node.id)}
        onNodeDoubleClick={(_, node) => props.onOpenPage(node.id)}
        nodesDraggable={false}
        nodesConnectable={false}
        edgesReconnectable={false}
        edgesFocusable={false}
        deleteKeyCode={null}
        selectionKeyCode={null}
        multiSelectionKeyCode={null}
        minZoom={.2}
        maxZoom={1.4}
        onlyRenderVisibleElements
        panOnScroll
        zoomOnDoubleClick={false}
      ><Background variant={BackgroundVariant.Dots} gap={20} size={1} color="hsl(var(--border))" /></ReactFlow>
    </div>
    {selectedPage && <footer className="id-canvas-selection">
      <ImageIcon size={14} />
      <div><strong>{selectedPage.name}</strong><span>{selectedPage.route ?? selectedPage.role ?? selectedPage.id} · {selectedPage.states?.length ? `${selectedPage.states.length + 1} 状态` : '默认状态'} · {selectedRefCount} 张参考图</span></div>
      <Button variant="outline" size="sm" onClick={() => props.onOpenReferences(selectedPage.id)}>参考图</Button>
      <Button size="sm" onClick={() => props.onOpenPage(selectedPage.id)}><ExternalLink size={14} />打开预览</Button>
    </footer>}
  </section>
}
