import type { Agent } from '@earendil-works/pi-agent-core'
import { createAssistantMessageEventStream } from '@earendil-works/pi-ai'
import type {
  Api,
  AssistantMessage,
  AssistantMessageEventStream,
  ImageContent,
  Message,
  Model,
  TextContent,
  TranscriptContext,
} from '@earendil-works/pi-ai'
import {
  assertImageRequestBudget,
  assertModelRequestBudget,
  createImagePreviewPreparer,
} from '../image-request-preparation'
import type { ImagePreviewPreparer } from '../image-request-preparation'

/**
 * 为本次 provider 请求创建图片副本；不同原图全部保留，重复图用原始内容身份引用。
 * @param context 已经过所有原上下文转换的最终 transcript。
 * @param preparer 当前运行独享的有界预览缓存。
 * @param signal 当前请求取消信号。
 * @returns 不修改原消息、工具配对或持久化 artifact 的请求投影。
 */
async function prepareImageContext(
  context: TranscriptContext,
  preparer: ImagePreviewPreparer,
  signal?: AbortSignal,
): Promise<TranscriptContext> {
  signal?.throwIfAborted()
  /** 图片身份仅在本次请求内去重；后续“继续”仍能看见全部唯一图片。 */
  const imageIds = new Set<string>()
  /** 只计量本次实际发送的预览，不将重复引用文字当成图片。 */
  const images: ImageContent[] = []
  /** 按原顺序复制消息，保留系统提示、工具调用及结果的对应关系。 */
  const messages: Message[] = []
  for (const message of context.messages) {
    if ((message.role !== 'user' && message.role !== 'toolResult')
      || !Array.isArray(message.content)
      || !message.content.some(block => block.type === 'image')) {
      messages.push(message)
      continue
    }

    /** 只有含图片的消息需要复制内容数组，普通文本块复用原对象。 */
    const content: Array<TextContent | ImageContent> = []
    for (const block of message.content) {
      signal?.throwIfAborted()
      if (block.type !== 'image') {
        content.push(block)
        continue
      }
      /** 预览身份来自原始字节 SHA-256，不能因有损编码碰巧相同而合并原图。 */
      const preview = await preparer.prepare(block, signal)
      if (imageIds.has(preview.imageId)) {
        content.push({ type: 'text', text: `[重复图片 ${preview.imageId}：与本次请求前方已提供的同编号图片完全相同，请使用该图片。]` })
        continue
      }
      imageIds.add(preview.imageId)
      /** 图片编号与尺寸提示让模型了解识图副本，同时明确原文件没有变化。 */
      const image: ImageContent = { type: 'image', data: preview.data, mimeType: preview.mimeType }
      /** 同尺寸有损编码也须提示细节风险，不能只依靠尺寸变化说明。 */
      const detailNotice = preview.data === block.data ? '' : '预览经过压缩或缩放，细节可能受影响；'
      content.push({
        type: 'text',
        text: `[图片 ${preview.imageId}：识图预览 ${preview.width}×${preview.height}，原图 ${preview.originalWidth}×${preview.originalHeight}；${detailNotice}原始素材未修改。]`,
      }, image)
      images.push(image)
      // 唯一预览一旦超出合计预算就停止，避免继续解码本次不可能发送的后续历史。
      assertImageRequestBudget(images)
    }
    messages.push({ ...message, content })
  }
  signal?.throwIfAborted()
  return { ...context, messages }
}

/**
 * 将请求准备失败转换为 Pi 标准终态，避免从 transformContext 抛错破坏运行事件。
 * @param model 当前请求模型，只用于保持原有错误来源与统计字段。
 * @param error 准备或启动请求时的错误，不包含图片正文。
 * @param signal 当前请求取消信号。
 * @returns 可被主 Agent 与 compaction 正常消费的错误事件流。
 */
function failedRequestStream(model: Model<Api>, error: unknown, signal?: AbortSignal): AssistantMessageEventStream {
  /** 取消独立于图片失败，不将用户停止误报为素材损坏。 */
  const aborted = signal?.aborted === true || (error instanceof Error && error.name === 'AbortError')
  /** 同一个终态同时用于消息与事件，避免两者状态不一致。 */
  const stopReason: 'aborted' | 'error' = aborted ? 'aborted' : 'error'
  /** 请求未产生模型输出，不伪造 token 使用量。 */
  const message: AssistantMessage = {
    role: 'assistant', content: [], api: model.api, provider: model.provider, model: model.id,
    stopReason,
    errorMessage: aborted ? '请求已取消' : error instanceof Error ? error.message : String(error),
    timestamp: Date.now(),
    usage: {
      reported: false, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
  }
  /** 直接 error 终态是 Pi 支持的请求准备失败协议，无需伪造 start 或正文。 */
  const stream = createAssistantMessageEventStream()
  stream.push({ type: 'error', reason: stopReason, error: message })
  return stream
}

/**
 * 在所有工具及上下文钩子安装完后接入图片预览和 payload 预算。
 * @param agent 当前运行的 Pi Agent；只包裹请求函数，保持全部既有 transform 与权限钩子。
 * @remarks 主循环与 compaction 都使用 streamFunction；单改 agent.onPayload 会漏掉后者。
 */
export function installPiImageRequestPolicy(agent: Pick<Agent, 'streamFunction'>): void {
  /** 缓存跟随此次运行回收，容量由公共准备器限制。 */
  const preparer = createImagePreviewPreparer()
  /** 原函数包含渠道配置、身份验证和请求级代理，必须保持原调用链。 */
  const previousStream = agent.streamFunction
  agent.streamFunction = async (model, context, options) => {
    try {
      options?.signal?.throwIfAborted()
      /** 最终投影包含 Canvas 等更早钩子临时注入的图片，且不会进入原始 transcript。 */
      const preparedContext = model.input.includes('image')
        ? await prepareImageContext(context, preparer, options?.signal)
        : context
      // 纯文本模型保留原 provider/视觉中继的处理方式，不提前校验其本来不会发送的图片。
      options?.signal?.throwIfAborted()
      return await previousStream(model, preparedContext, {
        ...options,
        onPayload: async (payload, requestModel) => {
          options?.signal?.throwIfAborted()
          /** 先尊重原 reasoning/service-tier 等回调，再按其真实返回结果计量。 */
          const replacement = await options?.onPayload?.(payload, requestModel)
          /** 仅 undefined 表示沿用原值，保留 SDK 对所有其他返回值的语义。 */
          const preparedPayload = replacement === undefined ? payload : replacement
          options?.signal?.throwIfAborted()
          // 这是 provider 逻辑 payload 的完整 UTF-8 预算。Google SDK 与 Codex WebSocket
          // 仍可能另加协议封装，不能把此数冒充抓包字节或渠道承诺的上限。
          assertModelRequestBudget(preparedPayload)
          return preparedPayload
        },
      })
    } catch (error) {
      return failedRequestStream(model, error, options?.signal)
    }
  }
}
