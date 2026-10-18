import { describe, expect, mock, test } from 'bun:test'
import sharp from 'sharp'
import { randomBytes } from 'node:crypto'
import { getAdapter } from '@dutydeck/core'
import type { ChatMessage, FileAttachment } from '@dutydeck/shared'
/** 隔离原生窗口导入；图片转换与适配器使用生产实现。 */
mock.module('electron', () => ({ dialog: {}, BrowserWindow: class {} }))
const { prepareChatImageRequest } = await import('./chat-image-request-preparation')

/** 创建测试附件；路径仅作为注入读取器的键。 */
function attachment(id: string): FileAttachment {
  return { id, filename: `${id}.png`, mediaType: 'image/png', localPath: id, size: 10 }
}
/** 创建真实 PNG 字节，验证预览 MIME 与内容相符。 */
async function png(background: string): Promise<string> {
  return (await sharp({ create: { width: 20, height: 20, channels: 3, background } }).png().toBuffer()).toString('base64')
}

describe('Chat 图片请求投影', () => {
  test('Given 历史与当前包含重复和不同图 When 构建真实供应商请求 Then 保留每张唯一图及原位置引用且原附件不变', async () => {
    /** 真实图片夹具。 */
    const red = await png('red')
    const blue = await png('blue')
    /** 原始业务附件与历史快照。 */
    const original = [attachment('red'), attachment('blue'), attachment('red-copy')]
    const history: ChatMessage[] = [{ id: 'h', role: 'user', content: '参考', createdAt: 1, attachments: [attachment('red')] }]
    const snapshot = JSON.stringify({ original, history })
    const prepared = await prepareChatImageRequest({ history, userMessage: '比较所有图片', attachments: original,
      readAttachment: (path) => path === 'blue' ? blue : red })
    for (const provider of ['openai', 'anthropic', 'google', 'openai-responses'] as const) {
      const request = getAdapter(provider).buildStreamRequest({ baseUrl: 'https://example.test', apiKey: 'test', modelId: 'test', ...prepared })
      const serialized = request.body
      expect(serialized).toContain('重复引用')
      expect(serialized).toContain('图片 1')
      expect(serialized).toContain('图片 2')
      expect(serialized).toContain('比较所有图片')
      const images = [...prepared.history.flatMap((message) => prepared.readImageAttachments(message.attachments)), ...prepared.readImageAttachments(prepared.attachments)]
      expect(images).toHaveLength(2)
      expect(prepared.history).toHaveLength(1)
      expect(prepared.history[0]?.content).toContain('本消息附图 1 为图片 1')
      expect(prepared.userMessage).toContain('原附件图片 1：重复引用图片 1')
      expect(prepared.userMessage).toContain('原附件图片 2：本消息附图 1 为图片 2')
      expect(prepared.userMessage).toContain('原附件图片 3：重复引用图片 1')
      for (const image of images) expect(serialized.split(image.data)).toHaveLength(2)
      for (const image of images) {
        const metadata = await sharp(Buffer.from(image.data, 'base64')).metadata()
        expect(image.mediaType).toBe(`image/${metadata.format}`)
      }
    }
    expect(JSON.stringify({ original, history })).toBe(snapshot)
  })

  test('Given 同一消息含两张不同图 When 供应商构建请求 Then 附图次序与编号一一对应', async () => {
    /** 两个独立内容的图片输入。 */
    const first = await png('red')
    const second = await png('blue')
    const prepared = await prepareChatImageRequest({ history: [], userMessage: '比较', attachments: [attachment('first'), attachment('second')],
      readAttachment: (path) => path === 'first' ? first : second })
    expect(prepared.userMessage).toContain('原附件图片 1：本消息附图 1 为图片 1')
    expect(prepared.userMessage).toContain('原附件图片 2：本消息附图 2 为图片 2')
    for (const provider of ['openai', 'anthropic', 'google', 'openai-responses'] as const) {
      const body = getAdapter(provider).buildStreamRequest({ baseUrl: 'https://example.test', apiKey: 'test', modelId: 'test', ...prepared }).body
      expect(body.indexOf(first)).toBeGreaterThan(-1)
      expect(body.indexOf(second)).toBeGreaterThan(body.indexOf(first))
    }
  })

  test('Given 大图被缩小 When 生成图片清单 Then 明示原始与发送尺寸及预览坐标限制', async () => {
    /** 超过预览最长边的真实图片，只通过注入读取器读取一次。 */
    const original = (await sharp({ create: { width: 3000, height: 1200, channels: 3, background: 'red' } }).png().toBuffer()).toString('base64')
    let reads = 0
    const prepared = await prepareChatImageRequest({ history: [], userMessage: '检查细节', attachments: [attachment('large')],
      readAttachment: () => { reads++; return original } })
    expect(reads).toBe(1)
    expect(prepared.userMessage).toContain('原始编码尺寸 3000×1200')
    expect(prepared.userMessage).toContain('发送尺寸 2000×800')
    expect(prepared.userMessage).toContain('识图预览，细节可能受压缩影响')
    expect(prepared.userMessage).toContain('坐标需按尺寸映射')
  })

  test('Given 小图字节保持不变 When 生成图片清单 Then 标注尺寸且不误称压缩', async () => {
    /** 小图满足原样发送阈值。 */
    const original = await png('red')
    const prepared = await prepareChatImageRequest({ history: [], userMessage: '检查', attachments: [attachment('small')], readAttachment: () => original })
    expect(prepared.userMessage).toContain('原始编码尺寸 20×20')
    expect(prepared.userMessage).toContain('发送尺寸 20×20')
    expect(prepared.userMessage).not.toContain('细节可能受压缩影响')
    expect(prepared.userMessage).not.toContain('坐标需按尺寸映射')
  })

  test('Given 多张不同图片累计超过12MiB预算 When 准备请求 Then 明确拒绝而不是丢弃比较对象', async () => {
    /** 小于单张预览阈值的真实噪声 PNG，避免纯色压缩掩盖累计大小。 */
    const base = await sharp(randomBytes(500 * 250 * 3), { raw: { width: 500, height: 250, channels: 3 } }).png().toBuffer()
    /** 用合法 PNG 文本元数据产生不同原始内容，仍维持可解码图片。 */
    const data = new Map<string, string>()
    for (let index = 0; index < 30; index++) {
      data.set(String(index), (await sharp(base).withMetadata({ exif: { IFD0: { ImageDescription: String(index) } } }).png().toBuffer()).toString('base64'))
    }
    /** 约 11.5 MiB 的预览应通过新预算，证明没有残留旧 8 MiB 阈值。 */
    const withinBudget = await prepareChatImageRequest({ history: [], userMessage: '比较24张', attachments: [...data.keys()].slice(0, 24).map(attachment),
      readAttachment: (path) => data.get(path)! })
    expect(withinBudget.readImageAttachments(withinBudget.attachments)).toHaveLength(24)
    await expect(prepareChatImageRequest({ history: [], userMessage: '同时比较全部图片', attachments: [...data.keys()].map(attachment),
      readAttachment: (path) => data.get(path)! })).rejects.toThrow('IMAGE_REQUEST_BUDGET_EXCEEDED')
  })

  test('Given 无法读取图片 When 准备请求 Then 明确失败且不静默遗漏', async () => {
    await expect(prepareChatImageRequest({ history: [], userMessage: '看图', attachments: [attachment('missing')],
      readAttachment: () => { throw new Error('附件文件不存在') } })).rejects.toThrow('附件文件不存在')
  })

  test('Given 已取消 When 准备请求 Then 不读取或发送图片', async () => {
    const controller = new AbortController()
    controller.abort()
    let reads = 0
    await expect(prepareChatImageRequest({ history: [], userMessage: '看图', attachments: [attachment('red')], signal: controller.signal,
      readAttachment: () => { reads++; return '' } })).rejects.toThrow()
    expect(reads).toBe(0)
  })

  test('Given 非图片附件 When 准备请求 Then 不读取且保留正文', async () => {
    const prepared = await prepareChatImageRequest({ history: [], userMessage: '文档正文', attachments: [{ ...attachment('doc'), mediaType: 'text/plain' }],
      readAttachment: () => { throw new Error('不应读取') } })
    expect(prepared.userMessage).toBe('文档正文')
    expect(prepared.readImageAttachments(prepared.attachments)).toEqual([])
  })
})
