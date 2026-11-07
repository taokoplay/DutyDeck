import type { PluginCapabilityId, PluginSettingValue, PluginV3Manifest } from '@dutydeck/plugin-sdk'
import type { PluginRuntimeManagementView } from './plugin-validation'

/** V3 可执行插件管理通道；正文和文件路径不进入 renderer。 */
export const MODULE_RUNTIME_PLUGIN_IPC_CHANNELS = {
  GET: 'module-runtime-plugin:get',
  PREVIEW: 'module-runtime-plugin:preview',
  INSTALL: 'module-runtime-plugin:install',
  SET_ENABLED: 'module-runtime-plugin:set-enabled',
  AUTHORIZE: 'module-runtime-plugin:authorize',
  REVOKE: 'module-runtime-plugin:revoke',
  CONFIGURE_SETTINGS: 'module-runtime-plugin:configure-settings',
  LIST_VERSIONS: 'module-runtime-plugin:list-versions',
  ROLLBACK: 'module-runtime-plugin:rollback',
  UNINSTALL: 'module-runtime-plugin:uninstall',
  CHANGED: 'module-runtime-plugin:changed',
  OPEN_SURFACE: 'module-runtime-plugin:open-surface',
  CLOSE_SURFACE: 'module-runtime-plugin:close-surface',
  INVOKE_SURFACE: 'module-runtime-plugin:invoke-surface',
} as const

/** 构造右侧工具和 Pane 使用的稳定插件 Surface 身份。 */
export function getPluginRuntimeSurfaceId(pluginId: string, surfaceId: string): `plugin:${string}` {
  return `plugin:${pluginId}:${surfaceId}`
}

/** 判断右侧身份是否属于 V3 动态插件 Surface。 */
export function isPluginRuntimeSurfaceId(value: string): value is `plugin:${string}` {
  return value.startsWith('plugin:') && value.length > 'plugin:'.length
}

/** 解析动态 Surface 的插件 ID 与插件内 Surface ID。 */
export function parsePluginRuntimeSurfaceId(value: string): {
  pluginId: string
  surfaceId: string
} | null {
  if (!isPluginRuntimeSurfaceId(value)) return null
  const body = value.slice('plugin:'.length)
  const separator = body.indexOf(':')
  if (separator <= 0 || separator === body.length - 1) return null
  return { pluginId: body.slice(0, separator), surfaceId: body.slice(separator + 1) }
}

/** renderer 可见的已安装 V3 插件，不包含包根路径。 */
export interface InstalledModuleRuntimePluginView {
  manifest: PluginV3Manifest
  packageHash: string
  keyId?: string
  enabled: boolean
  executionBlock?: 'PLUGIN_RUNTIME_CONTRACT_MIGRATION_REQUIRED'
  installedAt: string
  management?: PluginRuntimeManagementView
  grant?: ModuleRuntimePluginGrantView | null
  settings?: { revision: number; values: Record<string, PluginSettingValue> }
}

/** 授权是独立用户决定；空工作区列表不表示全部工作区。 */
export interface ModuleRuntimePluginGrantView {
  pluginId: string
  pluginVersion: string
  packageHash: string
  revision: number
  capabilities: PluginCapabilityId[]
  workspaceIds: string[]
  revoked: boolean
  updatedAt: string
}

export interface AuthorizeModuleRuntimePluginInput {
  pluginId: string
  capabilities: PluginCapabilityId[]
  workspaceIds: string[]
  expectedRevision: number
  expectedGrantRevision: number
}

/** V3 插件目录快照。 */
export interface ModuleRuntimePluginSnapshotView {
  revision: number
  plugins: InstalledModuleRuntimePluginView[]
}

/** 声明级差异不是实际项目数据兼容证明。 */
export interface ModuleRuntimePluginChanges {
  previousPackageHash: string | null
  capabilitiesAdded: PluginCapabilityId[]
  capabilitiesRemoved: PluginCapabilityId[]
  settingsChanged: string[]
  artifacts: Array<{ id: string; fromSchema: number | null; toSchema: number | null }>
  runtimeContractChanged: boolean
  dataCompatibility: 'unknown'
  blockers: string[]
}

/** V3 包预览只展示身份、签名和能力，不传 runtime 字节。 */
export interface ModuleRuntimePluginPreviewView {
  token: string
  manifest: PluginV3Manifest
  packageHash: string
  signatureVerified: boolean
  signer?: { keyId: string; publicKey: string }
  operation: 'install' | 'update'
  previousVersion?: string
  changes?: ModuleRuntimePluginChanges
  validation?: PluginRuntimeManagementView['validation']
}

/** renderer 可见的历史包摘要；不暴露归档路径和包正文。 */
export interface ArchivedModuleRuntimePluginVersionView {
  version: string
  packageHash: string
  signatureVerified: boolean
  keyId?: string
  changes?: ModuleRuntimePluginChanges
}

/** 打开 Surface 后的 renderer 合同；sourceUrl 携带短期 token。 */
export interface OpenModuleRuntimeSurfaceInput {
  sessionId: string
  moduleId: string
  surfaceId: string
}

/** 打开 Surface 的只读元数据。 */
export interface OpenModuleRuntimeSurfaceResult {
  token: string
  title: string
  sourceUrl: string
  readOnly: boolean
}

/** Surface bridge 请求由 main 再次校验 token 和方法。 */
export interface InvokeModuleRuntimeSurfaceInput {
  sessionId: string
  token: string
  method: string
  input: unknown
}

/** 关闭 Surface token。 */
export interface CloseModuleRuntimeSurfaceInput {
  sessionId: string
  token: string
}

/** preload 暴露的 V3 插件管理 API。 */
export interface ModuleRuntimePluginApi {
  get(): Promise<ModuleRuntimePluginSnapshotView>
  preview(): Promise<ModuleRuntimePluginPreviewView | null>
  install(token: string, trustedKeyId?: string): Promise<ModuleRuntimePluginSnapshotView>
  setEnabled(pluginId: string, enabled: boolean, expectedRevision: number): Promise<ModuleRuntimePluginSnapshotView>
  authorize(input: AuthorizeModuleRuntimePluginInput): Promise<ModuleRuntimePluginSnapshotView>
  revoke(pluginId: string, expectedGrantRevision: number): Promise<ModuleRuntimePluginSnapshotView>
  configureSettings(input: { pluginId: string; values: Record<string, unknown>; expectedRevision: number; expectedSettingsRevision: number }): Promise<ModuleRuntimePluginSnapshotView>
  listVersions(pluginId: string): Promise<ArchivedModuleRuntimePluginVersionView[]>
  rollback(pluginId: string, packageHash: string, expectedRevision: number): Promise<ModuleRuntimePluginSnapshotView>
  uninstall(pluginId: string, expectedRevision: number): Promise<ModuleRuntimePluginSnapshotView>
  openSurface(input: OpenModuleRuntimeSurfaceInput): Promise<OpenModuleRuntimeSurfaceResult>
  invokeSurface(input: InvokeModuleRuntimeSurfaceInput): Promise<unknown>
  closeSurface(input: CloseModuleRuntimeSurfaceInput): Promise<void>
  onChanged(callback: () => void): () => void
}
