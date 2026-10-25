import type { ContentPluginPreview } from './content-plugin'
import type { ModuleRuntimePluginPreviewView } from './module-runtime-plugin'

/** 统一插件包导入通道；主进程按包内 formatVersion 选择安装流程。 */
export const PLUGIN_PACKAGE_IMPORT_IPC_CHANNELS = {
  PREVIEW: 'plugin-package-import:preview',
  PREVIEW_BYTES: 'plugin-package-import:preview-bytes',
} as const

/** 内容插件或可执行模块插件的精确预览联合。 */
export type PluginPackageImportPreview =
  | { kind: 'content'; preview: ContentPluginPreview }
  | { kind: 'runtime'; preview: ModuleRuntimePluginPreviewView }

/** preload 暴露的统一导入 API；安装仍复用各自既有 token 流程。 */
export interface PluginPackageImportApi {
  preview(): Promise<PluginPackageImportPreview | null>
  previewBytes(bytes: Uint8Array): Promise<PluginPackageImportPreview>
}
