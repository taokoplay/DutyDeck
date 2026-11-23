import type { MediaWorkflowDefinition } from '@dutydeck/shared'
import { assertMediaProbeAvailable, type MediaFileProbeDependencies } from './media-file-probe'

/** ComfyUI 运行前只负责验证本机能接收音视频产物，不探测远端或提交任务。 */
export interface ComfyUIOutputPreflightAdapter {
  assertOutputSupport: (workflow: MediaWorkflowDefinition) => Promise<void>
}

/**
 * 创建 ComfyUI 输出预检适配器。
 * 图片输出不依赖本机媒体探测器；音频和视频输出必须先确认 ffprobe 可执行。
 */
export function createComfyUIOutputPreflightAdapter(
  dependencies: MediaFileProbeDependencies = {},
): ComfyUIOutputPreflightAdapter {
  return {
    assertOutputSupport: async (workflow) => {
      if (!workflow.outputs.some((output) => output.mediaType !== 'image')) return
      await assertMediaProbeAvailable(dependencies)
    },
  }
}
