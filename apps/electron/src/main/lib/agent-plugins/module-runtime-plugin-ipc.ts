import { BrowserWindow, dialog, ipcMain } from 'electron'
import {
  MODULE_RUNTIME_PLUGIN_IPC_CHANNELS,
  type AgentSessionModulePolicy,
  type CloseModuleRuntimeSurfaceInput,
  type InstalledModuleRuntimePluginView,
  type InvokeModuleRuntimeSurfaceInput,
  type ModuleRuntimePluginPreviewView,
  type ModuleRuntimePluginSnapshotView,
  type OpenModuleRuntimeSurfaceInput,
  type OpenModuleRuntimeSurfaceResult,
} from '@dutydeck/shared'
import type { ModuleRuntimeManager } from './module-runtime-manager'
import type { ModuleRuntimePluginService } from './module-runtime-plugin-service'

/** IPC 依赖由主进程组合根提供，renderer 不能替换路径或 trust 状态。 */
export interface ModuleRuntimePluginIpcOptions {
  service: ModuleRuntimePluginService
  manager: ModuleRuntimeManager
  requireVisibleSession: (sessionId: string) => { id: string; workspaceId?: string }
  getSessionPolicy: (sessionId: string) => AgentSessionModulePolicy
  selectPackage?: () => Promise<string | null>
}

/** 剔除包根路径，只向 renderer 发布可展示目录。 */
function snapshotView(snapshot: ReturnType<ModuleRuntimePluginService['snapshot']>): ModuleRuntimePluginSnapshotView {
  return {
    revision: snapshot.revision,
    plugins: snapshot.plugins.map((plugin): InstalledModuleRuntimePluginView => ({
      manifest: plugin.manifest,
      packageHash: plugin.packageHash,
      ...(plugin.keyId ? { keyId: plugin.keyId } : {}),
      enabled: plugin.enabled,
      installedAt: plugin.installedAt,
    })),
  }
}

/** 通知所有仍存活窗口重读目录；已经提交的变化不改报失败。 */
function publishChanged(): void {
  for (const window of BrowserWindow.getAllWindows()) {
    try {
      if (!window.isDestroyed() && !window.webContents.isDestroyed()) {
        window.webContents.send(MODULE_RUNTIME_PLUGIN_IPC_CHANNELS.CHANGED)
      }
    } catch {
      // 下次打开窗口会重新读取权威快照。
    }
  }
}

/** 校验 renderer 提供的身份与 revision，不接受任意路径或对象。 */
function assertId(value: unknown): asserts value is string {
  if (typeof value !== 'string' || !/^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/.test(value) || value.length > 256) {
    throw new Error('PLUGIN_ID_INVALID')
  }
}

/** 预览与 Surface token 使用宿主生成的 UUID 形态。 */
function assertToken(value: unknown): asserts value is string {
  if (typeof value !== 'string' || !/^[a-f0-9-]{20,64}$/i.test(value)) throw new Error('PLUGIN_TOKEN_INVALID')
}

/** 注册 V3 插件管理四层 IPC；安装和 Surface 调用均复用主进程可信目录。 */
export function registerModuleRuntimePluginIpc(options: ModuleRuntimePluginIpcOptions): void {
  const { service, manager } = options
  void service.initialize().then(publishChanged).catch(() => undefined)
  ipcMain.handle(MODULE_RUNTIME_PLUGIN_IPC_CHANNELS.GET, async (): Promise<ModuleRuntimePluginSnapshotView> => {
    await service.initialize()
    return snapshotView(service.snapshot())
  })
  ipcMain.handle(MODULE_RUNTIME_PLUGIN_IPC_CHANNELS.PREVIEW, async (): Promise<ModuleRuntimePluginPreviewView | null> => {
    await service.initialize()
    const selected = options.selectPackage
      ? await options.selectPackage()
      : await dialog.showOpenDialog({ title: '选择 DutyDeck 可执行模块插件', properties: ['openFile'], filters: [{ name: 'DutyDeck 插件包', extensions: ['ddplugin'] }] })
        .then(result => result.canceled ? null : result.filePaths[0] ?? null)
    if (!selected) return null
    return service.preview(selected)
  })
  ipcMain.handle(MODULE_RUNTIME_PLUGIN_IPC_CHANNELS.INSTALL, async (_event, token: unknown, trustedKeyId: unknown) => {
    assertToken(token)
    if (trustedKeyId !== undefined && (typeof trustedKeyId !== 'string' || !/^[a-f0-9]{64}$/.test(trustedKeyId))) {
      throw new Error('PLUGIN_TRUST_KEY_INVALID')
    }
    await service.initialize()
    const result = await service.install(token, trustedKeyId as string | undefined)
    const snapshot = snapshotView(result)
    publishChanged()
    return snapshot
  })
  ipcMain.handle(MODULE_RUNTIME_PLUGIN_IPC_CHANNELS.SET_ENABLED, async (_event, pluginId: unknown, enabled: unknown, expectedRevision: unknown) => {
    assertId(pluginId)
    if (typeof enabled !== 'boolean' || !Number.isSafeInteger(expectedRevision) || Number(expectedRevision) < 0) {
      throw new Error('PLUGIN_STATE_INPUT_INVALID')
    }
    await service.initialize()
    const snapshot = snapshotView(await service.setEnabled(pluginId, enabled, Number(expectedRevision)))
    publishChanged()
    return snapshot
  })
  ipcMain.handle(MODULE_RUNTIME_PLUGIN_IPC_CHANNELS.UNINSTALL, async (_event, pluginId: unknown, expectedRevision: unknown) => {
    assertId(pluginId)
    if (!Number.isSafeInteger(expectedRevision) || Number(expectedRevision) < 0) throw new Error('PLUGIN_STATE_INPUT_INVALID')
    await service.initialize()
    const snapshot = snapshotView(await service.uninstall(pluginId, Number(expectedRevision)))
    publishChanged()
    return snapshot
  })
  ipcMain.handle(MODULE_RUNTIME_PLUGIN_IPC_CHANNELS.OPEN_SURFACE, async (_event, input: OpenModuleRuntimeSurfaceInput): Promise<OpenModuleRuntimeSurfaceResult> => {
    if (!input || typeof input !== 'object') throw new Error('PLUGIN_SURFACE_INPUT_INVALID')
    options.requireVisibleSession(input.sessionId)
    const surface = manager.getSurface(input.surfaceId, input.moduleId)
    if (!surface) throw new Error('PLUGIN_SURFACE_ENTRY_MISSING')
    const enabled = options.getSessionPolicy(input.sessionId).enabledModuleIds.includes(input.moduleId)
    const opened = manager.openSurface({
      surfaceId: input.surfaceId,
      moduleId: input.moduleId,
      sessionId: input.sessionId,
      projectId: options.requireVisibleSession(input.sessionId).workspaceId ?? null,
      readOnly: !enabled,
    })
    return {
      token: opened.token,
      title: surface.title,
      sourceUrl: `dutydeck-plugin://${opened.token}/${surface.entry}`,
      readOnly: opened.readOnly,
    }
  })
  ipcMain.handle(MODULE_RUNTIME_PLUGIN_IPC_CHANNELS.INVOKE_SURFACE, async (_event, input: InvokeModuleRuntimeSurfaceInput) => {
    if (!input || typeof input !== 'object') throw new Error('PLUGIN_SURFACE_INPUT_INVALID')
    options.requireVisibleSession(input.sessionId)
    return manager.invokeSurface(input)
  })
  ipcMain.handle(MODULE_RUNTIME_PLUGIN_IPC_CHANNELS.CLOSE_SURFACE, (_event, input: CloseModuleRuntimeSurfaceInput) => {
    if (!input || typeof input !== 'object') throw new Error('PLUGIN_SURFACE_INPUT_INVALID')
    options.requireVisibleSession(input.sessionId)
    manager.closeSurface(input.token)
  })
}
