import { createHash } from 'node:crypto'
import sharp from 'sharp'

/** 请求投影接收的图片；原始素材及会话记录不在此处改写。 */
export interface RequestImageInput {
  /** 图片的 Base64 正文，不含 data URL 前缀。 */
  data: string
  /** 与源字节一致的图片 MIME。 */
  mimeType: string
}

/** 模型可见预览及其原图身份，供请求内编号和重复图片引用。 */
export interface RequestImagePreview extends RequestImageInput {
  /** 基于原始字节的完整 SHA-256，不能用文件路径代替内容身份。 */
  imageId: string
  /** 编码前源图的尺寸。 */
  originalWidth: number
  originalHeight: number
  /** 实际发送预览的尺寸。 */
  width: number
  height: number
}

/** 每次运行独立的预览缓存接口。 */
export interface ImagePreviewPreparer {
  /** 准备模型识图副本；取消、损坏或超资源限制时明确失败。 */
  prepare(input: RequestImageInput, signal?: AbortSignal): Promise<RequestImagePreview>
}

/** 客户端保守预算，独立于模型 token 窗口和渠道实际限制。 */
const MAX_IMAGE_BASE64_BYTES = 12 * 1024 * 1024
const MAX_REQUEST_BYTES = 16 * 1024 * 1024
/** 单图解码资源上限，避免高压缩大尺寸图片占用过多内存。 */
const MAX_SOURCE_BYTES = 64 * 1024 * 1024
const MAX_SOURCE_PIXELS = 32_000_000
/** 不比 Pi 既有默认尺寸更激进；小图和能满足目标的无损图保持保真。 */
const MAX_PREVIEW_EDGE = 2000
const LOSSLESS_TARGET_BASE64_BYTES = 512 * 1024
/** 每个运行最多保留 32 MiB 的编码预览，不缓存原始图片。 */
const MAX_CACHE_BYTES = 32 * 1024 * 1024
const MAX_CACHE_ENTRIES = 64
/** MIME 必须与 sharp 识别的容器一致，拒绝伪造类型。 */
const IMAGE_FORMATS: Readonly<Record<string, string>> = {
  'image/png': 'png', 'image/jpeg': 'jpeg', 'image/webp': 'webp', 'image/gif': 'gif',
}

/** 将资源或解码失败转成明确错误，调用方不得静默丢图。 */
function invalidImage(): Error {
  return new Error('IMAGE_REQUEST_INVALID: 图片损坏、格式不匹配或超过识图资源限制，请重新选择图片。')
}

/** 校验并解码有界 Base64，避免 Buffer 的宽松解码吞掉非法内容。 */
function decodeImage(input: RequestImageInput): Buffer {
  if (!IMAGE_FORMATS[input.mimeType]
    || input.data.length === 0
    || input.data.length > Math.ceil(MAX_SOURCE_BYTES / 3) * 4
    || input.data.length % 4 !== 0
    || !/^[A-Za-z0-9+/]*={0,2}$/.test(input.data)) throw invalidImage()
  /** 长度和填充复核保证有效源字节不超过上限。 */
  const bytes = Buffer.from(input.data, 'base64')
  if (bytes.length === 0 || bytes.length > MAX_SOURCE_BYTES) throw invalidImage()
  return bytes
}

/** 检查实际准备发送的图片块总量；不猜测哪些图对任务不重要。 */
export function assertImageRequestBudget(images: readonly RequestImageInput[]): void {
  /** 增量计量避免另外拼接一个大字符串。 */
  let totalBytes = 0
  for (const image of images) {
    totalBytes += Buffer.byteLength(image.data, 'utf8')
    if (totalBytes > MAX_IMAGE_BASE64_BYTES) {
      throw new Error('IMAGE_REQUEST_BUDGET_EXCEEDED: 图片预览合计超过 12 MiB，请减少本次图片、分批比较或在新会话继续；未自动丢弃任何图片。')
    }
  }
}

/**
 * 检查 provider 完整逻辑 payload 或已序列化请求的 UTF-8 字节数。
 * @param payload Provider onPayload 对象，或 Chat 已构建的 JSON 正文。
 * @remarks Google SDK/部分 WebSocket 还会增加封装，此处是客户端 payload 预算，非抓包计量。
 */
export function assertModelRequestBudget(payload: unknown): void {
  /** 对已经序列化的正文不能再次 stringify，否则会重复计入转义。 */
  const serialized = typeof payload === 'string' ? payload : JSON.stringify(payload)
  if (serialized !== undefined && Buffer.byteLength(serialized, 'utf8') > MAX_REQUEST_BYTES) {
    throw new Error('MODEL_REQUEST_BUDGET_EXCEEDED: 请求内容超过 16 MiB 客户端预算，请压缩上下文、减少图片或在新会话继续。')
  }
}

/**
 * 创建运行级有界缓存；相同源图只编码一次，返回值不能修改。
 * @returns 异步预览准备器；所有文件读取和授权仍由原调用方负责。
 */
export function createImagePreviewPreparer(): ImagePreviewPreparer {
  /** LRU 只保留预览字符串，运行结束后随闭包回收。 */
  const cache = new Map<string, RequestImagePreview>()
  let cacheBytes = 0

  return {
    async prepare(input, signal) {
      signal?.throwIfAborted()
      /** 哈希使用原始字节，不使用有损预览，防止不同原图被误合并。 */
      const source = decodeImage(input)
      const imageId = `image-${createHash('sha256').update(source).digest('hex')}`
      const cacheKey = `${input.mimeType}:${imageId}`
      const cached = cache.get(cacheKey)
      if (cached) {
        cache.delete(cacheKey)
        cache.set(cacheKey, cached)
        return cached
      }

      /** 所有编码顺序执行，避免同时保留多个大像素缓冲。 */
      let preview: RequestImagePreview
      try {
        const metadata = await sharp(source, { animated: false, limitInputPixels: MAX_SOURCE_PIXELS, failOn: 'warning' }).metadata()
        if (!metadata.width || !metadata.height || metadata.width * metadata.height > MAX_SOURCE_PIXELS
          || metadata.format !== IMAGE_FORMATS[input.mimeType]) throw invalidImage()
        signal?.throwIfAborted()
        const originalWidth = metadata.width
        const originalHeight = metadata.height
        const requiresResize = originalWidth > MAX_PREVIEW_EDGE || originalHeight > MAX_PREVIEW_EDGE
        if (!requiresResize && input.data.length <= LOSSLESS_TARGET_BASE64_BYTES) {
          // metadata 只验证头部；原样发送前仍完整解码一次，防止截断小图绕过检查。
          await sharp(source, { animated: false, limitInputPixels: MAX_SOURCE_PIXELS, failOn: 'warning' }).raw().toBuffer()
          signal?.throwIfAborted()
          preview = { ...input, imageId, originalWidth, originalHeight, width: originalWidth, height: originalHeight }
        } else {
          /** 先尝试无损 PNG，保留文本、透明通道及完全透明像素下的 RGB。 */
          const pipeline = sharp(source, { animated: false, limitInputPixels: MAX_SOURCE_PIXELS, failOn: 'warning' })
            .rotate().resize({ width: MAX_PREVIEW_EDGE, height: MAX_PREVIEW_EDGE, fit: 'inside', withoutEnlargement: true })
          // PNG 候选避免先耗费数秒尝试摄影图无损 WebP，再丢掉该编码改用 JPEG。
          const lossless = await pipeline.png().toBuffer({ resolveWithObject: true })
          signal?.throwIfAborted()
          let encoded = lossless.data
          let mimeType = 'image/png'
          let width = lossless.info.width
          let height = lossless.info.height
          if (!metadata.hasAlpha && Math.ceil(encoded.length / 3) * 4 > LOSSLESS_TARGET_BASE64_BYTES) {
            /** 摄影等不透明大图使用高质量 JPEG；小字图优先走上方无损分支。 */
            const lossy = await sharp(source, { animated: false, limitInputPixels: MAX_SOURCE_PIXELS, failOn: 'warning' })
              .rotate().resize({ width: MAX_PREVIEW_EDGE, height: MAX_PREVIEW_EDGE, fit: 'inside', withoutEnlargement: true })
              .jpeg({ quality: 85 }).toBuffer({ resolveWithObject: true })
            if (lossy.data.length < encoded.length) {
              encoded = lossy.data
              mimeType = 'image/jpeg'
              width = lossy.info.width
              height = lossy.info.height
            }
          }
          signal?.throwIfAborted()
          /** 任何无需缩放的图都不因为预览编码反而增大。 */
          preview = !requiresResize && source.length <= encoded.length
            ? { ...input, imageId, originalWidth, originalHeight, width: originalWidth, height: originalHeight }
            : { data: encoded.toString('base64'), mimeType, imageId, originalWidth, originalHeight, width, height }
        }
      } catch (error) {
        signal?.throwIfAborted()
        throw invalidImage()
      }
      signal?.throwIfAborted()
      Object.freeze(preview)
      /** 单条超过缓存预算时不缓存；请求合计预算仍由最终投影检查。 */
      const previewBytes = Buffer.byteLength(preview.data, 'utf8')
      if (previewBytes <= MAX_CACHE_BYTES) {
        while (cache.size >= MAX_CACHE_ENTRIES || cacheBytes + previewBytes > MAX_CACHE_BYTES) {
          const oldestKey = cache.keys().next().value
          if (oldestKey === undefined) break
          cacheBytes -= Buffer.byteLength(cache.get(oldestKey)!.data, 'utf8')
          cache.delete(oldestKey)
        }
        cache.set(cacheKey, preview)
        cacheBytes += previewBytes
      }
      return preview
    },
  }
}
