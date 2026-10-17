import type { Edge, Node } from '@xyflow/react'
import type { VisualProductionDocument, VisualProductionSnapshot } from '@proma/shared'

/** 三类节点共享正式对象身份；画布坐标与选中态不进入业务文档。 */
export interface VisualRelationData extends Record<string, unknown> {
  /** 对象类别决定详情入口与节点图标。 */
  kind: 'asset' | 'shot' | 'episode'
  /** 对应当前作品中的真实对象。 */
  entityId: string
  /** 用户可读名称。 */
  title: string
  /** 类型、集内序号或数量说明。 */
  subtitle: string
  /** 制作状态或引用数量。 */
  status: string
  /** 仅已采用但过期的画面显示更新提醒。 */
  needsUpdate: boolean
  /** 镜头所属集数，用于进入分镜定位。 */
  episodeId?: string
  /** 已采用媒体身份；选中节点后才读取预览。 */
  mediaId?: string | null
}

/** React Flow 节点仅承载展示数据，禁止携带生成操作。 */
export type VisualRelationNode = Node<VisualRelationData, 'visualRelation'>
/** 关系图由正式引用生成，坐标仅是可重置的默认排版。 */
export interface VisualRelationGraph {
  nodes: VisualRelationNode[]
  edges: Edge[]
}

/** 将作品转换为三列关系图；传入集数时仅保留该集引用，返回唯一节点和真实边。 */
export function buildVisualRelationGraph(document: VisualProductionDocument, shotStates: VisualProductionSnapshot['shotStates'], episodeId: string | null): VisualRelationGraph {
  /** 通过索引一次分组，避免为每个资产重复扫描所有镜头。 */
  const groupedShots = new Map(document.episodes.filter(episode => !episodeId || episode.id === episodeId).map(episode => [episode.id, [] as typeof document.shots]))
  /** 资产引用计数仅针对当前视图中的镜头。 */
  const assetUses = new Map<string, number>()
  /** 只为实际存在的资产生成边，不猜测缺失引用。 */
  const assetIds = new Set(document.assets.map(asset => asset.id))
  for (const shot of document.shots) {
    /** 无效集数或当前筛选以外的镜头不混入视图。 */
    const group = groupedShots.get(shot.episodeId)
    if (!group) continue
    group.push(shot)
    for (const id of new Set(shot.assetIds)) if (assetIds.has(id)) assetUses.set(id, (assetUses.get(id) ?? 0) + 1)
  }
  /** 资产、镜头、集数通过类别前缀隔离同名或相同 ID。 */
  const nodes: VisualRelationNode[] = []
  /** 边只表达资产引用和集数归属，不表达虚构的镜头执行顺序。 */
  const edges: Edge[] = []
  /** 每集预留至少一行，空集数也可访问。 */
  let row = 0
  for (const episode of document.episodes) {
    /** 镜头按正式文档中的集内顺序排列。 */
    const shots = groupedShots.get(episode.id)
    if (!shots) continue
    nodes.push({ id: `episode:${episode.id}`, type: 'visualRelation', position: { x: 640, y: row * 136 + Math.max(0, shots.length - 1) * 68 }, data: {
      kind: 'episode', entityId: episode.id, title: episode.title, subtitle: document.kind === 'image' ? '图片分组' : '集数', status: `${shots.length} 个${document.kind === 'image' ? '图片' : '镜头'}`, needsUpdate: false,
    } })
    shots.forEach((shot, index) => {
      /** 无输出优先显示未生成，不能因底层 needsUpdate 混同为过期画面。 */
      const needsUpdate = Boolean(shot.mediaId && shotStates[shot.id]?.needsUpdate)
      nodes.push({ id: `shot:${shot.id}`, type: 'visualRelation', position: { x: 320, y: (row + index) * 136 }, data: {
        kind: 'shot', entityId: shot.id, episodeId: episode.id, title: shot.title, subtitle: `${document.kind === 'image' ? '图片' : '镜头'} ${String(index + 1).padStart(2, '0')} · ${episode.title}`, status: !shot.mediaId ? '未生成' : needsUpdate ? '待更新' : '已采用', needsUpdate, mediaId: shot.mediaId,
      } })
      edges.push({ id: `membership:${shot.id}`, source: `shot:${shot.id}`, target: `episode:${episode.id}` })
      for (const assetId of new Set(shot.assetIds)) if (assetIds.has(assetId)) edges.push({ id: `reference:${assetId}:${shot.id}`, source: `asset:${assetId}`, target: `shot:${shot.id}` })
    })
    row += Math.max(1, shots.length) + 1
  }
  document.assets.filter(asset => !episodeId || assetUses.has(asset.id)).forEach((asset, index) => {
    nodes.push({ id: `asset:${asset.id}`, type: 'visualRelation', position: { x: 0, y: index * 136 }, data: {
      kind: 'asset', entityId: asset.id, title: asset.name, subtitle: asset.type, status: assetUses.has(asset.id) ? `${assetUses.get(asset.id)} 个引用${asset.locked ? ' · 已锁定' : ''}` : '尚未引用', needsUpdate: false, mediaId: asset.mediaId,
    } })
  })
  return { nodes, edges }
}

/** 选中资产向下追踪，选中集数向上追踪，镜头只显示自身输入与归属；返回高亮身份。 */
export function getVisualRelationFocus(graph: VisualRelationGraph, selectedId: string | null): Set<string> | null {
  /** 已删除或筛选外的选择不应使整张图变暗。 */
  const selected = graph.nodes.find(node => node.id === selectedId)
  if (!selected) return null
  /** 关系遍历只沿当前类别允许的方向，避免共享资产扩散到其他集数。 */
  const focused = new Set([selected.id])
  if (selected.data.kind === 'shot') {
    for (const edge of graph.edges) {
      if (edge.source === selected.id) focused.add(edge.target)
      if (edge.target === selected.id) focused.add(edge.source)
    }
    return focused
  }
  /** 最长两跳即可覆盖资产→镜头→集数，不做无界图遍历。 */
  for (let depth = 0; depth < 2; depth++) {
    /** 每轮冻结已有节点，保持方向一致且不受边数组排序影响。 */
    const prior = new Set(focused)
    for (const edge of graph.edges) {
      if (selected.data.kind === 'asset' && prior.has(edge.source)) focused.add(edge.target)
      if (selected.data.kind === 'episode' && prior.has(edge.target)) focused.add(edge.source)
    }
  }
  return focused
}
