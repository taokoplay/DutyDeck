import { atom } from 'jotai'
import type { PluginCompatibilityReport, PluginMarketPage, PluginMarketApi, PluginMarketQuery } from '@dutydeck/shared'
export interface PluginMarketState {
  page: PluginMarketPage | null
  /** 与page一起提交，搜索草稿、组件重挂载不能改变该查询身份。 */
  query: PluginMarketQuery
  busy: boolean
  error: string | null
  detail: PluginCompatibilityReport | null
}
export const pluginMarketAtom = atom<PluginMarketState>({ page: null, query: { query: '', offset: 0, limit: 30 }, busy: false, error: null, detail: null })
export const pluginMarketSearchAtom = atom('')
export interface MarketAction { api: PluginMarketApi; kind: 'list' | 'refresh' | 'detail' | 'analyze'; query?: PluginMarketQuery; name?: string; version?: string }
function catalogError(code: string | null): string | null {
  if (!code) return null
  if (code === 'PLUGIN_CATALOG_COMMITTED_DURABILITY_UNCERTAIN') return '新快照已提交并显示，但磁盘持久性尚未确认；请检查存储状态后重新刷新。'
  if (code === 'PLUGIN_CATALOG_COMMITTED_BACKUP_DEGRADED') return '新快照已提交并显示，但备份写入失败；请检查存储状态。'
  return `目录更新失败（${code}）；保留上次成功缓存。`
}
export const runPluginMarketActionAtom = atom(null, async (get, set, action: MarketAction): Promise<void> => {
  const current = get(pluginMarketAtom)
  if (current.busy) return
  set(pluginMarketAtom, { ...current, busy: true, error: null })
  try {
    if (action.kind === 'analyze') {
      const target = current.detail
      if (!target || !action.version) throw new Error('缺少精确版本')
      const detail = await action.api.analyze({ name: target.entry.name, version: action.version, sourceUrl: target.sourceUrl, snapshotHash: target.snapshotHash })
      // 用户在联网期间关闭详情后，迟到响应不得重新打开或替换另一个详情。
      if (get(pluginMarketAtom).detail === target) set(pluginMarketAtom, { ...get(pluginMarketAtom), detail })
    } else if (action.kind === 'detail') {
      if (!current.page?.snapshotHash || !action.name) throw new Error('缺少目录快照')
      const detail = await action.api.detail({ name: action.name, sourceUrl: current.page.sourceUrl, snapshotHash: current.page.snapshotHash })
      set(pluginMarketAtom, { ...get(pluginMarketAtom), detail })
    } else {
      const query: PluginMarketQuery = action.kind === 'refresh'
        ? { query: '', offset: 0, limit: 30 }
        : { ...current.query, ...action.query }
      const page = action.kind === 'refresh' ? await action.api.refresh(current.page?.sourceUrl) : await action.api.list(query)
      set(pluginMarketAtom, { ...get(pluginMarketAtom), page, query: { ...query, sourceUrl: page.sourceUrl }, detail: null, error: catalogError(page.error) })
      if (action.kind === 'refresh') set(pluginMarketSearchAtom, '')
    }
  } catch {
    set(pluginMarketAtom, { ...get(pluginMarketAtom), error: action.kind === 'analyze' ? '包静态分析失败；可能不支持该归档、完整性校验失败或网络不可用。原诊断保持不变，可重试。' : '目录请求失败，请重试；上次成功缓存保持不变。' })
  } finally { set(pluginMarketAtom, { ...get(pluginMarketAtom), busy: false }) }
})
