import { describe, expect, test } from 'bun:test'
import type { MediaAssetRef, MediaGenerationRequest } from '@dutydeck/shared'
import { createUnifiedMediaHttpAdapters } from './unified-media-http-adapters'
import type { UnifiedMediaModelRoute } from './unified-media-model-catalog'

const request: MediaGenerationRequest = { projectId: 'p', operationId: 'o', modelRef: 'media:audio:minimax:audio:speech', prompt: '你好', inputs: {} }
function route(adapterId: string, kind: 'audio' | 'video' | 'image'): UnifiedMediaModelRoute {
  return { option: { ref: request.modelRef, name: 'model', kind, provider: 'minimax', profileId: 'audio', modelId: 'speech', capabilities: [], available: true, adapterId }, ref: { kind, provider: 'minimax', profileId: 'audio', modelId: 'speech' }, baseUrl: 'https://api.example.test/v1', apiKey: 'key' }
}

describe('统一媒体 HTTP 执行器', () => {
  test('Given OpenAI Images 返回 b64_json When 生成 Then 解析图片字节', async () => {
    const adapters = createUnifiedMediaHttpAdapters({ fetch: async () => new Response(JSON.stringify({ data: [{ b64_json: Buffer.from('image').toString('base64') }] }), { status: 200 }) })
    const output = await adapters.find((adapter) => adapter.id === 'openai-images')!.generate({ request: { ...request, modelRef: 'media:image:openai-images:image:gpt-image-1' }, route: { ...route('openai-images', 'image'), ref: { kind: 'image', provider: 'openai-images', profileId: 'image', modelId: 'gpt-image-1' }, option: { ...route('openai-images', 'image').option, ref: 'media:image:openai-images:image:gpt-image-1', provider: 'openai-images', modelId: 'gpt-image-1', kind: 'image' } }, signal: new AbortController().signal })
    expect(new TextDecoder().decode(output[0]!.bytes)).toBe('image')
  })

  test('Given MiniMax Speech 返回 base64 When 生成 Then 解析为音频字节', async () => {
    const requests: Request[] = []
    const adapters = createUnifiedMediaHttpAdapters({ fetch: async (input, init) => {
      requests.push(new Request(input, init))
      return new Response(JSON.stringify({ data: { audio: Buffer.from('voice').toString('base64') }, base_resp: { status_code: 0 } }), { status: 200 })
    } })
    const output = await adapters.find((adapter) => adapter.id === 'minimax-speech')!.generate({ request, route: route('minimax-speech', 'audio'), signal: new AbortController().signal })
    expect(new TextDecoder().decode(output[0]!.bytes)).toBe('voice')
    expect(requests[0]!.url).toBe('https://api.example.test/v1/t2a_v2')
  })

  test('Given MiniMax Video 异步任务 When 查询成功 Then 下载视频字节', async () => {
    let calls = 0
    const adapters = createUnifiedMediaHttpAdapters({ pollIntervalMs: 0, timeoutMs: 2_000, fetch: async (input) => {
      calls += 1
      const url = String(input)
      if (url.endsWith('/video_generation')) return new Response(JSON.stringify({ task_id: 'task-1', base_resp: { status_code: 0 } }), { status: 200 })
      if (url.includes('/query/video_generation')) return new Response(JSON.stringify({ status: 'Success', video_url: 'https://cdn.example.test/video.mp4' }), { status: 200 })
      return new Response(new Uint8Array([9, 8, 7]), { status: 200, headers: { 'content-type': 'video/mp4' } })
    } })
    const output = await adapters.find((adapter) => adapter.id === 'minimax-video')!.generate({ request, route: route('minimax-video', 'video'), signal: new AbortController().signal })
    expect([...output[0]!.bytes]).toEqual([9, 8, 7])
    expect(calls).toBe(3)
  })
})

/** 三个支持图片参考的执行器共用同一输入合同。 */
const referenceAdapters = ['openai-images', 'minimax-image', 'minimax-video'] as const
/** 图片签名夹具用于验证上传 MIME，不触碰真实供应商。 */
const referenceImages = [
  { bytes: Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), mime: 'image/png', extension: '.png' },
  { bytes: Buffer.from([0xff, 0xd8, 0xff]), mime: 'image/jpeg', extension: '.jpg' },
  { bytes: Buffer.from('RIFF0000WEBP'), mime: 'image/webp', extension: '.webp' },
  { bytes: Buffer.from('GIF89a'), mime: 'image/gif', extension: '.gif' },
]
/** 已授权图片引用；格式以读取的字节为准。 */
const referenceAsset: MediaAssetRef = { assetId: 'reference', revision: 1, hash: 'hash', mediaKind: 'image' }

for (const adapterId of referenceAdapters) {
  describe(`${adapterId} 图片参考合同`, () => {
    for (const scenario of ['multiple', 'audio', 'video', 'invalid-bytes', 'wrong-bytes', 'read-failure', 'missing-reader'] as const) {
      test(`Given ${scenario} 参考 When 生成 Then 明确拒绝且不请求供应商`, async () => {
        /** 记录供应商调用次数，确保失败不能退化成无参考生成。 */
        let fetchCalls = 0
        /** 构造对应边界输入；两个输入字段不能被静默截断。 */
        const inputs: MediaGenerationRequest['inputs'] = {
          reference: { kind: 'asset', asset: { ...referenceAsset, mediaKind: scenario === 'audio' || scenario === 'video' ? scenario : 'image' } },
          ...(scenario === 'multiple' ? { second: { kind: 'asset' as const, asset: { ...referenceAsset, assetId: 'second' } } } : {}),
        }
        /** 注入隔离读取器，覆盖声明类型与字节类型不一致。 */
        const adapters = createUnifiedMediaHttpAdapters({
          fetch: async () => { fetchCalls += 1; throw new Error('UNEXPECTED_FETCH') },
          readAsset: scenario === 'missing-reader' ? undefined : async () => {
            if (scenario === 'read-failure') throw new Error('READ_FAILED')
            return scenario === 'invalid-bytes' ? Buffer.from('invalid') : scenario === 'wrong-bytes' ? Buffer.from('ID3') : referenceImages[0]!.bytes
          },
        })
        /** 明确错误码让调用方知道输入不可用而非上游生成失败。 */
        const expected = scenario === 'multiple' ? 'MEDIA_GENERATION_MULTIPLE_REFERENCES_UNSUPPORTED'
          : scenario === 'read-failure' ? 'READ_FAILED'
            : scenario === 'missing-reader' ? 'MEDIA_GENERATION_ASSET_UNAVAILABLE' : 'MEDIA_GENERATION_REFERENCE_IMAGE_REQUIRED'
        await expect(adapters.find((adapter) => adapter.id === adapterId)!.generate({ request: { ...request, inputs }, route: route(adapterId, adapterId === 'minimax-video' ? 'video' : 'image'), signal: new AbortController().signal })).rejects.toThrow(expected)
        expect(fetchCalls).toBe(0)
      })
    }

    for (const image of referenceImages) {
      test(`Given 单张 ${image.mime} When 生成 Then 使用真实 MIME 和完整参考字节`, async () => {
        /** 捕获请求体以验证图片编辑、角色参考和视频首帧三个入口。 */
        let referenceBody: BodyInit | null | undefined
        /** 捕获请求路径，防止图片编辑错误降级为文生图。 */
        let submitUrl = ''
        const adapters = createUnifiedMediaHttpAdapters({
          readAsset: async () => image.bytes,
          fetch: async (input, init) => {
            if (!init?.body) return new Response(new Uint8Array([9]), { headers: { 'content-type': 'video/mp4' } })
            referenceBody = init.body
            submitUrl = String(input)
            return new Response(JSON.stringify(adapterId === 'minimax-video'
              ? { video_url: 'https://cdn.example.test/video.mp4' }
              : { data: [{ b64_json: Buffer.from('output').toString('base64') }] }))
          },
        })
        await adapters.find((adapter) => adapter.id === adapterId)!.generate({ request: { ...request, inputs: { reference: { kind: 'asset', asset: referenceAsset } } }, route: route(adapterId, adapterId === 'minimax-video' ? 'video' : 'image'), signal: new AbortController().signal })
        if (adapterId === 'openai-images') {
          expect(submitUrl).toEndWith('/images/edits')
          expect(referenceBody).toBeInstanceOf(FormData)
          /** multipart 文件必须同时保留媒体类型、扩展名和字节。 */
          const file = (referenceBody as FormData).get('image') as File
          expect(file.type).toBe(image.mime)
          expect(file.name).toBe(`reference${image.extension}`)
          expect(Buffer.from(await file.arrayBuffer())).toEqual(image.bytes)
        } else {
          /** JSON 两种参考字段都必须包含真实 MIME 的 data URL。 */
          const body = JSON.parse(String(referenceBody)) as { first_frame_image?: string; subject_reference?: Array<{ image_file: string }> }
          expect(adapterId === 'minimax-video' ? body.first_frame_image : body.subject_reference?.[0]?.image_file).toBe(`data:${image.mime};base64,${image.bytes.toString('base64')}`)
        }
      })
    }
  })
}
