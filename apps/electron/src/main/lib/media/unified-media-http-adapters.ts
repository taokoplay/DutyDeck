import type { MediaAssetRef, MediaGenerationRequest, MediaInputValue } from '@dutydeck/shared'
import { scalarInput, type UnifiedMediaGenerationAdapter, type UnifiedMediaGenerationAdapterOutput, type UnifiedMediaRemoteTask } from './unified-media-generation-service'
import type { UnifiedMediaModelRoute } from './unified-media-model-catalog'
import { prepareUnifiedMediaHttpInputs } from './unified-media-model-parameters'
import { detectMediaFileSignature } from './media-file-probe'

/** HTTP 依赖可注入，测试不触碰真实供应商。 */
export interface UnifiedMediaHttpAdapterOptions {
  fetch?: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>
  readAsset?: (projectId: string, asset: MediaAssetRef) => Promise<Uint8Array>
  pollIntervalMs?: number
  timeoutMs?: number
}

/** 生产环境默认使用 Electron 主进程的 fetch；测试可注入隔离实现。 */
const defaultFetch = (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => globalThis.fetch(input, init)

/** 创建当前统一目录使用的图片、音频和视频 HTTP 执行器。 */
export function createUnifiedMediaHttpAdapters(options: UnifiedMediaHttpAdapterOptions = {}): UnifiedMediaGenerationAdapter[] {
  const fetchImpl = options.fetch ?? defaultFetch
  /** 每个入口都执行相同参数校验，兼容服务预处理和直接调用。 */
  const adapters: UnifiedMediaGenerationAdapter[] = [
    { id: 'openai-images', generate: (input) => generateOpenAiImage(input.request, input.route, input.signal, fetchImpl, options.readAsset) },
    { id: 'minimax-image', generate: (input) => generateMiniMaxImage(input.request, input.route, input.signal, fetchImpl, options.readAsset) },
    { id: 'xiaomi-speech', generate: (input) => generateXiaomiSpeech(input.request, input.route, input.signal, fetchImpl) },
    { id: 'minimax-speech', generate: (input) => generateMiniMaxSpeech(input.request, input.route, input.signal, fetchImpl) },
    { id: 'minimax-video', supportsResume: true, generate: (input) => generateMiniMaxVideo(input.request, input.route, input.signal, fetchImpl, options, input.remoteTask, input.onRemoteTask) },
  ]
  return adapters.map(adapter => ({
    ...adapter,
    prepareInputs: ({ request, route }) => prepareUnifiedMediaHttpInputs(adapter.id, route.ref.modelId, request.inputs),
    generate: (input) => {
      prepareUnifiedMediaHttpInputs(adapter.id, input.route.ref.modelId, input.request.inputs)
      return adapter.generate(input)
    },
  }))
}

type FetchImpl = NonNullable<UnifiedMediaHttpAdapterOptions['fetch']>

/** 统一 POST JSON，拒绝重定向并把上游错误收敛为稳定码。 */
async function postJson(fetchImpl: FetchImpl, url: string, apiKey: string, body: Record<string, unknown>, signal: AbortSignal): Promise<unknown> {
  const response = await safeFetch(fetchImpl, url, { method: 'POST', headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal, redirect: 'manual' })
  assertHttpSuccess(response)
  return readResponseJson(response)
}

/** 统一 GET JSON。 */
async function getJson(fetchImpl: FetchImpl, url: string, apiKey: string, signal: AbortSignal): Promise<unknown> {
  const response = await safeFetch(fetchImpl, url, { method: 'GET', headers: { Authorization: `Bearer ${apiKey}` }, signal, redirect: 'manual' })
  assertHttpSuccess(response)
  return readResponseJson(response, false)
}

/** OpenAI Images 编辑接口使用 multipart，图片字节不经过第三方 URL。 */
async function postMultipart(fetchImpl: FetchImpl, url: string, apiKey: string, fields: Record<string, string>, image: { bytes: Uint8Array; contentType: string; extension: string }, signal: AbortSignal): Promise<unknown> {
  const form = new FormData()
  for (const [key, value] of Object.entries(fields)) form.set(key, value)
  form.set('image', new Blob([Buffer.from(image.bytes)], { type: image.contentType }), `reference${image.extension}`)
  const response = await safeFetch(fetchImpl, url, { method: 'POST', headers: { Authorization: `Bearer ${apiKey}` }, body: form, signal, redirect: 'manual' })
  assertHttpSuccess(response)
  return readResponseJson(response)
}

/** OpenAI Images 兼容接口的最小文生图执行器。 */
async function generateOpenAiImage(request: MediaGenerationRequest, route: UnifiedMediaModelRoute, signal: AbortSignal, fetchImpl: FetchImpl, readAsset?: UnifiedMediaHttpAdapterOptions['readAsset']): Promise<UnifiedMediaGenerationAdapterOutput[]> {
  const size = String(scalarInput(request.inputs, 'size') ?? '1024x1024')
  const reference = await singleImageReference(request, readAsset)
  const endpoint = `${route.baseUrl.replace(/\/+$/, '')}/${reference ? 'images/edits' : 'images/generations'}`
  const payload = reference
    ? await postMultipart(fetchImpl, endpoint, route.apiKey, { model: route.ref.modelId, prompt: request.prompt, n: '1', size }, reference, signal)
    : await postJson(fetchImpl, endpoint, route.apiKey, { model: route.ref.modelId, prompt: request.prompt, n: 1, size }, signal)
  return await parseMediaItems(payload, 'image/png', fetchImpl, signal)
}

/** MiniMax 图像接口的最小统一执行器。 */
async function generateMiniMaxImage(request: MediaGenerationRequest, route: UnifiedMediaModelRoute, signal: AbortSignal, fetchImpl: FetchImpl, readAsset?: UnifiedMediaHttpAdapterOptions['readAsset']): Promise<UnifiedMediaGenerationAdapterOutput[]> {
  const reference = await singleImageReference(request, readAsset)
  const payload = await postJson(fetchImpl, `${route.baseUrl.replace(/\/+$/, '')}/image_generation`, route.apiKey, {
    model: route.ref.modelId, prompt: request.prompt, response_format: 'base64',
    ...(reference ? { subject_reference: [{ type: 'character', image_file: `data:${reference.contentType};base64,${Buffer.from(reference.bytes).toString('base64')}` }] } : {}),
  }, signal)
  return await parseMediaItems(payload, 'image/png', fetchImpl, signal)
}

/** 小米 TTS 使用 chat/completions 的音频响应。 */
async function generateXiaomiSpeech(request: MediaGenerationRequest, route: UnifiedMediaModelRoute, signal: AbortSignal, fetchImpl: FetchImpl): Promise<UnifiedMediaGenerationAdapterOutput[]> {
  const payload = await postJson(fetchImpl, `${route.baseUrl.replace(/\/+$/, '')}/chat/completions`, route.apiKey, {
    model: route.ref.modelId, messages: [{ role: 'user', content: request.prompt }], modalities: ['text', 'audio'],
    audio: { voice: String(scalarInput(request.inputs, 'voice') ?? 'mimo_default'), format: String(scalarInput(request.inputs, 'format') ?? 'mp3') },
  }, signal)
  const encoded = readNestedString(payload, [['choices', 0, 'message', 'audio', 'data']])
  if (!encoded) throw new Error('MEDIA_ADAPTER_RESPONSE_INVALID')
  return [{ bytes: decodeBase64(encoded), contentType: 'audio/mpeg' }]
}

/** MiniMax Speech 的 T2A 接口。 */
async function generateMiniMaxSpeech(request: MediaGenerationRequest, route: UnifiedMediaModelRoute, signal: AbortSignal, fetchImpl: FetchImpl): Promise<UnifiedMediaGenerationAdapterOutput[]> {
  const payload = await postJson(fetchImpl, `${route.baseUrl.replace(/\/+$/, '')}/t2a_v2`, route.apiKey, {
    model: route.ref.modelId, text: request.prompt,
    voice_setting: { voice_id: String(scalarInput(request.inputs, 'voice') ?? 'female-shaonv') },
    audio_setting: { format: String(scalarInput(request.inputs, 'format') ?? 'mp3') },
    ...(route.groupId ? { group_id: route.groupId } : {}),
  }, signal)
  const encoded = readNestedString(payload, [['data', 'audio'], ['audio']])
  if (!encoded) throw new Error('MEDIA_ADAPTER_RESPONSE_INVALID')
  return [{ bytes: decodeBase64(encoded), contentType: 'audio/mpeg' }]
}

/** MiniMax 视频提交、轮询与远端文件下载执行器。 */
async function generateMiniMaxVideo(request: MediaGenerationRequest, route: UnifiedMediaModelRoute, signal: AbortSignal, fetchImpl: FetchImpl, options: UnifiedMediaHttpAdapterOptions, remoteTask?: UnifiedMediaRemoteTask, onRemoteTask?: (task: UnifiedMediaRemoteTask) => void): Promise<UnifiedMediaGenerationAdapterOutput[]> {
  let videoUrl: string | undefined
  if (remoteTask) {
    videoUrl = await waitMiniMaxVideo(remoteTask.taskId, route, signal, fetchImpl, options)
  } else {
    const reference = await singleImageReference(request, options.readAsset)
    const submitted = await postJson(fetchImpl, `${route.baseUrl.replace(/\/+$/, '')}/video_generation`, route.apiKey, {
      model: route.ref.modelId, prompt: request.prompt, ...(route.groupId ? { group_id: route.groupId } : {}),
      ...(reference ? { first_frame_image: `data:${reference.contentType};base64,${Buffer.from(reference.bytes).toString('base64')}` } : {}),
    }, signal)
    const immediate = readNestedString(submitted, [['video_url'], ['data', 'video_url']])
    const taskId = readNestedString(submitted, [['task_id'], ['data', 'task_id']])
    if (taskId) onRemoteTask?.({ taskId })
    videoUrl = immediate ?? (taskId ? await waitMiniMaxVideo(taskId, route, signal, fetchImpl, options) : undefined)
  }
  if (!videoUrl) throw new Error('MEDIA_ADAPTER_RESPONSE_INVALID')
  const response = await safeFetch(fetchImpl, videoUrl, { signal, redirect: 'manual' })
  if (!response.ok) throw new Error('MEDIA_ADAPTER_DOWNLOAD_FAILED')
  return [{ bytes: await readMediaBytes(response), contentType: response.headers.get('content-type')?.split(';')[0] ?? 'video/mp4' }]
}

/** 等待 MiniMax 视频任务终态，超时或取消均不会自动重试。 */
async function waitMiniMaxVideo(taskId: string, route: UnifiedMediaModelRoute, signal: AbortSignal, fetchImpl: FetchImpl, options: UnifiedMediaHttpAdapterOptions): Promise<string | undefined> {
  const deadline = Date.now() + (options.timeoutMs ?? 5 * 60_000)
  const interval = Math.max(0, options.pollIntervalMs ?? 2_000)
  while (Date.now() <= deadline) {
    signal.throwIfAborted()
    const payload = await getJson(fetchImpl, `${route.baseUrl.replace(/\/+$/, '')}/query/video_generation?task_id=${encodeURIComponent(taskId)}`, route.apiKey, signal)
    const status = readNestedString(payload, [['status'], ['data', 'status']])?.toLowerCase()
    const videoUrl = readNestedString(payload, [['video_url'], ['data', 'video_url']])
    if (videoUrl && (!status || ['success', 'succeed', 'completed'].includes(status))) return videoUrl
    if (status && ['failed', 'fail', 'error'].includes(status)) throw new Error('MEDIA_ADAPTER_REMOTE_FAILED')
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => { signal.removeEventListener('abort', onAbort); resolve() }, interval)
      /** 正常定时器结束也移除监听，避免长轮询累积处理器。 */
      const onAbort = (): void => { clearTimeout(timer); reject(new Error('MEDIA_ADAPTER_CANCELLED')) }
      signal.addEventListener('abort', onAbort, { once: true })
    })
  }
  throw new Error('MEDIA_ADAPTER_TIMEOUT')
}

/** 解析图片 URL/base64 列表，并将 URL 下载成受管字节。 */
async function parseMediaItems(payload: unknown, defaultType: string, fetchImpl: FetchImpl, signal: AbortSignal): Promise<UnifiedMediaGenerationAdapterOutput[]> {
  const values = readNestedArray(payload, [['data', 'image_base64'], ['data', 'image_urls'], ['data'], ['data', 'images']])
  if (!values) throw new Error('MEDIA_ADAPTER_RESPONSE_INVALID')
  const outputs: UnifiedMediaGenerationAdapterOutput[] = []
  for (const value of values) {
    const encoded = typeof value === 'string' ? value : readNestedString(value, [['b64_json'], ['image_base64'], ['base64'], ['url'], ['image_url']])
    if (!encoded) continue
    if (/^https?:\/\//.test(encoded)) {
      const response = await safeFetch(fetchImpl, encoded, { signal, redirect: 'manual' })
      if (!response.ok) throw new Error('MEDIA_ADAPTER_DOWNLOAD_FAILED')
      outputs.push({ bytes: await readMediaBytes(response), contentType: response.headers.get('content-type')?.split(';')[0] ?? defaultType })
    } else outputs.push({ bytes: decodeBase64(encoded), contentType: defaultType })
  }
  if (outputs.length === 0) throw new Error('MEDIA_ADAPTER_RESPONSE_INVALID')
  return outputs
}

/** 读取唯一图片参考；多参考或格式不匹配时拒绝，避免静默丢失制作约束。 */
async function singleImageReference(request: MediaGenerationRequest, readAsset?: UnifiedMediaHttpAdapterOptions['readAsset']): Promise<{ bytes: Uint8Array; contentType: string; extension: string } | undefined> {
  /** 当前执行器仅支持一张图片；先校验数量，不读取或提交部分参考。 */
  const entries = Object.values(request.inputs).filter((value): value is Extract<MediaInputValue, { kind: 'asset' }> => value.kind === 'asset')
  if (entries.length > 1) throw new Error('MEDIA_GENERATION_MULTIPLE_REFERENCES_UNSUPPORTED')
  /** 没有参考时保留原有文生图/视频行为。 */
  const entry = entries[0]
  if (!entry) return undefined
  if (entry.asset.mediaKind !== 'image') throw new Error('MEDIA_GENERATION_REFERENCE_IMAGE_REQUIRED')
  if (!readAsset) throw new Error('MEDIA_GENERATION_ASSET_UNAVAILABLE')
  /** 读取失败直接向上传播，不能降级为无参考生成。 */
  const bytes = await readAsset(request.projectId, entry.asset)
  try {
    /** 复用资产系统的字节签名识别，确保 MIME 与 multipart 扩展名一致。 */
    const signature = detectMediaFileSignature(bytes)
    if (signature.mediaKind !== 'image') throw new Error('MEDIA_GENERATION_REFERENCE_IMAGE_REQUIRED')
    return { bytes, contentType: signature.mediaType, extension: signature.extension }
  } catch {
    throw new Error('MEDIA_GENERATION_REFERENCE_IMAGE_REQUIRED')
  }
}

/** 从有限 JSON 值中读取字符串字段。 */
function readNestedString(value: unknown, paths: ReadonlyArray<ReadonlyArray<string | number>>): string | undefined {
  for (const path of paths) {
    let current: unknown = value
    for (const segment of path) {
      if (current === null || typeof current !== 'object') { current = undefined; break }
      current = (current as Record<string | number, unknown>)[segment]
    }
    if (typeof current === 'string' && current.trim()) return current.trim()
  }
  return undefined
}

/** 从有限 JSON 值中读取字符串数组。 */
function readNestedArray(value: unknown, paths: ReadonlyArray<ReadonlyArray<string | number>>): unknown[] | undefined {
  for (const path of paths) {
    let current: unknown = value
    for (const segment of path) {
      if (current === null || typeof current !== 'object') { current = undefined; break }
      current = (current as Record<string | number, unknown>)[segment]
    }
    if (Array.isArray(current)) return current
    if (typeof current === 'string' && current.trim()) return [current]
  }
  return undefined
}

/** 解析有限 JSON 文本。 */
function parseJson(text: string): unknown {
  try { return JSON.parse(text) as unknown } catch { throw new Error('MEDIA_ADAPTER_RESPONSE_INVALID') }
}

/** 严格解码 base64，避免把任意文本伪装成媒体。 */
function decodeBase64(value: string): Uint8Array {
  const normalized = value.replace(/^data:[^;]+;base64,/, '')
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(normalized) || normalized.length % 4 === 1) throw new Error('MEDIA_ADAPTER_RESPONSE_INVALID')
  const bytes = Buffer.from(normalized, 'base64')
  if (bytes.length === 0) throw new Error('MEDIA_ADAPTER_RESPONSE_INVALID')
  return new Uint8Array(bytes)
}

/** 网络异常只暴露安全码；POST 可能已被接收，禁止自动重发。 */
async function safeFetch(fetchImpl: FetchImpl, url: string, init: RequestInit): Promise<Response> {
  try { return await fetchImpl(url, init) } catch {
    throw new Error(init.method === 'POST' ? 'MEDIA_ADAPTER_SUBMISSION_UNKNOWN' : 'MEDIA_ADAPTER_TEMPORARY_FAILURE')
  }
}

/** HTTP 状态是可信分类依据，响应正文与请求头均不进入错误消息。 */
function assertHttpSuccess(response: Response): void {
  if (response.ok) return
  if (response.status === 401 || response.status === 403) throw new Error('MEDIA_ADAPTER_AUTH_FAILED')
  if (response.status === 402) throw new Error('MEDIA_ADAPTER_QUOTA_EXCEEDED')
  if (response.status === 429) throw new Error('MEDIA_ADAPTER_RATE_LIMITED')
  if (response.status >= 500) throw new Error('MEDIA_ADAPTER_TEMPORARY_FAILURE')
  if (response.status >= 300 && response.status < 400) throw new Error('MEDIA_ADAPTER_REDIRECT')
  throw new Error('MEDIA_ADAPTER_HTTP_ERROR')
}

/** 业务码仅允许稳定白名单分类；未知供应商消息绝不推断余额不足。 */
async function readResponseJson(response: Response, submitted = true): Promise<unknown> {
  /** 流读取失败同样可能发生在服务端接受请求之后。 */
  let body: string
  try { body = await response.text() } catch {
    throw new Error(submitted ? 'MEDIA_ADAPTER_SUBMISSION_UNKNOWN' : 'MEDIA_ADAPTER_TEMPORARY_FAILURE')
  }
  const payload = parseJson(body)
  const code = readNestedString(payload, [['error', 'code']])
  if (code === 'invalid_api_key') throw new Error('MEDIA_ADAPTER_AUTH_FAILED')
  if (code === 'rate_limit_exceeded') throw new Error('MEDIA_ADAPTER_RATE_LIMITED')
  if (code === 'insufficient_quota') throw new Error('MEDIA_ADAPTER_QUOTA_EXCEEDED')
  if (payload && typeof payload === 'object') {
    const record = payload as { error?: unknown; base_resp?: { status_code?: unknown } }
    if (record.error || (record.base_resp?.status_code !== undefined && record.base_resp.status_code !== 0)) throw new Error('MEDIA_ADAPTER_REMOTE_FAILED')
  }
  return payload
}

/** 下载流只返回受管字节，底层 URL 或鉴权诊断不得进入用户错误。 */
async function readMediaBytes(response: Response): Promise<Uint8Array> {
  try { return new Uint8Array(await response.arrayBuffer()) } catch { throw new Error('MEDIA_ADAPTER_DOWNLOAD_FAILED') }
}
