import { atom } from 'jotai'

/** 每个 Agent 项目的浏览选择，正式数据仍由主进程保存。 */
export interface VisualProductionView {
  productionId: string | null
  episodeId: string | null
  shotId: string | null
  tab: 'project' | 'assets' | 'shots' | 'relations' | 'delivery'
}
/** 仅保存轻量视图身份，不存媒体或业务正文。 */
export const visualProductionViewsAtom = atom<Record<string, VisualProductionView>>({})
