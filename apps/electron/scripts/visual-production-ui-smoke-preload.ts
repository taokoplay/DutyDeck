import { contextBridge, ipcRenderer } from 'electron'
import { createVisualProductionPreload } from '../src/preload/visual-production-preload'

/** 使用生产窄桥，只替换宿主窗口和项目根，不伪造任何存储结果。 */
contextBridge.exposeInMainWorld('electronAPI', {
  visualProduction: createVisualProductionPreload((channel, value) => ipcRenderer.invoke(channel, value), (channel, callback) => {
    /** Electron 事件不跨隔离世界。 */
    const listener = (_event: Electron.IpcRendererEvent, value: unknown): void => callback(value)
    ipcRenderer.on(channel, listener)
    return () => { ipcRenderer.removeListener(channel, listener) }
  }),
})
