/** 即梦会话附件包装器；CLI 核心独立供统一媒体服务复用。 */
import type { AgentToolResultImage } from '@dutydeck/shared'
import { deleteAttachment, saveAttachment } from '../attachment-service'
import { generateDreaminaImages } from './dreamina-image-generation'
import type { GenerateDreaminaImagesInput, DreaminaImageGenerationDependencies } from './dreamina-image-generation'
export type { DreaminaCliResult, DreaminaCliRunner } from './dreamina-image-generation'

/** 兼容原会话图片工具入参。 */
export interface ExecuteDreaminaImagesInput extends GenerateDreaminaImagesInput {
  /** 附件所属会话。 */
  sessionId: string
}
/** 原测试与宿主可注入 CLI、目录和附件服务。 */
export interface DreaminaImagesExecutorDependencies extends DreaminaImageGenerationDependencies {
  saveAttachment: typeof saveAttachment
  deleteAttachment: typeof deleteAttachment
}
/** 返回原会话附件合同，不改变图片工具消费方式。 */
export interface DreaminaImagesExecutionResult { imageAttachments: AgentToolResultImage[] }

/**
 * 生成真实媒体字节后保存为受管附件；任一保存失败回滚本次已保存附件。
 * @param input 会话身份与受授权生成参数。
 * @param dependencies 可选测试或宿主依赖。
 * @returns 原图片工具消费的附件集合。
 */
export async function executeDreaminaImages(input: ExecuteDreaminaImagesInput, dependencies?: DreaminaImagesExecutorDependencies): Promise<DreaminaImagesExecutionResult> {
  /** 核心负责下载目录清理，附件只在生成成功后创建。 */
  const outputs = await generateDreaminaImages(input, dependencies)
  const savedPaths: string[] = []
  const imageAttachments: AgentToolResultImage[] = []
  const save = dependencies?.saveAttachment ?? saveAttachment
  const remove = dependencies?.deleteAttachment ?? deleteAttachment
  const extensions: Record<string, string> = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp' }
  try {
    for (const [index, output] of outputs.entries()) {
      if (input.signal?.aborted) throw new Error('即梦生成已取消')
      const filename = `dreamina-image-${input.route.snapshot.modelId}-${index + 1}.${extensions[output.contentType] ?? 'png'}`
      const result = save({ conversationId: input.sessionId, filename, mediaType: output.contentType, data: Buffer.from(output.bytes).toString('base64') })
      savedPaths.push(result.attachment.localPath)
      imageAttachments.push({ localPath: result.attachment.localPath, filename: result.attachment.filename, mediaType: result.attachment.mediaType })
    }
    return { imageAttachments }
  } catch (error) {
    for (const path of savedPaths) remove(path)
    throw error
  }
}
