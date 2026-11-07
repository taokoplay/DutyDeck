import { ipcMain } from 'electron'
import { PLUGIN_MARKET_IPC_CHANNELS, type PluginMarketQuery, type PluginPackageAnalysisQuery } from '@dutydeck/shared'
import type { PluginCatalogService } from './catalog/catalog-service'

/** 只注册只读列表/详情与用户主动刷新，不提供安装、脚本或包执行入口。 */
export function registerPluginMarketIpc(service: PluginCatalogService): void {
  ipcMain.handle(PLUGIN_MARKET_IPC_CHANNELS.LIST, (_event, query: PluginMarketQuery | undefined) => service.list(query))
  ipcMain.handle(PLUGIN_MARKET_IPC_CHANNELS.REFRESH, (_event, sourceUrl: string | undefined) => service.refresh(sourceUrl))
  ipcMain.handle(PLUGIN_MARKET_IPC_CHANNELS.ANALYZE, (_event, input: PluginPackageAnalysisQuery) => service.analyze(input))
  ipcMain.handle(PLUGIN_MARKET_IPC_CHANNELS.DETAIL, (_event, input: { sourceUrl?: string; name: string; snapshotHash: string }) => service.detail(input))
}
