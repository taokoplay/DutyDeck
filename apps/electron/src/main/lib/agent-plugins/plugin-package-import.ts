import type { PluginPackageImportPreview } from '@dutydeck/shared'
import { inspectPluginPackage } from '@dutydeck/plugin-kit/package'
import type { ContentPluginManager } from './content-plugin-manager'
import type { ModuleRuntimePluginService } from './module-runtime-plugin-service'

/** 统一行包解析所需的两个受信预览入口。 */
export interface PluginPackagePreviewTargets {
  runtimeService: Pick<ModuleRuntimePluginService, 'previewBytes'>
  contentManager: Pick<ContentPluginManager, 'previewBytes'>
}

/**
 * 根据包内格式把预览路由给 V2 内容插件或 V3 可执行模块插件。
 * @param targets 两个宿主级插件管理器。
 * @param bytes 已冻结的插件包字节。
 * @returns renderer 可展示的判别联合。
 */
export function previewPluginPackageBytes(
  targets: PluginPackagePreviewTargets,
  bytes: Uint8Array,
): PluginPackageImportPreview {
  const inspected = inspectPluginPackage(bytes)
  if (inspected.manifest.formatVersion === 2) {
    return { kind: 'content', preview: targets.contentManager.previewBytes(bytes) }
  }
  if (inspected.manifest.formatVersion === 3) {
    return { kind: 'runtime', preview: targets.runtimeService.previewBytes(bytes) }
  }
  throw new Error('PLUGIN_PACKAGE_FORMAT_UNSUPPORTED')
}
