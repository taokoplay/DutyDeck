import { atom } from 'jotai'

/** 每个 Agent 项目的浏览选择，正式数据仍由主进程保存。 */
export interface VisualProductionView {
  productionId: string | null
  episodeId: string | null
  shotId: string | null
  tab: 'project' | 'assets' | 'shots' | 'relations' | 'editing' | 'delivery' | 'configuration'
}
/** 仅保存轻量视图身份，不存媒体或业务正文。 */
export const visualProductionViewsAtom = atom<Record<string, VisualProductionView>>({})

/** 当前作品的关系画布现场；只存浏览状态，不触发正式版本变更。 */
export interface VisualRelationCanvasView {
  /** 切换作品时丢弃另一作品的节点坐标和筛选。 */
  productionId: string
  /** null 表示查看整部作品。 */
  episodeId: string | null
  /** 当前聚焦的图节点身份，包含类别前缀。 */
  selectedId: string | null
  /** 用户拖动的节点坐标；自动排版清空覆盖值。 */
  positions: Record<string, { x: number; y: number }>
  /** 返回画布时恢复上次缩放和平移。 */
  viewport?: { x: number; y: number; zoom: number }
}
/** 每个 Agent 项目只保留最近一个作品的画布现场，避免缓存所有作品。 */
export const visualRelationCanvasViewsAtom = atom<Record<string, VisualRelationCanvasView>>({})
