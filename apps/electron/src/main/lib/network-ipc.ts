import type { IpcMain, IpcMainInvokeEvent } from 'electron'
import { NETWORK_IPC_CHANNELS } from '@dutydeck/shared'
import type { NetworkDiagnosticsReport, NetworkRecoveryReason, NetworkRecoveryStatus } from '@dutydeck/shared'
import type { NetworkDiagnostics } from './network-diagnostics'

/** 授权检查需要的窗口最小形状，不读取窗口中的业务数据。 */
interface NetworkSenderOwner {
  /** 窗口销毁后拒绝访问。 */
  isDestroyed(): boolean
  /** 当前窗口的 WebContents 身份与主 frame。 */
  webContents: { isDestroyed(): boolean; mainFrame: unknown }
}
/** 用引用身份验证当前窗口主 frame；附属窗口、旧窗口、子 frame 均拒绝。 */
export function assertNetworkSender(
  event: { sender: unknown; senderFrame: unknown },
  owner: NetworkSenderOwner | null,
): void {
  if (!owner || owner.isDestroyed() || owner.webContents.isDestroyed()
    || event.sender !== owner.webContents || !event.senderFrame || event.senderFrame !== owner.webContents.mainFrame) {
    throw new Error('网络设置仅允许主窗口访问')
  }
}

/** 窗口授权与保存对话框由宿主提供，便于隔离测试真实 handler 行为。 */
export interface NetworkIpcDependencies {
  /** 只允许当前主窗口的主 frame。 */
  assertSender(event: IpcMainInvokeEvent): void
  /** 状态读取不发起网络请求。 */
  getStatus(): NetworkRecoveryStatus
  /** 恢复原因由固定 handler 决定，renderer 不能自定义。 */
  requestRecovery(reason: NetworkRecoveryReason): Promise<NetworkRecoveryStatus>
  /** 单例诊断容器。 */
  diagnostics: NetworkDiagnostics
  /** 保存已预览快照，取消返回 false。 */
  saveReport(report: NetworkDiagnosticsReport, event: IpcMainInvokeEvent): Promise<boolean>
}

/** 注册网络最小 IPC；所有路径先验证发送者，导出先取快照再打开对话框。 */
export function registerNetworkIpc(ipc: Pick<IpcMain, 'handle'>, dependencies: NetworkIpcDependencies): void {
  ipc.handle(NETWORK_IPC_CHANNELS.GET_STATUS, event => {
    dependencies.assertSender(event)
    return dependencies.getStatus()
  })
  ipc.handle(NETWORK_IPC_CHANNELS.RECONNECT, event => {
    dependencies.assertSender(event)
    return dependencies.requestRecovery('manual')
  })
  ipc.handle(NETWORK_IPC_CHANNELS.NOTIFY_ONLINE, event => {
    dependencies.assertSender(event)
    return dependencies.requestRecovery('online')
  })
  ipc.handle(NETWORK_IPC_CHANNELS.PREVIEW_DIAGNOSTICS, event => {
    dependencies.assertSender(event)
    return dependencies.diagnostics.createReport()
  })
  ipc.handle(NETWORK_IPC_CHANNELS.EXPORT_DIAGNOSTICS, (event, reportId: unknown) => {
    dependencies.assertSender(event)
    if (typeof reportId !== 'string') throw new Error('诊断预览标识无效')
    /** 保存的是用户实际预览的副本，后续事件和对话框等待不改变内容。 */
    const report = dependencies.diagnostics.getReport(reportId)
    return dependencies.saveReport(report, event)
  })
}
