import { dialog, ipcMain } from 'electron'
import { AGENT_IPC_CHANNELS } from '@dutydeck/shared'
import { AgentPluginManagementService } from './plugin-management-service'
import type { AgentPluginRegistry } from './plugin-registry'

/** 原生选择器限定本地清单来源；renderer 不能指定任意读写路径。 */
export function registerAgentPluginManagementIpc(registry: AgentPluginRegistry, isBusy: () => boolean): void {
  const service = new AgentPluginManagementService(registry, undefined, isBusy)
  ipcMain.handle(AGENT_IPC_CHANNELS.PREVIEW_AGENT_PLUGIN, async () => {
    const selection = await dialog.showOpenDialog({ title: '选择插件清单', properties: ['openFile'], filters: [{ name: '插件 JSON 清单', extensions: ['json'] }] })
    return selection.canceled || !selection.filePaths[0] ? null : service.preview(selection.filePaths[0])
  })
  ipcMain.handle(AGENT_IPC_CHANNELS.GET_AGENT_PLUGIN_CATALOG, () => service.snapshot())
  ipcMain.handle(AGENT_IPC_CHANNELS.REFRESH_AGENT_PLUGINS, () => service.refresh())
  ipcMain.handle(AGENT_IPC_CHANNELS.INSTALL_AGENT_PLUGIN, (_event, token: unknown) => {
    if (typeof token !== 'string') throw new Error('AGENT_PLUGIN_PREVIEW_INVALID')
    return service.install(token)
  })
  ipcMain.handle(AGENT_IPC_CHANNELS.UNINSTALL_AGENT_PLUGIN, (_event, pluginId: unknown) => {
    if (typeof pluginId !== 'string') throw new Error('AGENT_PLUGIN_ID_INVALID')
    return service.uninstall(pluginId)
  })
}
