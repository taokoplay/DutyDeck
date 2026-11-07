/** 固定配方导入与只读市场分离，不接受renderer指定的包字节、命令或transport。 */
export const PLUGIN_STATIC_IMPORT_IPC_CHANNELS = {
  LIST: 'plugin-static-import:list', PREVIEW: 'plugin-static-import:preview', APPLY: 'plugin-static-import:apply', UNDO: 'plugin-static-import:undo',
} as const
export interface PluginImportStepReceipt {
  id: 'content' | 'mcp'
  status: 'pending' | 'applying' | 'created' | 'reused' | 'removed' | 'blocked'
  fingerprint?: string
  resourceKey?: string
  error?: string
}
export interface PluginImportReceipt {
  formatVersion: 1
  id: string
  planHash: string
  workspaceId: string
  revision: number
  updatedAt: string
  steps: PluginImportStepReceipt[]
}
export interface StaticImportPlanSummary {
  hash: string
  recipeId: string
  recipeVersion: string
  source: { name: string; version: string; sha256: string; url: string; license: string }
  content?: { pluginId: string; packageHash: string; keyId: string; resources: Array<{ id: string; path: string; kind: string; byteLength: number }> }
  mcp?: { name: string; url: string; type: 'http'; requiresOAuth: boolean }
}
export interface StaticImportPreview {
  token: string
  planHash: string
  workspaceId: string
  content?: { pluginId: string; packageHash: string; keyId: string }
  mcp?: { name: string; url: string; type: 'http' }
  conflicts: string[]
  receipt: PluginImportReceipt | null
}
export interface PluginStaticImportApi {
  list(): Promise<StaticImportPlanSummary[]>
  preview(input: { planHash: string; workspaceId: string }): Promise<StaticImportPreview>
  apply(input: { token: string; confirmed: boolean; trustedKeyId?: string }): Promise<PluginImportReceipt>
  undo(input: { token: string; confirmed: boolean }): Promise<PluginImportReceipt>
}
