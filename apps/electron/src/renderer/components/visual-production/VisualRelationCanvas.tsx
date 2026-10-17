import * as React from 'react'
import { useAtom } from 'jotai'
import { Background, BackgroundVariant, Handle, MarkerType, Position, ReactFlow, useNodesState } from '@xyflow/react'
import type { NodeChange, NodeProps, ReactFlowInstance } from '@xyflow/react'
import { Film, Folder, Layers, Maximize, Minus, Plus, RotateCcw, X } from 'lucide-react'
import type { VisualProductionSnapshot } from '@dutydeck/shared'
import { Button } from '@/components/ui/button'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { visualRelationCanvasViewsAtom, type VisualRelationCanvasView } from '@/atoms/visual-production-atoms'
import { buildVisualRelationGraph, getVisualRelationFocus, type VisualRelationData, type VisualRelationNode } from './visual-relation-graph'
import { VisualMediaView } from './VisualMediaView'
import '@xyflow/react/dist/style.css'
import './visual-relation-canvas.css'

/** 图卡保持轻量；大图只在选中后的预览区读取。 */
const VisualRelationCard = React.memo(function VisualRelationCard({ data, selected }: NodeProps<VisualRelationNode>): React.ReactElement {
  /** 类别使用形状与文字共同区分，避免依赖颜色。 */
  const Icon = data.kind === 'asset' ? Layers : data.kind === 'shot' ? Film : Folder
  return <div className="vp-relation-node" data-selected={selected} data-kind={data.kind}>
    {data.kind !== 'asset' && <Handle type="target" position={Position.Left} isConnectable={false} />}
    <div className="vp-relation-node-heading"><Icon size={14} aria-hidden="true" /><span title={data.subtitle}>{data.subtitle}</span></div>
    <strong title={data.title}>{data.title}</strong>
    <span className="vp-relation-node-status" data-warning={data.needsUpdate}>{data.status}</span>
    {data.kind !== 'episode' && <Handle type="source" position={Position.Right} isConnectable={false} />}
  </div>
})

/** 静态注册节点组件，避免缩放和数据刷新重建类型。 */
const RELATION_NODE_TYPES = { visualRelation: VisualRelationCard }
/** 与业务身份隔离的“全部”筛选值。 */
const ALL_EPISODES = '__all__'
/** 图的键盘提示沿用 React Flow 行为，使用中文说明。 */
const RELATION_ARIA = {
  'node.a11yDescription.default': '按 Enter 或空格选中节点，方向键调整位置，Escape 清除选择。选中后可通过下方按钮查看详情。',
  'node.a11yDescription.keyboardDisabled': '按 Enter 或空格选中节点，选中后可查看详情。',
  'node.a11yDescription.ariaLiveMessage': ({ direction, x, y }: { direction: string; x: number; y: number }) => `节点已${direction === 'left' ? '向左' : direction === 'right' ? '向右' : direction === 'up' ? '向上' : '向下'}移动，位置 ${Math.round(x)}，${Math.round(y)}`,
}

/** 画布只复用当前作品快照；详情和分镜导航仍由原工作台承接。 */
interface VisualRelationCanvasProps {
  /** 视图缓存与媒体权限所需的显式身份。 */
  projectId: string
  sessionId: string
  snapshot: VisualProductionSnapshot
  /** 宿主隐藏后停止选中媒体预览。 */
  active: boolean
  /** 复用资产详情弹窗。 */
  onOpenAsset: (id: string) => void
  /** 定位镜头或进入空集数。 */
  onOpenShots: (episodeId: string, shotId: string | null) => void
}

/** 资产→镜头→集数的交互关系画布，不允许通过拖线修改业务引用。 */
export function VisualRelationCanvas({ projectId, sessionId, snapshot, active, onOpenAsset, onOpenShots }: VisualRelationCanvasProps): React.ReactElement {
  /** 正式数据为唯一来源，刷新不覆盖用户的画布排版。 */
  const document = snapshot.document
  /** 浏览现场通过项目统一的 Jotai 状态在页签间保留。 */
  const [views, setViews] = useAtom(visualRelationCanvasViewsAtom)
  /** 不让另一作品的坐标与过滤条件泄漏到当前作品。 */
  const emptyView = React.useMemo<VisualRelationCanvasView>(() => ({ productionId: document.id, episodeId: null, selectedId: null, positions: {} }), [document.id])
  /** 删除集数后自动回到全部，避免显示不存在的筛选选项。 */
  const view = views[projectId]?.productionId === document.id ? views[projectId]! : emptyView
  /** 当前有效集数筛选。 */
  const episodeId = document.episodes.some(episode => episode.id === view.episodeId) ? view.episodeId : null
  /** 仅正式内容或集数变化时重建关系，不因任务轮询和拖动而重算。 */
  const graph = React.useMemo(() => buildVisualRelationGraph(document, snapshot.shotStates, episodeId), [document, snapshot.shotStates, episodeId])
  /** React Flow 的临时拖动状态不写业务文档。 */
  const [nodes, setNodes, applyNodeChanges] = useNodesState<VisualRelationNode>([])
  /** 工具栏通过实例操作视口，无需引入第二套画布系统。 */
  const [flow, setFlow] = React.useState<ReactFlowInstance<VisualRelationNode> | null>(null)
  /** 过滤/自动排版后的 fit 请求只执行一次；普通快照刷新不跳动画面。 */
  const fitPending = React.useRef(false)
  /** 事件回调写入当前作品对应的浏览状态。 */
  const updateView = React.useCallback((patch: Partial<VisualRelationCanvasView> | ((current: VisualRelationCanvasView) => Partial<VisualRelationCanvasView>)): void => {
    setViews(previous => {
      /** 用最新现场合并坐标，避免连续拖动被旧回调覆盖。 */
      const current = previous[projectId]?.productionId === document.id ? previous[projectId]! : emptyView
      return { ...previous, [projectId]: { ...current, ...(typeof patch === 'function' ? patch(current) : patch) } }
    })
  }, [projectId, document.id, emptyView, setViews])
  /** 鼠标拖动只在结束时保存；方向键移动也保留坐标，不在后台刷新时回弹。 */
  const onNodesChange = React.useCallback((changes: NodeChange<VisualRelationNode>[]): void => {
    applyNodeChanges(changes)
    /** XYFlow 的键盘位置事件没有拖动标志，鼠标移动过程则为 true。 */
    const positions: VisualRelationCanvasView['positions'] = {}
    for (const change of changes) if (change.type === 'position' && change.position && change.dragging !== true) positions[change.id] = change.position
    if (Object.keys(positions).length) updateView(current => ({ positions: { ...current.positions, ...positions } }))
  }, [applyNodeChanges, updateView])
  /** 聚焦范围只沿有向引用传播，避免共享资产误高亮整部作品。 */
  const focused = React.useMemo(() => getVisualRelationFocus(graph, view.selectedId), [graph, view.selectedId])
  /** 显示的选中对象必须仍存在于当前过滤图中。 */
  const selected = graph.nodes.find(node => node.id === view.selectedId)
  /** 预览最多读取当前选中节点的一份媒体。 */
  const media = snapshot.media.find(item => item.id === selected?.data.mediaId)
  /** 高亮实线表示选中链路；无动画避免长图持续占用 GPU。 */
  const edges = React.useMemo(() => graph.edges.map(edge => {
    /** 只高亮聚焦集合内部的真实边。 */
    const highlighted = !!focused && focused.has(edge.source) && focused.has(edge.target)
    return { ...edge, type: 'default', selectable: false, focusable: false, markerEnd: { type: MarkerType.ArrowClosed, color: highlighted ? 'hsl(var(--primary))' : 'hsl(var(--muted-foreground))' }, style: { stroke: highlighted ? 'hsl(var(--primary))' : 'hsl(var(--muted-foreground))', strokeWidth: highlighted ? 2 : 1, opacity: focused && !highlighted ? 0.12 : highlighted ? 1 : 0.45 } }
  }), [graph.edges, focused])

  React.useEffect(() => {
    setNodes(graph.nodes.map(node => ({ ...node, position: view.positions[node.id] ?? node.position, selected: node.id === view.selectedId, className: focused && !focused.has(node.id) ? 'vp-relation-dimmed' : '', ariaLabel: `${node.data.subtitle}，${node.data.title}，${node.data.status}`, width: 224, height: 108 })))
  }, [graph, view.positions, view.selectedId, focused, setNodes])
  React.useEffect(() => {
    if (!flow || !fitPending.current || nodes.length === 0) return
    /** 等待图节点提交布局后再计算边界，不使用固定延迟。 */
    const frame = requestAnimationFrame(() => { void flow.fitView({ padding: 0.15, maxZoom: 1 }); fitPending.current = false })
    return () => cancelAnimationFrame(frame)
  }, [flow, nodes])
  /** 将选中实体交给原有详情/导航，画布不复制表单与数据写入逻辑。 */
  const openNode = React.useCallback((data: VisualRelationData): void => {
    if (data.kind === 'asset') onOpenAsset(data.entityId)
    else onOpenShots(data.kind === 'episode' ? data.entityId : data.episodeId!, data.kind === 'shot' ? data.entityId : null)
  }, [onOpenAsset, onOpenShots])
  /** 筛选保留各节点手动位置；切换范围后重新定位可见图。 */
  const changeEpisode = (value: string): void => { fitPending.current = true; updateView({ episodeId: value === ALL_EPISODES ? null : value, selectedId: null, viewport: undefined }) }

  return <section className="vp-relation-canvas" aria-label="影像关系画布">
    <div className="vp-relation-toolbar">
      <Select value={episodeId ?? ALL_EPISODES} onValueChange={changeEpisode}>
        <SelectTrigger aria-label="画布集数" className="h-8 min-w-0 flex-1 max-w-64 gap-2 text-xs"><SelectValue /></SelectTrigger>
        <SelectContent><SelectItem value={ALL_EPISODES}>{document.kind === 'image' ? '全部分组' : '全部集数'}</SelectItem>{document.episodes.map(episode => <SelectItem key={episode.id} value={episode.id}>{episode.title}</SelectItem>)}</SelectContent>
      </Select>
      <div className="vp-relation-tools">
        <Button variant="ghost" size="icon" className="h-8 w-8" aria-label="缩小画布" title="缩小" onClick={() => void flow?.zoomOut()}><Minus size={15} /></Button>
        <Button variant="ghost" size="icon" className="h-8 w-8" aria-label="放大画布" title="放大" onClick={() => void flow?.zoomIn()}><Plus size={15} /></Button>
        <Button variant="ghost" size="icon" className="h-8 w-8" aria-label="适应全部节点" title="适应全部" onClick={() => void flow?.fitView({ padding: 0.15, maxZoom: 1 })}><Maximize size={15} /></Button>
        <Button variant="ghost" size="icon" className="h-8 w-8" aria-label="自动排版" title="自动排版" onClick={() => { fitPending.current = true; updateView({ positions: {}, viewport: undefined }) }}><RotateCcw size={15} /></Button>
      </div>
    </div>
    <div className="vp-relation-legend"><span><Layers size={12} />资产</span><span aria-hidden="true">→</span><span><Film size={12} />{document.kind === 'image' ? '图片' : '镜头'}</span><span aria-hidden="true">→</span><span><Folder size={12} />{document.kind === 'image' ? '分组' : '集数'}</span><span className="vp-relation-total">{graph.nodes.length} 个节点 · {graph.edges.length} 条关系</span></div>
    <div className="vp-relation-surface">
      {graph.nodes.length ? <ReactFlow<VisualRelationNode>
        nodes={nodes} edges={edges} nodeTypes={RELATION_NODE_TYPES} onNodesChange={onNodesChange} onInit={setFlow}
        minZoom={0.1} maxZoom={1.8} defaultViewport={view.viewport ?? { x: 24, y: 24, zoom: 0.75 }}
        nodesConnectable={false} edgesReconnectable={false} edgesFocusable={false} deleteKeyCode={null} selectionKeyCode={null} multiSelectionKeyCode={null}
        onNodeClick={(_, node) => updateView({ selectedId: node.id })}
        onNodeDoubleClick={(_, node) => openNode(node.data)}
        onPaneClick={() => updateView({ selectedId: null })}
        onNodeDragStop={(_, node) => updateView(current => ({ positions: { ...current.positions, [node.id]: node.position } }))}
        onMoveEnd={(_, viewport) => updateView({ viewport })}
        onKeyDownCapture={event => {
          if (event.key === 'Escape') updateView({ selectedId: null })
          if (event.key === 'Enter' || event.key === ' ') {
            /** 只由用户键盘事件更新业务选中态，避免受控节点的旧选中回调复活已清除的选择。 */
            const nodeId = event.target instanceof Element ? event.target.closest('.react-flow__node')?.getAttribute('data-id') : null
            if (nodeId) updateView({ selectedId: nodeId })
          }
        }}
        onlyRenderVisibleElements panOnScroll zoomOnScroll={false} zoomOnPinch zoomOnDoubleClick={false} preventScrolling
        ariaLabelConfig={RELATION_ARIA}
      ><Background variant={BackgroundVariant.Dots} gap={20} size={1} color="hsl(var(--border))" /></ReactFlow> : <div className="vp-relation-empty"><Layers size={24} /><strong>还没有制作关系</strong><p>添加资产与镜头并设置引用后，会在这里自动连接。</p></div>}
    </div>
    {selected ? <div className="vp-relation-selection" aria-live="polite">
      {active && media?.kind === 'image' && <VisualMediaView key={media.id} className="vp-relation-preview" sessionId={sessionId} productionId={document.id} media={media} active={active} />}
      <div className="vp-relation-selection-text"><strong title={selected.data.title}>{selected.data.title}</strong><span>{selected.data.status} · {focused ? focused.size - 1 : 0} 个关联节点</span></div>
      <Button variant="outline" size="sm" onClick={() => openNode(selected.data)}>{selected.data.kind === 'asset' ? '资产详情' : selected.data.kind === 'shot' ? '查看分镜' : '进入集数'}</Button>
      <Button variant="ghost" size="icon" className="h-7 w-7 shrink-0" aria-label="清除节点选择" onClick={() => updateView({ selectedId: null })}><X size={14} /></Button>
    </div> : <p className="vp-relation-hint">拖动空白处平移 · 选中节点查看关联 · 双击打开详情</p>}
  </section>
}
