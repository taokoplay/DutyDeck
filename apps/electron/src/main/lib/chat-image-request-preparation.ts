import type { ChatMessage, FileAttachment } from '@dutydeck/shared'
import type { ImageAttachmentData, ImageAttachmentReader } from '@dutydeck/core'
import { readAttachmentAsBase64, isImageAttachment } from './attachment-service'
import { assertImageRequestBudget, createImagePreviewPreparer } from './image-request-preparation'
import type { RequestImageInput } from './image-request-preparation'

/** Chat 请求的原始输入；读取函数可在隔离测试中替换，不改变生产授权边界。 */
interface ChatImageRequestInput {
  /** 已按用户设置筛选并补全文档内容的历史。 */
  history: ChatMessage[]
  /** 当前用户正文。 */
  userMessage: string
  /** 当前原始附件，仅用于生成请求副本。 */
  attachments?: FileAttachment[]
  /** 当前运行的取消信号。 */
  signal?: AbortSignal
  /** 沿附件服务安全边界读取 Base64。 */
  readAttachment?: (localPath: string) => string
}

/** 供同步 Provider adapter 使用的已准备请求投影。 */
interface PreparedChatImageRequest {
  /** 保持原有回合边界的历史副本。 */
  history: ChatMessage[]
  /** 含图片编号清单的当前正文。 */
  userMessage: string
  /** 去重后的当前预览附件标识。 */
  attachments?: FileAttachment[]
  /** 只读取本次运行已准备图片，不再访问磁盘。 */
  readImageAttachments: ImageAttachmentReader
}

/**
 * 提前异步准备图片，再为同步适配器提供预览读取器。
 * 保留全部唯一图片和原始回合；重复内容以编号引用代替，原附件不变。
 * @param input 当前发送所选的历史、正文、附件与取消信号
 * @returns 不写入持久化的模型请求投影
 */
export async function prepareChatImageRequest(input: ChatImageRequestInput): Promise<PreparedChatImageRequest> {
  /** 单次运行的预览缓存与安全读取器。 */
  const preparer = createImagePreviewPreparer()
  const readAttachment = input.readAttachment ?? readAttachmentAsBase64
  /** 图片内容身份对应稳定的本次请求编号。 */
  const seen = new Map<string, number>()
  /** 仅通过投影附件对象读取已准备内容，避免路径重复导致编号错配。 */
  const previews = new Map<FileAttachment, ImageAttachmentData>()
  /** 已保留的唯一预览用于累计预算检查。 */
  const uniqueImages: RequestImageInput[] = []

  /** 对单条用户消息生成独立副本，清单按原始图片顺序记录。 */
  async function project(content: string, attachments?: FileAttachment[]): Promise<{ content: string; attachments?: FileAttachment[] }> {
    input.signal?.throwIfAborted()
    /** 保留正文及非图片附件，不读取文档等其他数据。 */
    const projected: FileAttachment[] = []
    const labels: string[] = []
    let imageIndex = 0
    let attachedIndex = 0
    for (const attachment of attachments ?? []) {
      input.signal?.throwIfAborted()
      if (!isImageAttachment(attachment.mediaType)) {
        projected.push(attachment)
        continue
      }
      imageIndex++
      /** 读取失败向上传播，不能把缺图伪装成正常请求。 */
      const sourceData = readAttachment(attachment.localPath)
      const preview = await preparer.prepare({ data: sourceData, mimeType: attachment.mediaType }, input.signal)
      input.signal?.throwIfAborted()
      /** 完全相同内容才能去重；相似图片仍完整保留。 */
      const existing = seen.get(preview.imageId)
      if (existing !== undefined) {
        labels.push(`原附件图片 ${imageIndex}：重复引用图片 ${existing}（${preview.imageId}），见此前同编号附图。`)
        continue
      }
      /** 首次出现的图片获得请求内编号，保留实际附件顺序映射。 */
      const number = seen.size + 1
      seen.set(preview.imageId, number)
      attachedIndex++
      const projectedAttachment: FileAttachment = { ...attachment, mediaType: preview.mimeType }
      projected.push(projectedAttachment)
      previews.set(projectedAttachment, { data: preview.data, mediaType: preview.mimeType })
      uniqueImages.push(preview)
      assertImageRequestBudget(uniqueImages)
      /** 标明模型实际看到的尺寸与预览身份，避免误判细节或直接套用像素坐标。 */
      const previewNotice = preview.data !== sourceData ? '识图预览，细节可能受压缩影响。' : ''
      const coordinateNotice = preview.width !== preview.originalWidth || preview.height !== preview.originalHeight
        ? '坐标需按尺寸映射。' : ''
      labels.push(`原附件图片 ${imageIndex}：本消息附图 ${attachedIndex} 为图片 ${number}（${preview.imageId}）。原始编码尺寸 ${preview.originalWidth}×${preview.originalHeight}，发送尺寸 ${preview.width}×${preview.height}。${previewNotice}${coordinateNotice}`)
    }
    return {
      content: labels.length ? `${content}\n\n[图片对应清单]\n${labels.join('\n')}` : content,
      attachments: attachments ? projected : undefined,
    }
  }

  /** 按历史顺序处理，确保重复引用总指向此前已经发送的图片。 */
  const history: ChatMessage[] = []
  for (const message of input.history) {
    input.signal?.throwIfAborted()
    history.push(message.role === 'user' ? { ...message, ...await project(message.content, message.attachments) } : message)
  }
  /** 当前消息排在历史之后，保持跨消息图片编号一致。 */
  const current = await project(input.userMessage, input.attachments)
  input.signal?.throwIfAborted()
  return {
    history,
    userMessage: current.content,
    attachments: current.attachments,
    readImageAttachments: (attachments) => (attachments ?? []).flatMap((attachment) => {
      /** 同步适配器仅消费已准备的图片；不接受额外路径读取。 */
      const preview = previews.get(attachment)
      return preview ? [preview] : []
    }),
  }
}
