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

describe('参数与安全失败合同', () => {
  for (const id of ['openai-images', 'minimax-image', 'minimax-video', 'minimax-speech', 'xiaomi-speech']) {
    test(`Given ${id} 未知参数 When 预处理 Then 请求前拒绝`, () => {
      /** 不应触发任何网络调用。 */
      const adapter = createUnifiedMediaHttpAdapters().find(item => item.id === id)!
      expect(() => adapter.prepareInputs!({ request: { ...request, inputs: { duration: { kind: 'scalar', value: 5 } } }, route: route(id, 'image') })).toThrow('MEDIA_GENERATION_PARAMETER_UNSUPPORTED')
    })
  }
  for (const [status, code] of [[401, 'AUTH_FAILED'], [403, 'AUTH_FAILED'], [402, 'QUOTA_EXCEEDED'], [429, 'RATE_LIMITED'], [503, 'TEMPORARY_FAILURE']] as const) {
    test(`Given HTTP ${status} When 提交 Then 安全分类不泄露响应`, async () => {
      /** 上游错误可能包含密钥，不能直接展示。 */
      const adapter = createUnifiedMediaHttpAdapters({ fetch: async () => new Response('Bearer secret-key', { status }) })[0]!
      await expect(adapter.generate({ request, route: route(adapter.id, 'image'), signal: new AbortController().signal })).rejects.toThrow(`MEDIA_ADAPTER_${code}`)
    })
  }
  test('Given POST 网络错误 When 提交 Then 结果未知且不重发或泄露错误', async () => {
    /** 计数确保不会隐式重试收费提交。 */
    let calls = 0
    const adapter = createUnifiedMediaHttpAdapters({ fetch: async () => { calls++; throw new Error('Authorization: secret-key') } })[0]!
    await expect(adapter.generate({ request, route: route(adapter.id, 'image'), signal: new AbortController().signal })).rejects.toThrow('MEDIA_ADAPTER_SUBMISSION_UNKNOWN')
    expect(calls).toBe(1)
  })
  test('Given 已持久化视频任务 When 恢复 Then 只查询下载不再POST', async () => {
    /** 收集 HTTP 方法验证恢复不会重复生成。 */
    const methods: string[] = []
    const adapter = createUnifiedMediaHttpAdapters({ fetch: async (url, init) => {
      methods.push(init?.method ?? 'GET')
      return String(url).includes('/query/') ? Response.json({ status: 'Success', video_url: 'https://cdn.example.test/video.mp4' }) : new Response(new Uint8Array([1]))
    } }).find(item => item.id === 'minimax-video')!
    await adapter.generate({ request, route: route(adapter.id, 'video'), signal: new AbortController().signal, remoteTask: { taskId: 'saved' } })
    expect(methods).toEqual(['GET', 'GET'])
  })
  test('Given 保存taskId失败 When 视频提交成功 Then 不继续查询', async () => {
    /** 保存失败必须停在首次提交之后。 */
    let calls = 0
    const adapter = createUnifiedMediaHttpAdapters({ timeoutMs: 5, pollIntervalMs: 0, fetch: async () => { calls++; return Response.json({ task_id: 'task' }) } }).find(item => item.id === 'minimax-video')!
    await expect(adapter.generate({ request, route: route(adapter.id, 'video'), signal: new AbortController().signal, onRemoteTask: () => { throw new Error('SAVE_FAILED') } })).rejects.toThrow('SAVE_FAILED')
    expect(calls).toBe(1)
  })
})

describe('供应商安全分类与恢复边界', () => {
  test('Given 不明业务错误含余额文字 When 生成 Then 不误报余额不足且不泄露原文', async () => {
    const adapter = createUnifiedMediaHttpAdapters({ fetch: async () => Response.json({ base_resp: { status_code: 999, status_msg: '余额不足 secret-key' } }) })[0]!
    await expect(adapter.generate({ request, route: route(adapter.id, 'image'), signal: new AbortController().signal })).rejects.toThrow(/^MEDIA_ADAPTER_REMOTE_FAILED$/)
  })
  test('Given 视频任务首次成功 When 开始查询 Then 已通知保存且下载不带密钥', async () => {
    /** 记录保存先于查询的时序。 */
    let saved = false
    const adapter = createUnifiedMediaHttpAdapters({ fetch: async (url, init) => {
      if (init?.method === 'POST') return Response.json({ task_id: 'task' })
      expect(saved).toBe(true)
      if (String(url).includes('/query/')) return Response.json({ status: 'Success', video_url: 'https://cdn.example.test/video.mp4' })
      expect(new Headers(init?.headers).get('Authorization')).toBeNull()
      return new Response(new Uint8Array([1]))
    } }).find(item => item.id === 'minimax-video')!
    await adapter.generate({ request, route: route(adapter.id, 'video'), signal: new AbortController().signal, onRemoteTask: task => { expect(task.taskId).toBe('task'); saved = true } })
  })
  test('Given GET网络失败 When 恢复视频 Then 返回安全暂时失败且不POST', async () => {
    const adapter = createUnifiedMediaHttpAdapters({ fetch: async (_url, init) => { expect(init?.method).toBe('GET'); throw new Error('Bearer secret-key') } }).find(item => item.id === 'minimax-video')!
    await expect(adapter.generate({ request, route: route(adapter.id, 'video'), signal: new AbortController().signal, remoteTask: { taskId: 'saved' } })).rejects.toThrow(/^MEDIA_ADAPTER_TEMPORARY_FAILURE$/)
  })
  test('Given POST响应流中断 When 读取响应 Then 提交结果未知且不泄露底层错误', async () => {
    const adapter = createUnifiedMediaHttpAdapters({ fetch: async () => new Response(new ReadableStream({ start(controller) { controller.error(new Error('Bearer secret-key')) } })) })[0]!
    await expect(adapter.generate({ request, route: route(adapter.id, 'image'), signal: new AbortController().signal })).rejects.toThrow(/^MEDIA_ADAPTER_SUBMISSION_UNKNOWN$/)
  })
})

for (const adapterId of ['minimax-speech', 'xiaomi-speech']) {
  test(`Given ${adapterId} 自定义音色 When 生成 Then 实际透传参数并返回MP3`, async () => {
    /** 捕获供应商请求体，验证公开参数没有被静默丢弃。 */
    let submitted: Record<string, unknown> = {}
    const adapter = createUnifiedMediaHttpAdapters({ fetch: async (_url, init) => {
      submitted = JSON.parse(String(init?.body)) as Record<string, unknown>
      return Response.json(adapterId === 'minimax-speech' ? { data: { audio: 'dm9pY2U=' } } : { choices: [{ message: { audio: { data: 'dm9pY2U=' } } }] })
    } }).find(item => item.id === adapterId)!
    /** 输入与输出格式严格一致，不以MP3标签包装其他格式。 */
    const outputs = await adapter.generate({ request: { ...request, inputs: { voice: { kind: 'scalar', value: 'custom' }, format: { kind: 'scalar', value: 'mp3' } } }, route: route(adapterId, 'audio'), signal: new AbortController().signal })
    expect(adapterId === 'minimax-speech' ? submitted.voice_setting : submitted.audio).toEqual(adapterId === 'minimax-speech' ? { voice_id: 'custom' } : { voice: 'custom', format: 'mp3' })
    expect(outputs[0]?.contentType).toBe('audio/mpeg')
    expect(new TextDecoder().decode(outputs[0]?.bytes)).toBe('voice')
  })
}
