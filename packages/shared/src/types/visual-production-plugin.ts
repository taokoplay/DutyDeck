import type { AgentModuleManifest } from './agent-modules'
import { PROJECT_STORAGE_DIRECTORY_NAME } from '../constants/project-storage'

/** 内置插件身份；拆分独立插件后必须保持同一稳定 ID。 */
export const VISUAL_PRODUCTION_PLUGIN_ID = 'builtin.visual-production'
/** 右侧工作区稳定 surface ID。 */
export const VISUAL_PRODUCTION_SURFACE_ID = 'visual-production'
/** 新项目默认目录分段；旧作品由宿主中央解析器保持原目录读写。 */
export const VISUAL_PRODUCTION_STORAGE_SEGMENTS = [PROJECT_STORAGE_DIRECTORY_NAME, 'visual-production'] as const
/** 当前项目内数据命名空间，实际文件位置由宿主兼容解析。 */
export const VISUAL_PRODUCTION_STORAGE_NAMESPACE = VISUAL_PRODUCTION_STORAGE_SEGMENTS.join('/')
/** 四层 IPC 合同前缀；独立进程插件也必须沿用稳定通道语义。 */
export const VISUAL_PRODUCTION_IPC_CHANNEL_PREFIX = 'visual-production:' as const

/**
 * 独立影像插件需要宿主提供的能力。
 * 插件不得直接取得 Electron、文件系统根、凭据或供应商 SDK。
 */
export const VISUAL_PRODUCTION_HOST_CAPABILITIES = [
  'project-session',
  'project-storage-lease',
  'agent-runtime',
  'renderer-surface',
  'media-model-catalog',
  'media-workflow-catalog',
  'media-file-inspection',
  'media-execution-context',
  'video-export',
] as const
/** 宿主能力的可序列化名称。 */
export type VisualProductionHostCapability = typeof VISUAL_PRODUCTION_HOST_CAPABILITIES[number]

/**
 * 影像模块对宿主和 Agent 暴露的稳定能力清单。
 * 具体工具实现可以在独立插件包内迁移，模块 ID、surface 和持久化所有权保持不变。
 */
export const VISUAL_PRODUCTION_MODULE_MANIFEST: AgentModuleManifest = {
  id: 'visual-production',
  version: '1.0.0',
  apiVersion: 1,
  displayName: '影像创作',
  description: '从剧本、资产、分镜和审片到剪辑交付的独立影像生产工作区。',
  icon: 'clapperboard',
  scope: 'project',
  contributions: ['surface', 'skill', 'prompt', 'tool', 'artifact'],
  skillRefs: ['media-models'],
  promptRefs: ['visual-production.system.v1'],
  toolRefs: ['visual.projects', 'visual.script', 'visual.storyboard', 'visual.media', 'visual.review', 'visual.edit', 'visual.deliver'],
  artifactTypes: ['visual.production', 'visual.script', 'visual.storyboard', 'media.image', 'media.video', 'media.audio', 'visual.timeline', 'visual.final-master'],
  surfaceIds: [VISUAL_PRODUCTION_SURFACE_ID],
  requiredPermissions: ['project.files.read', 'project.files.write', 'media.execute'],
  activation: 'session-toggle',
}

/** 返回独立副本，防止模块目录或插件运行时改写共享 manifest。 */
export function visualProductionModuleManifest(): AgentModuleManifest {
  return structuredClone(VISUAL_PRODUCTION_MODULE_MANIFEST)
}
