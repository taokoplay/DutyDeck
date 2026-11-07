/** 验证记录由宿主发布维护，不从市场或插件清单导入，也不授予执行权限。 */
export interface PluginValidationEnvironment {
  hostVersion: string
  /** 实际packaged应用resources负载指纹（版本化合同含Electron/ABI等运行环境）；不认证OS/供应链或内存已加载字节。开发/watch、历史未绑定记录可缺失，不能以bundle-set或源码hash代替。 */
  hostBuildSha256?: string
  platform: string
  arch: string
  electron: string
  adapterVersion: string
  adapterSha256: string
}
export interface PluginValidationIdentity { pluginId: string; pluginVersion: string; packageHash: string }
export interface PluginValidationRecord extends PluginValidationIdentity {
  formatVersion: 1
  source: { name: string; version: string; url: string; archiveSha256: string; license: string }
  environment: PluginValidationEnvironment
  testedAt: string
  expiresAt: string
  result: 'passed' | 'failed'
  scope: 'isolated-developer-smoke'
  resultSha256: string
  buildEvidenceSha256: string
  limitations: string[]
}
export interface PluginValidationAssessment {
  status: 'unassessed' | 'validated' | 'stale' | 'failed'
  reasons: string[]
  record?: PluginValidationRecord
}
/** 快照查询不会启动 runtime；健康状态与验证证据、授权分别展示。 */
export interface PluginRuntimeManagementView {
  validation: PluginValidationAssessment
  authorization: 'required' | 'granted' | 'revoked'
  health: { state: 'idle' | 'starting' | 'running' | 'draining' | 'stopped' | 'failed'; epoch: number; errorCode?: string }
}
