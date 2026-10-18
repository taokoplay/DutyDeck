import { describe, expect, test } from 'bun:test'
import sharp from 'sharp'
import {
  assertImageRequestBudget,
  assertModelRequestBudget,
  createImagePreviewPreparer,
} from './image-request-preparation'

/** 创建确定性的高熵图片；用于验证真实编码压缩，而不是模拟图片库。 */
async function noisyImage(width: number, height: number, alpha = false): Promise<Buffer> {
  /** 通道数、像素缓冲和随机种子只服务于可重复的图片夹具。 */
  const channels = alpha ? 4 : 3
  const pixels = Buffer.alloc(width * height * channels)
  let seed = 17
  for (let index = 0; index < pixels.length; index++) {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0
    pixels[index] = seed >>> 24
  }
  return sharp(pixels, { raw: { width, height, channels } }).png().toBuffer()
}

describe('模型识图预览', () => {
  test('Given 小型 UI PNG When 准备识图 Then 保留原字节、尺寸并复用缓存', async () => {
    /** 小图及对应输入验证保真路径，不替换正式素材。 */
    const bytes = await sharp({ create: { width: 64, height: 48, channels: 3, background: '#123456' } }).png().toBuffer()
    const input = { data: bytes.toString('base64'), mimeType: 'image/png' }
    const preparer = createImagePreviewPreparer()
    const result = await preparer.prepare(input)
    expect(result.data).toBe(input.data)
    expect(result).toMatchObject({ mimeType: 'image/png', width: 64, height: 48, originalWidth: 64, originalHeight: 48 })
    expect(await preparer.prepare({ ...input })).toBe(result)
    expect(result.imageId).toMatch(/^image-[a-f0-9]{64}$/)
  })

  test('Given 大型不透明 PNG When 准备识图 Then 体积减小且不改变源图', async () => {
    /** 高熵 PNG 模拟摄影类素材，保证走真实有损预览路径。 */
    const bytes = await noisyImage(1000, 800)
    const input = { data: bytes.toString('base64'), mimeType: 'image/png' }
    const original = input.data
    const result = await createImagePreviewPreparer().prepare(input)
    expect(result.data.length).toBeLessThan(original.length / 2)
    expect(result.mimeType).toBe('image/jpeg')
    expect(result).toMatchObject({ width: 1000, height: 800 })
    expect(input.data).toBe(original)
    expect((await sharp(Buffer.from(result.data, 'base64')).metadata()).width).toBe(1000)
  })

  test('Given 大型透明图 When 准备识图 Then 保留透明通道与原像素', async () => {
    /** 随机 alpha 图让无损编码路径可被逐像素验证。 */
    const bytes = await noisyImage(400, 400, true)
    const result = await createImagePreviewPreparer().prepare({ data: bytes.toString('base64'), mimeType: 'image/png' })
    const decoded = sharp(Buffer.from(result.data, 'base64'))
    expect((await decoded.metadata()).hasAlpha).toBe(true)
    expect((await decoded.raw().toBuffer()).equals(await sharp(bytes).raw().toBuffer())).toBe(true)
  })

  test('Given 长边超过 2000 When 准备预览 Then 保持比例缩放并记录原尺寸', async () => {
    /** 大尺寸低熵图验证尺寸限制不依赖文件大小。 */
    const bytes = await sharp({ create: { width: 3000, height: 1200, channels: 3, background: '#654321' } }).png().toBuffer()
    const result = await createImagePreviewPreparer().prepare({ data: bytes.toString('base64'), mimeType: 'image/png' })
    expect(result).toMatchObject({ originalWidth: 3000, originalHeight: 1200, width: 2000, height: 800 })
  })

  test('Given 损坏图或伪造 MIME When 准备识图 Then 明确失败而非无声遗漏', async () => {
    /** 正常 PNG 用于证明 MIME 与真实内容必须匹配。 */
    const bytes = await sharp({ create: { width: 2, height: 2, channels: 3, background: '#ffffff' } }).png().toBuffer()
    const preparer = createImagePreviewPreparer()
    await expect(preparer.prepare({ data: 'not base64', mimeType: 'image/png' })).rejects.toThrow('IMAGE_REQUEST_INVALID')
    await expect(preparer.prepare({ data: bytes.toString('base64'), mimeType: 'image/jpeg' })).rejects.toThrow('IMAGE_REQUEST_INVALID')
  })

  test('Given 超像素图 When 准备识图 Then 在完整解码前拒绝', async () => {
    /** 高压缩的超大尺寸图片验证不能只限制文件字节。 */
    const bytes = await sharp({ create: { width: 6000, height: 6000, channels: 3, background: '#ffffff' } }).png().toBuffer()
    await expect(createImagePreviewPreparer().prepare({ data: bytes.toString('base64'), mimeType: 'image/png' })).rejects.toThrow('IMAGE_REQUEST_INVALID')
  })

  test('Given 已取消信号 When 命中缓存或首次转换 Then 均拒绝继续', async () => {
    /** 缓存命中不能绕过用户取消。 */
    const bytes = await sharp({ create: { width: 2, height: 2, channels: 3, background: '#ffffff' } }).png().toBuffer()
    const input = { data: bytes.toString('base64'), mimeType: 'image/png' }
    const preparer = createImagePreviewPreparer()
    await preparer.prepare(input)
    await expect(preparer.prepare(input, AbortSignal.abort())).rejects.toThrow()
    await expect(createImagePreviewPreparer().prepare(input, AbortSignal.abort())).rejects.toThrow()
  })

  test('Given 头部完整但像素流截断的 PNG When 小图原样路径 Then 也必须拒绝', async () => {
    /** metadata 能读取尺寸，不代表图片像素流完整。 */
    const bytes = await noisyImage(32, 32)
    const truncated = bytes.subarray(0, Math.floor(bytes.length / 2))
    await expect(createImagePreviewPreparer().prepare({ data: truncated.toString('base64'), mimeType: 'image/png' })).rejects.toThrow('IMAGE_REQUEST_INVALID')
  })

  test('Given 超过 64 个不同小图 When 重读最旧图片 Then 重新准备且身份不变', async () => {
    /** 内容身份独立于有界缓存，淘汰缓存不等于淘汰模型图片。 */
    const preparer = createImagePreviewPreparer()
    const firstBytes = await sharp({ create: { width: 2, height: 2, channels: 3, background: { r: 0, g: 0, b: 0 } } }).png().toBuffer()
    const firstInput = { data: firstBytes.toString('base64'), mimeType: 'image/png' }
    const first = await preparer.prepare(firstInput)
    for (let index = 1; index <= 64; index++) {
      const bytes = await sharp({ create: { width: 2, height: 2, channels: 3, background: { r: index, g: 0, b: 0 } } }).png().toBuffer()
      await preparer.prepare({ data: bytes.toString('base64'), mimeType: 'image/png' })
    }
    const reloaded = await preparer.prepare(firstInput)
    expect(reloaded).not.toBe(first)
    expect(reloaded.imageId).toBe(first.imageId)
    expect(reloaded.data).toBe(first.data)
  })
})

describe('模型请求字节预算', () => {
  test('Given 每张图合格但总量超限 When 检查图片 Then 按 Base64 合计阻断', () => {
    /** 已编码图片数据用边界尺寸验证多图预算，不触发真实解码。 */
    const image = { data: 'a'.repeat(4 * 1024 * 1024), mimeType: 'image/png' }
    expect(() => assertImageRequestBudget([image, image, image])).not.toThrow()
    expect(() => assertImageRequestBudget([image, image, image, { ...image, data: 'a' }])).toThrow('IMAGE_REQUEST_BUDGET_EXCEEDED')
  })

  test('Given UTF-8 大请求 When 检查完整 payload Then 按字节而非字符数阻断', () => {
    /** 多字节中文暴露按字符串 length 计算预算的错误。 */
    expect(() => assertModelRequestBudget({ messages: [{ content: '中'.repeat(6 * 1024 * 1024) }] })).toThrow('MODEL_REQUEST_BUDGET_EXCEEDED')
    expect(() => assertModelRequestBudget('x'.repeat(16 * 1024 * 1024))).not.toThrow()
    expect(() => assertModelRequestBudget('x'.repeat(16 * 1024 * 1024 + 1))).toThrow('MODEL_REQUEST_BUDGET_EXCEEDED')
    expect(() => assertModelRequestBudget({ model: 'example', messages: [] })).not.toThrow()
  })
})
