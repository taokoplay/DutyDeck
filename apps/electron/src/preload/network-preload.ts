import { NETWORK_IPC_CHANNELS } from '@dutydeck/shared'
import type { NetworkApi, NetworkDiagnosticsReport, NetworkRecoveryStatus } from '@dutydeck/shared'

/** 构造固定通道的网络 API，无 URL、路径或诊断写入入口。 */
export function createNetworkPreload(invoke: (channel: string, ...args: unknown[]) => Promise<unknown>): NetworkApi {
  return {
    getStatus: () => invoke(NETWORK_IPC_CHANNELS.GET_STATUS) as Promise<NetworkRecoveryStatus>,
    reconnect: () => invoke(NETWORK_IPC_CHANNELS.RECONNECT) as Promise<NetworkRecoveryStatus>,
    notifyOnline: () => invoke(NETWORK_IPC_CHANNELS.NOTIFY_ONLINE) as Promise<NetworkRecoveryStatus>,
    previewDiagnostics: () => invoke(NETWORK_IPC_CHANNELS.PREVIEW_DIAGNOSTICS) as Promise<NetworkDiagnosticsReport>,
    exportDiagnostics: reportId => invoke(NETWORK_IPC_CHANNELS.EXPORT_DIAGNOSTICS, reportId) as Promise<boolean>,
  }
}
