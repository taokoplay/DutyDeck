import type { IpcMain, IpcMainInvokeEvent } from 'electron'
import { COMPUTER_USE_IPC_CHANNELS as C } from '@dutydeck/shared'
import type { ComputerUseSnapshot } from '@dutydeck/shared'

/** 主窗口身份的最小合同，拒绝子 frame 和已销毁窗口。 */
interface ComputerUseOwner {
  /** 窗口是否关闭。 */
  isDestroyed(): boolean
  /** 主窗口内容与状态发送入口。 */
  webContents: { isDestroyed(): boolean; mainFrame: unknown; send(channel: string, snapshot: ComputerUseSnapshot): void }
}
/** 配置 IPC 所需服务；不包含桌面操作方法。 */
interface ComputerUseIpcService {
  getSnapshot(): ComputerUseSnapshot
  checkInstallation(): Promise<ComputerUseSnapshot>
  /** 仅主窗口允许启动固定官方安装器。 */
  installDriver(): Promise<ComputerUseSnapshot>
  checkPermissions(): Promise<ComputerUseSnapshot>
  setEnabled(enabled: boolean): Promise<ComputerUseSnapshot>
  setDriverPath(path: string): Promise<ComputerUseSnapshot>
  stop(id: string): Promise<ComputerUseSnapshot>
  subscribe(listener: (snapshot: ComputerUseSnapshot) => void): () => void
}
/** 通过引用验证当前主窗口，旧窗口和附属窗口均无权访问。 */
export function assertComputerUseSender(event: { sender: unknown; senderFrame: unknown }, owner: ComputerUseOwner | null): void {
  if (!owner || owner.isDestroyed() || owner.webContents.isDestroyed() || event.sender !== owner.webContents
    || !event.senderFrame || event.senderFrame !== owner.webContents.mainFrame) throw new Error('电脑控制仅允许主窗口访问')
}
/** 注册固定设置接口，返回卸载订阅的方法。 */
export function registerComputerUseIpc(ipc: Pick<IpcMain, 'handle'>, service: ComputerUseIpcService,
  getOwner: () => ComputerUseOwner | null, choosePath: () => Promise<string | null>): () => void {
  /** 每次请求均重新获取主窗口身份，防止窗口重建后沿用旧权限。 */
  const check = (event: IpcMainInvokeEvent): void => assertComputerUseSender(event, getOwner())
  ipc.handle(C.GET_SNAPSHOT, event => { check(event); return service.getSnapshot() })
  ipc.handle(C.CHECK_INSTALLATION, event => { check(event); return service.checkInstallation() })
  ipc.handle(C.INSTALL_DRIVER, event => { check(event); return service.installDriver() })
  ipc.handle(C.CHECK_PERMISSIONS, event => { check(event); return service.checkPermissions() })
  ipc.handle(C.SET_ENABLED, (event, enabled: unknown) => {
    check(event)
    if (typeof enabled !== 'boolean') throw new Error('启用状态无效')
    return service.setEnabled(enabled)
  })
  ipc.handle(C.STOP, (event, id: unknown) => {
    check(event)
    if (typeof id !== 'string' || !id.trim() || id.length > 256) throw new Error('操作标识无效')
    return service.stop(id)
  })
  ipc.handle(C.CHOOSE_DRIVER, async event => {
    check(event)
    /** 路径仅来自主进程文件选择器；等待期间可能发生窗口销毁。 */
    const path = await choosePath()
    check(event)
    return path === null ? service.getSnapshot() : service.setDriverPath(path)
  })
  return service.subscribe(snapshot => {
    /** 只推送当前主窗口，截图不广播给其他 renderer。 */
    const owner = getOwner()
    if (owner && !owner.isDestroyed() && !owner.webContents.isDestroyed()) owner.webContents.send(C.CHANGED, snapshot)
  })
}
