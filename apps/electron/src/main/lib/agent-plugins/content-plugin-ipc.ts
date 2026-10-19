import { BrowserWindow, dialog, ipcMain } from 'electron'
import { CONTENT_PLUGIN_IPC_CHANNELS } from '@dutydeck/shared'
import { join } from 'node:path'
import { getConfigDir } from '../config-paths'
import { getDefaultDataRootInstanceLeaseRegistry } from '../data-root-instance-lease'
import type { AgentPluginRegistry } from '../agent-modules/plugin-registry'
import { ContentPluginService } from './content-plugin-service'
import { ContentPluginManager } from './content-plugin-manager'

/** 验收可注入隔离数据根和系统交互；生产默认始终使用正式目录及实例锁。 */
export interface ContentPluginIpcDependencies {
  root?: string
  leases?: Pick<ReturnType<typeof getDefaultDataRootInstanceLeaseRegistry>, 'acquireMigrationGuard' | 'hasOtherActiveLease'>
  selectPackage?: () => Promise<string | null>
}

/** 注册 V2 四层 IPC；renderer 无权指定读取路径，也不能打开未签名开发模式。 */
export function registerContentPluginIpc(registry: AgentPluginRegistry, isBusy: () => boolean, dependencies: ContentPluginIpcDependencies = {}): void {
  const service = new ContentPluginService(dependencies.root ?? join(getConfigDir(), 'plugin-packages-v2'), isBusy)
  const manager = new ContentPluginManager(service, registry, () => {
    for (const window of BrowserWindow.getAllWindows()) {
      try { if (!window.isDestroyed() && !window.webContents.isDestroyed()) window.webContents.send(CONTENT_PLUGIN_IPC_CHANNELS.CHANGED) }
      catch { /* 已提交的安装不能因窗口同时关闭而被误报失败；下次打开会重读快照。 */ }
    }
  })
  try { manager.initialize() } catch (error) { console.warn('[插件] 内容插件目录不可用，请在插件设置中检查', error) }
  /** 独占 intent 防止新的旧版/开发实例进入；发现另一个实例时保守拒绝变更。 */
  async function mutate<T>(operation: () => T): Promise<T> {
    const leases = dependencies.leases ?? getDefaultDataRootInstanceLeaseRegistry()
    const guard = await leases.acquireMigrationGuard()
    try {
      if (await leases.hasOtherActiveLease()) throw new Error('请关闭共享此数据目录的其他 DutyDeck 窗口后，再修改插件')
      if (isBusy()) throw new Error('Agent 正在运行或排队，请等待结束后再修改插件')
      return operation()
    } finally { guard.release() }
  }
  /** 入口参数均按真实类型和预算核验，拒绝原型对象或无限长字符串。 */
  function id(value: unknown): asserts value is string {
    if (typeof value !== 'string' || value.length === 0 || value.length > 256) throw new Error('插件身份无效')
  }
  function revision(value: unknown): asserts value is number {
    if (!Number.isSafeInteger(value) || Number(value) < 0) throw new Error('插件目录版本无效')
  }
  ipcMain.handle(CONTENT_PLUGIN_IPC_CHANNELS.GET, () => service.snapshot())
  ipcMain.handle(CONTENT_PLUGIN_IPC_CHANNELS.PREVIEW, async () => {
    if (dependencies.selectPackage) {
      const path = await dependencies.selectPackage()
      return path ? manager.preview(path) : null
    }
    const selection = await dialog.showOpenDialog({ title: '选择 DutyDeck 插件包', properties: ['openFile'], filters: [{ name: 'DutyDeck 插件包', extensions: ['ddplugin'] }] })
    return selection.canceled || !selection.filePaths[0] ? null : manager.preview(selection.filePaths[0])
  })
  ipcMain.handle(CONTENT_PLUGIN_IPC_CHANNELS.INSTALL, (_event, token: unknown, trustedKeyId: unknown) => {
    id(token)
    if (trustedKeyId !== undefined && (typeof trustedKeyId !== 'string' || !/^[a-f0-9]{64}$/.test(trustedKeyId))) throw new Error('发布者密钥指纹无效')
    return mutate(() => manager.install(token, trustedKeyId as string | undefined))
  })
  ipcMain.handle(CONTENT_PLUGIN_IPC_CHANNELS.SET_ENABLED, (_event, pluginId: unknown, enabled: unknown, expectedRevision: unknown) => {
    id(pluginId); revision(expectedRevision)
    if (typeof enabled !== 'boolean') throw new Error('插件开关无效')
    return mutate(() => manager.setEnabled(pluginId, enabled, expectedRevision))
  })
  ipcMain.handle(CONTENT_PLUGIN_IPC_CHANNELS.UNINSTALL, (_event, pluginId: unknown, expectedRevision: unknown) => {
    id(pluginId); revision(expectedRevision)
    return mutate(() => manager.uninstall(pluginId, expectedRevision))
  })
}
