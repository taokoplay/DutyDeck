import { dialog, ipcMain } from 'electron'
import { PLUGIN_PACKAGE_IMPORT_IPC_CHANNELS, type PluginPackageImportPreview } from '@dutydeck/shared'
import { readBoundedFile } from '@dutydeck/plugin-kit/filesystem'
import { previewPluginPackageBytes, type PluginPackagePreviewTargets } from './plugin-package-import'

/** 统一导入依赖；两类插件仍由各自受信服务缓存预览 token。 */
export interface PluginPackageImportIpcOptions extends PluginPackagePreviewTargets {
  selectPackage?: () => Promise<string | null>
}

/** 统一包大小上限，与宿主已有 50 MiB 插件包预算一致。 */
const MAX_PLUGIN_PACKAGE_BYTES = 50 * 1024 * 1024

/** 把 IPC 传入的 ArrayBuffer/Uint8Array 复制为不可变检查字节。 */
function freezePackageBytes(value: unknown): Uint8Array {
  let bytes: Uint8Array
  if (value instanceof Uint8Array) bytes = Uint8Array.from(value)
  else if (value instanceof ArrayBuffer) bytes = new Uint8Array(value.slice(0))
  else throw new Error('PLUGIN_PACKAGE_BYTES_INVALID')
  if (bytes.byteLength === 0 || bytes.byteLength > MAX_PLUGIN_PACKAGE_BYTES) {
    throw new Error('PLUGIN_PACKAGE_SIZE_LIMIT')
  }
  return bytes
}

/** 注册插件中心统一的文件选择、拖放字节预览 IPC。 */
export function registerPluginPackageImportIpc(options: PluginPackageImportIpcOptions): void {
  ipcMain.handle(PLUGIN_PACKAGE_IMPORT_IPC_CHANNELS.PREVIEW, async (): Promise<PluginPackageImportPreview | null> => {
    const selected = options.selectPackage
      ? await options.selectPackage()
      : await dialog.showOpenDialog({
        title: '选择 DutyDeck 插件包',
        properties: ['openFile'],
        filters: [{ name: 'DutyDeck 插件包', extensions: ['ddplugin'] }],
      }).then(result => result.canceled ? null : result.filePaths[0] ?? null)
    if (!selected) return null
    if (!selected.toLowerCase().endsWith('.ddplugin')) throw new Error('PLUGIN_PACKAGE_EXTENSION_INVALID')
    return previewPluginPackageBytes(options, readBoundedFile(selected, MAX_PLUGIN_PACKAGE_BYTES))
  })
  ipcMain.handle(PLUGIN_PACKAGE_IMPORT_IPC_CHANNELS.PREVIEW_BYTES, async (_event, value: unknown): Promise<PluginPackageImportPreview> => {
    return previewPluginPackageBytes(options, freezePackageBytes(value))
  })
}
