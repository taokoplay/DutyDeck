import { COMPUTER_USE_IPC_CHANNELS as C } from '@dutydeck/shared'
import type { ComputerUseApi, ComputerUseSnapshot } from '@dutydeck/shared'

/** Electron 桥最小依赖，不暴露底层 IPC 给页面。 */
interface ComputerUseBridge {
  /** 固定通道请求。 */
  invoke(channel: string, ...args: unknown[]): Promise<unknown>
  /** 注册状态事件。 */
  on(channel: string, listener: (...args: unknown[]) => void): void
  /** 删除同一监听器。 */
  removeListener(channel: string, listener: (...args: unknown[]) => void): void
}
/** 构造仅含配置、状态与停止的页面 API。 */
export function createComputerUsePreload(bridge: ComputerUseBridge): ComputerUseApi {
  return {
    getSnapshot: () => bridge.invoke(C.GET_SNAPSHOT) as Promise<ComputerUseSnapshot>,
    checkInstallation: () => bridge.invoke(C.CHECK_INSTALLATION) as Promise<ComputerUseSnapshot>,
    installDriver: () => bridge.invoke(C.INSTALL_DRIVER) as Promise<ComputerUseSnapshot>,
    checkPermissions: () => bridge.invoke(C.CHECK_PERMISSIONS) as Promise<ComputerUseSnapshot>,
    setEnabled: enabled => bridge.invoke(C.SET_ENABLED, enabled) as Promise<ComputerUseSnapshot>,
    chooseDriver: () => bridge.invoke(C.CHOOSE_DRIVER) as Promise<ComputerUseSnapshot>,
    stop: id => bridge.invoke(C.STOP, id) as Promise<ComputerUseSnapshot>,
    onChanged: listener => {
      /** 仅传递状态载荷，不向页面泄露 Electron 事件。 */
      const handler = (_event: unknown, snapshot: unknown): void => listener(snapshot as ComputerUseSnapshot)
      bridge.on(C.CHANGED, handler)
      return () => bridge.removeListener(C.CHANGED, handler)
    },
  }
}
