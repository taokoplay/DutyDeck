import type { PrototypeDocument, PrototypeFlow, PrototypePage } from '@dutydeck/shared'

/** 页面视口尺寸；只决定画布缩略图比例，不改写设计原文。 */
export interface PrototypeCanvasViewport {
  width: number
  height: number
}

/** 画布页面节点；坐标是 renderer 派生值，不进入版本内容。 */
export interface PrototypeCanvasNode {
  id: string
  pageId: string
  page: PrototypePage
  column: number
  row: number
  x: number
  y: number
  width: number
  height: number
}

/** 画布业务边只来自正式 flows。 */
export interface PrototypeCanvasEdge {
  id: string
  flow: PrototypeFlow
  source: string
  target: string
}

/** 确定性流程布局结果。 */
export interface PrototypeCanvasLayout {
  nodes: PrototypeCanvasNode[]
  edges: PrototypeCanvasEdge[]
}

/**
 * 按页面真实视口比例和有向流程生成无分组画布。
 * @param document 当前原型版本。
 * @param viewport 当前预览设备视口。
 * @param nodeWidth 页面卡片宽度，单位为画布坐标。
 * @returns 入口在首列、后续页面按跳转层级展开的节点与边。
 */
export function buildPrototypeCanvasLayout(
  document: PrototypeDocument,
  viewport: PrototypeCanvasViewport,
  nodeWidth = 210,
): PrototypeCanvasLayout {
  /** 逻辑宽度固定，节点高度严格跟随当前设备比例。 */
  const nodeHeight = Math.round(nodeWidth * viewport.height / viewport.width)
  const columnGap = 92
  const rowGap = 42
  const pagesById = new Map(document.pages.map(page => [page.id, page]))
  const outgoing = new Map<string, PrototypeFlow[]>()
  for (const flow of document.flows) {
    if (!pagesById.has(flow.fromPageId) || !pagesById.has(flow.targetPageId)) continue
    outgoing.set(flow.fromPageId, [...(outgoing.get(flow.fromPageId) ?? []), flow])
  }

  /** 入口固定第一列，BFS 只用于推导阅读顺序，不改变正式跳转。 */
  const depths = new Map<string, number>([[document.entryPageId, 0]])
  const queue = [document.entryPageId]
  const visited = new Set<string>()
  while (queue.length) {
    const pageId = queue.shift()!
    if (visited.has(pageId)) continue
    visited.add(pageId)
    const depth = depths.get(pageId) ?? 0
    for (const flow of outgoing.get(pageId) ?? []) {
      const nextDepth = depth + 1
      if (flow.targetPageId === document.entryPageId) continue
      if ((depths.get(flow.targetPageId) ?? -1) < nextDepth) depths.set(flow.targetPageId, nextDepth)
      queue.push(flow.targetPageId)
    }
  }

  /** 没有任何入站的页面作为次级起点，避免消失或与入口挤在同一列。 */
  const incoming = new Set(document.flows.map(flow => flow.targetPageId))
  for (const page of document.pages) {
    if (!depths.has(page.id) && page.id !== document.entryPageId && !incoming.has(page.id)) depths.set(page.id, 1)
  }
  /** 仍不可达的页面放在末端，但保持稳定顺序。 */
  const knownMax = Math.max(0, ...depths.values())
  for (const page of document.pages) if (!depths.has(page.id)) depths.set(page.id, knownMax + 1)

  /** 同列按页面目录顺序堆叠，保证每次渲染结果一致。 */
  const columns = new Map<number, PrototypePage[]>()
  for (const page of document.pages) {
    const depth = depths.get(page.id) ?? 0
    columns.set(depth, [...(columns.get(depth) ?? []), page])
  }
  const nodes: PrototypeCanvasNode[] = []
  for (const [column, pages] of [...columns].sort(([left], [right]) => left - right)) {
    pages.forEach((page, row) => {
      nodes.push({
        id: page.id,
        pageId: page.id,
        page,
        column,
        row,
        x: column * (nodeWidth + columnGap),
        y: row * (nodeHeight + rowGap),
        width: nodeWidth,
        height: nodeHeight,
      })
    })
  }
  const edges = document.flows.map(flow => ({
    id: flow.id,
    flow,
    source: flow.fromPageId,
    target: flow.targetPageId,
  }))
  return { nodes, edges }
}
