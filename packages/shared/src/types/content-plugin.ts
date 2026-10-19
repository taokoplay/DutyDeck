import type { PluginPackageManifest, ValidatedPluginResource } from '@dutydeck/plugin-sdk'

/** 内容插件管理 IPC；目录变化仅作刷新通知，不携带资源正文。 */
export const CONTENT_PLUGIN_IPC_CHANNELS = {
  GET: 'content-plugin:get', PREVIEW: 'content-plugin:preview', INSTALL: 'content-plugin:install',
  SET_ENABLED: 'content-plugin:set-enabled', UNINSTALL: 'content-plugin:uninstall', CHANGED: 'content-plugin:changed',
} as const
/** UI 可展示的资源摘要，不包含注入模型的正文。 */
export type ContentResourceSummary = Omit<ValidatedPluginResource, 'content'>
/** 已安装内容插件，enabled 只表示可选择，不等于当前消息已启用。 */
export interface InstalledContentPlugin {
  manifest: PluginPackageManifest
  packageHash: string
  keyId?: string
  enabled: boolean
  installedAt: string
  resources: ContentResourceSummary[]
}
/** 修订号用于拒绝过期界面的管理操作。 */
export interface ContentPluginSnapshot { revision: number; plugins: InstalledContentPlugin[] }
/** 原生文件选择后生成的精确包预览；签名有效不代表来源可信。 */
export interface ContentPluginPreview {
  token: string
  revision: number
  operation: 'install' | 'update'
  previousVersion?: string
  manifest: PluginPackageManifest
  packageHash: string
  signatureVerified: boolean
  signer?: { keyId: string; publicKey: string }
  resources: ContentResourceSummary[]
}
