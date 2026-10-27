/** 触发连接恢复的可信本机事件。 */
export type NetworkRecoveryReason = 'interface' | 'resume' | 'online' | 'manual' | 'proxy-settings'
/** 仅包含可公开状态，不暴露代理或服务地址。 */
export interface NetworkRecoveryStatus {
  /** 网络代次，成功刷新后递增。 */
  epoch: number
  /** 最近一次恢复时间（Unix 毫秒）。 */
  lastChangedAt?: number
  /** 最近一次恢复原因。 */
  reason?: NetworkRecoveryReason
}
/** 主进程到受管 utility 的内部通知，不经 renderer 暴露。 */
export interface NetworkRecoveryNotice extends NetworkRecoveryStatus {
  /** 之前生效的代理地址。 */
  previousProxyUrl?: string
  /** 当前生效的代理地址。 */
  proxyUrl?: string
}
/** 诊断允许记录的生命周期阶段。 */
export type NetworkDiagnosticPhase = 'completed' | 'failed' | 'cancelled' | 'stalled' | 'recovery'
/** 诊断允许记录的粗粒度故障分类。 */
export type NetworkDiagnosticCode = 'network_changed' | 'timeout' | 'dns' | 'connection' | 'provider_error' | 'authentication' | 'rate_limit' | 'unknown'
/** 诊断输入仅包含枚举和有界数值，禁止原始请求或错误文本。 */
export interface NetworkDiagnosticInput {
  /** 生命周期阶段。 */
  phase: NetworkDiagnosticPhase
  /** 脱敏分类。 */
  code: NetworkDiagnosticCode
  /** 耗时毫秒，有限非负数。 */
  durationMs?: number
  /** HTTP 状态码，100–599 整数。 */
  status?: number
}
/** 存储后的单条诊断，时间和匿名来源均由主进程生成。 */
export interface NetworkDiagnosticEvent extends NetworkDiagnosticInput {
  /** 记录时间（Unix 毫秒）。 */
  timestamp: number
  /** 当前进程随机盐生成的来源标识，不能反推出 URL。 */
  originId?: string
}
/** 用户已预览的不可变诊断快照，导出时按 id 精确取回。 */
export interface NetworkDiagnosticsReport {
  /** 临时快照标识。 */
  id: string
  /** 快照创建时间（Unix 毫秒）。 */
  createdAt: number
  /** 最多 100 条脱敏事件。 */
  events: NetworkDiagnosticEvent[]
}
/** 网络设置的最小 renderer API，不接收自定义探测 URL。 */
export interface NetworkApi {
  /** 获取最近一次恢复状态。 */
  getStatus(): Promise<NetworkRecoveryStatus>
  /** 用户主动刷新连接。 */
  reconnect(): Promise<NetworkRecoveryStatus>
  /** 转发系统恢复在线事件。 */
  notifyOnline(): Promise<NetworkRecoveryStatus>
  /** 生成本次预览的脱敏快照。 */
  previewDiagnostics(): Promise<NetworkDiagnosticsReport>
  /** 导出指定预览；取消保存返回 false。 */
  exportDiagnostics(reportId: string): Promise<boolean>
}
/** 网络专用 IPC 名称。 */
export const NETWORK_IPC_CHANNELS = {
  GET_STATUS: 'network:get-status',
  RECONNECT: 'network:reconnect',
  NOTIFY_ONLINE: 'network:notify-online',
  PREVIEW_DIAGNOSTICS: 'network:preview-diagnostics',
  EXPORT_DIAGNOSTICS: 'network:export-diagnostics',
} as const
