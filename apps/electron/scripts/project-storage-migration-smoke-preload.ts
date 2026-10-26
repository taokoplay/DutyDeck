import { contextBridge, ipcRenderer } from 'electron'
import { createNormalPathManagementPreloadApi } from '../src/preload/path-management-preload'

/** 使用生产路径 bridge，测试窗口没有其它业务权限。 */
contextBridge.exposeInMainWorld('electronAPI', createNormalPathManagementPreloadApi(ipcRenderer))
