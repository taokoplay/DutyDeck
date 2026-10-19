import { describe, expect, test } from 'bun:test'
import { createHash, randomBytes } from 'node:crypto'
import sharp from 'sharp'
import { Agent } from '@earendil-works/pi-agent-core'
import type { AgentMessage, AgentTool } from '@earendil-works/pi-agent-core'
import { fauxAssistantMessage, fauxProvider, fauxToolCall, isContextOverflow, normalizeContext, Type } from '@earendil-works/pi-ai'
import type { ImageContent, SimpleStreamOptions, TranscriptContext } from '@earendil-works/pi-ai'
import { streamSimple } from '@earendil-works/pi-ai/api/openai-completions'
import { installPiImageRequestPolicy } from './pi-image-request-policy'
import { build } from 'esbuild'

test('Given Electron CJS 主进程 When 编译图片策略 Then 不同步 require ESM-only Pi 包', async () => {
  const result = await build({ entryPoints: [import.meta.dir + '/pi-image-request-policy.ts'], bundle: true,
    platform: 'node', format: 'cjs', write: false, external: ['@earendil-works/pi-ai', 'sharp'] })
  expect(result.outputFiles[0]!.text).not.toMatch(/require\(["']@earendil-works\/pi-ai["']\)/)
})
import { installCanvasMediaSampleLifecycle } from './pi-canvas-media-samples'

/** 生成真实 PNG 夹具，避免伪 Base64 绕过生产解码与 MIME 校验。 */
async function imageFixture(background: string, width = 20): Promise<ImageContent> {
  /** 只创建内存图片，不写正式素材或测试目录。 */
  const bytes = await sharp({ create: { width, height: 20, channels: 3, background } }).png().toBuffer()
  return { type: 'image', mimeType: 'image/png', data: bytes.toString('base64') }
}

/** 获取请求里实际发送的图片，忽略文字引用。 */
function requestImages(context: TranscriptContext): ImageContent[] {
  return context.messages.flatMap(message => Array.isArray(message.content)
    ? message.content.filter((block): block is ImageContent => block.type === 'image') : [])
}

/** 使用真实 OpenAI 编码器，在最后 HTTP 边界截断，确保测试绝不联网。 */
function offlineProviderFixture(onPayload?: SimpleStreamOptions['onPayload']) {
  /** faux 仅提供完整模型能力字段，实际请求由 OpenAI 编码器生成。 */
  const provider = fauxProvider()
  /** 记录走到 HTTP 边界的次数和正文，供预算及回调顺序验证。 */
  const requests: string[] = []
  /** 真实 Agent 负责事件和原 transcript，网络请求被本地 fetch 明确拒绝。 */
  const agent = new Agent({
    initialState: { model: { ...provider.models[0], api: 'openai-completions', input: ['text', 'image'] } },
    onPayload,
    streamFn: (model, context, options) => streamSimple({ ...model, api: 'openai-completions' }, context, {
      ...options, apiKey: 'offline-test-key', maxRetries: 0,
      fetch: Object.assign(async (_input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
        requests.push(String(init?.body))
        throw new Error('OFFLINE_FETCH: 此测试禁止联网')
      }, { preconnect: () => undefined }),
    }),
  })
  installPiImageRequestPolicy(agent)
  return { agent, requests }
}

describe('Pi 通用图片请求投影', () => {
  test('Given 用户与工具历史包含重复和不同图片 When 真实 Agent 请求及继续 Then 全部唯一图可见且原 transcript 不变', async () => {
    /** 两张不同原图必须保留，相同原图跨消息复用图片编号。 */
    const red = await imageFixture('red', 2400)
    /** 第二张图片与首图不同，用于证明没有基于时间或任务猜测删除唯一图片。 */
    const blue = await imageFixture('blue')
    /** 已有工具配对必须在投影后保持原身份与文本。 */
    const history: AgentMessage[] = [
      { role: 'user', content: [{ type: 'text', text: '原始参考' }, red], timestamp: 1 },
      fauxAssistantMessage(fauxToolCall('read', { path: 'ref.png' }, { id: 'read-reference' }), { stopReason: 'toolUse' }),
      { role: 'toolResult', toolCallId: 'read-reference', toolName: 'read', content: [{ type: 'text', text: '读图成功' }, red, blue], isError: false, timestamp: 2 },
    ]
    /** 快照用来验证原消息与完整 Base64 没有被就地修改。 */
    const snapshot = JSON.stringify(history)
    /** faux 提供真实 Pi 协议输出，不调用模型服务。 */
    const provider = fauxProvider()
    /** 保存实际到达 provider 的完整请求上下文。 */
    const contexts: TranscriptContext[] = []
    /** 证明先前 transform 在每次继续时仍会运行。 */
    let transformCalls = 0
    /** 从既有含图历史恢复 Agent，运行正常请求和继续两轮。 */
    const agent = new Agent({
      initialState: { model: { ...provider.models[0], input: ['text', 'image'] }, messages: history },
      transformContext: async messages => {
        transformCalls += 1
        return [...messages, { role: 'user', content: '既有上下文钩子', timestamp: 3 }]
      },
      streamFn: (model, context, options) => {
        contexts.push(context)
        return provider.provider.streamSimple(model, context, options)
      },
    })
    provider.setResponses([fauxAssistantMessage('已查看'), fauxAssistantMessage('继续查看')])
    installPiImageRequestPolicy(agent)

    await agent.prompt('比较图片')
    await agent.prompt('请继续')

    expect(transformCalls).toBe(2)
    expect(contexts.map(context => requestImages(context).length)).toEqual([2, 2])
    expect(JSON.stringify(history)).toBe(snapshot)
    expect(agent.state.messages[0]).toEqual(history[0])
    expect(agent.state.messages.find(message => message.role === 'toolResult')).toEqual(history.find(message => message.role === 'toolResult'))
    /** 版本身份绑定原始字节，而非缩小后的预览或可被覆盖的文件路径。 */
    const imageId = `image-${createHash('sha256').update(Buffer.from(red.data, 'base64')).digest('hex')}`
    for (const context of contexts) {
      expect(JSON.stringify(context)).toContain(imageId)
      expect(JSON.stringify(context)).toContain('重复图片')
      expect(JSON.stringify(context)).toContain('细节可能受影响')
      expect(JSON.stringify(context)).toContain('既有上下文钩子')
      expect(context.messages.find(message => message.role === 'toolResult')).toMatchObject({ toolCallId: 'read-reference', toolName: 'read' })
      expect((await sharp(Buffer.from(requestImages(context)[0]!.data, 'base64')).metadata()).width).toBeLessThanOrEqual(2000)
    }
  })

  test('Given 既有 onPayload 返回新正文 When 新正文超限 Then 在 HTTP 前拒绝并保留正常错误终态', async () => {
    /** 原回调特意放大正文，检验预算作用于最终值而非旧 payload。 */
    let callbackCalls = 0
    const { agent, requests } = offlineProviderFixture(payload => {
      callbackCalls += 1
      return { ...(payload as Record<string, unknown>), extra: '中'.repeat(6 * 1024 * 1024) }
    })
    /** 正常 agent_end 用于防止请求转换抛错破坏运行生命周期。 */
    const terminalEvents: string[] = []
    agent.subscribe(event => { if (event.type === 'agent_end') terminalEvents.push(event.type) })
    await agent.prompt('小请求')
    expect(callbackCalls).toBe(1)
    expect(requests).toHaveLength(0)
    expect(terminalEvents).toEqual(['agent_end'])
    /** 实际终态必须同时被产品识别为预算限制、被 SDK 识别为非 token overflow。 */
    const terminal = agent.state.messages.at(-1)
    expect(terminal).toMatchObject({ role: 'assistant', stopReason: 'error', errorMessage: expect.stringContaining('MODEL_REQUEST_BUDGET_EXCEEDED') })
    if (terminal?.role !== 'assistant') throw new Error('测试缺少 assistant 终态')
    expect(isContextOverflow(terminal)).toBe(false)
  })

  test('Given 原 payload 超限但既有回调缩小 When 预算检查 Then 保留回调返回值且允许小正文到达 HTTP 边界', async () => {
    /** 保留原回调的返回对象，不能在回调之前误拦截大正文。 */
    const { agent, requests } = offlineProviderFixture(() => ({ model: 'offline', messages: [], marker: '保留原回调结果' }))
    await agent.prompt('大'.repeat(6 * 1024 * 1024))
    expect(requests).toHaveLength(1)
    expect(JSON.parse(requests[0]!)).toEqual({ model: 'offline', messages: [], marker: '保留原回调结果' })
  })

  test('Given 既有回调返回 undefined When 编码请求 Then 保持原正文并运行预算检查', async () => {
    /** undefined 必须沿用 SDK 原本的“保持正文”语义。 */
    const { agent, requests } = offlineProviderFixture(() => undefined)
    await agent.prompt('需要保留的正文')
    expect(requests).toHaveLength(1)
    expect(requests[0]).toContain('需要保留的正文')
  })

  test('Given compaction 式独立 stream 不携带 onPayload When 摘要请求超限 Then 仍在 HTTP 前拒绝', async () => {
    /** 无需构造磁盘 session，直接调用 compaction 同一入口验证合同。 */
    const { agent, requests } = offlineProviderFixture()
    /** Pi compaction 直接复用 streamFunction，没有主 Agent 的 onPayload 与 transformContext。 */
    const response = await agent.streamFunction(agent.state.model, normalizeContext({ messages: [{ role: 'user', content: '长'.repeat(6 * 1024 * 1024), timestamp: 1 }] }), { apiKey: 'offline-test-key', maxRetries: 0 })
    expect((await response.result()).errorMessage).toContain('MODEL_REQUEST_BUDGET_EXCEEDED')
    expect(requests).toHaveLength(0)
  })

  test('Given 图片编码不合法 When 请求投影 Then 返回正常错误事件且不调用 provider', async () => {
    /** 调用计数证明失败发生在 provider 边界之前。 */
    const provider = fauxProvider()
    /** 不安装其他图片 sanitizer，单独验证最终请求保护的失败协议。 */
    const agent = new Agent({ initialState: { model: { ...provider.models[0], input: ['text', 'image'] } }, streamFn: provider.provider.streamSimple })
    /** 收集真实 Agent 生命周期，确保仍有正常终态。 */
    const events: string[] = []
    agent.subscribe(event => { events.push(event.type) })
    installPiImageRequestPolicy(agent)
    await agent.prompt('检查图片', [{ type: 'image', mimeType: 'image/png', data: 'broken' }])
    expect(provider.state.callCount).toBe(0)
    expect(agent.state.messages.at(-1)).toMatchObject({ stopReason: 'error', errorMessage: expect.stringContaining('IMAGE_REQUEST_INVALID') })
    expect(events.at(-1)).toBe('agent_end')
  })

  test('Given 保留透明细节的唯一图本身超过图片预算 When 请求投影 Then 明确失败且不静默删图', async () => {
    /** 无损随机 RGBA 确保真实预览仍超过 12 MiB，验证公共预算的实际接入。 */
    const source = await sharp(randomBytes(1600 * 1600 * 4), { raw: { width: 1600, height: 1600, channels: 4 } }).png({ compressionLevel: 0 }).toBuffer()
    /** 不调用真实服务，通过计数确认没有发送超预算图片。 */
    const provider = fauxProvider()
    /** 保持 Agent 原始消息，用于验证失败后没有删去原图。 */
    const agent = new Agent({ initialState: { model: { ...provider.models[0], input: ['text', 'image'] } }, streamFn: provider.provider.streamSimple })
    installPiImageRequestPolicy(agent)
    await agent.prompt('分析透明图', [
      { type: 'image', mimeType: 'image/png', data: source.toString('base64') },
      // 首图已超预算时不应继续解码后面的无效图片，从而错误地改报素材损坏。
      { type: 'image', mimeType: 'image/png', data: 'later-invalid-image' },
    ])
    expect(provider.state.callCount).toBe(0)
    /** 本地图片预算不能误触发 Pi 自动压缩并再次请求模型。 */
    const terminal = agent.state.messages.at(-1)
    expect(terminal).toMatchObject({ stopReason: 'error', errorMessage: expect.stringContaining('IMAGE_REQUEST_BUDGET_EXCEEDED') })
    if (terminal?.role !== 'assistant') throw new Error('测试缺少 assistant 终态')
    expect(isContextOverflow(terminal)).toBe(false)
    expect(JSON.stringify(agent.state.messages[0])).toContain(source.toString('base64'))
  })

  test('Given 请求已经取消 When stream 投影 Then 返回 aborted 且不调用 provider', async () => {
    /** 取消请求不能进入 provider。 */
    const provider = fauxProvider()
    /** 独立 stream 也必须返回可消费的 aborted 结果。 */
    const agent = new Agent({ initialState: { model: provider.models[0] }, streamFn: provider.provider.streamSimple })
    /** 在请求准备前明确取消。 */
    const controller = new AbortController()
    controller.abort()
    installPiImageRequestPolicy(agent)
    /** 消费流终态，而不是依赖异常或轮询判断取消成功。 */
    const response = await agent.streamFunction(agent.state.model, normalizeContext({ messages: [{ role: 'user', content: '取消', timestamp: 1 }] }), { signal: controller.signal })
    expect((await response.result()).stopReason).toBe('aborted')
    expect(provider.state.callCount).toBe(0)
  })

  test('Given 纯文本模型历史包含工具图片 When 原 provider 过滤图片 Then 跳过预览校验并保留文字中继及工具配对', async () => {
    /** 使用真实 OpenAI 编码器确认不支持图片时原本会过滤 toolResult 图片。 */
    const { agent, requests } = offlineProviderFixture()
    agent.state.model = { ...agent.state.model, input: ['text'] }
    agent.state.messages = [
      { role: 'user', content: '查看参考', timestamp: 1 },
      fauxAssistantMessage(fauxToolCall('read', {}, { id: 'text-model-read' }), { stopReason: 'toolUse' }),
      { role: 'toolResult', toolCallId: 'text-model-read', toolName: 'read', isError: false, timestamp: 2,
        content: [{ type: 'text', text: '视觉中继已经给出文字观察' }, { type: 'image', mimeType: 'image/png', data: 'invalid-but-not-sent-by-text-model' }] },
    ]
    await agent.prompt('根据文字观察继续')
    expect(requests).toHaveLength(1)
    expect(requests[0]).toContain('视觉中继已经给出文字观察')
    expect(requests[0]).toContain('text-model-read')
    expect(requests[0]).not.toContain('invalid-but-not-sent-by-text-model')
  })

  test('Given Canvas 生命周期最后注入临时样本 When 图片策略接入 Then 样本预览仍只发送一次且原 transcript 不落图', async () => {
    /** 真实宽图必须经统一预览转换，而非只验证 hook 调用次数。 */
    const sample = await imageFixture('green', 2400)
    /** Canvas 已有规则要求可信证据为 SHA-256 形状。 */
    const evidenceId = 'a'.repeat(64)
    /** 工具链先读样本、下一轮才能评审，保证现有视觉证据顺序。 */
    const provider = fauxProvider()
    provider.setResponses([
      fauxAssistantMessage(fauxToolCall('canvas_inspect_media_content', {}, { id: 'inspect-image' }), { stopReason: 'toolUse' }),
      fauxAssistantMessage(fauxToolCall('canvas_review_media', { inspectionEvidenceId: evidenceId }, { id: 'review-image' }), { stopReason: 'toolUse' }),
      fauxAssistantMessage('评审完成'),
    ])
    /** 捕获每次实际请求图片，验证“只给下一次模型”的生命周期保持。 */
    const contexts: TranscriptContext[] = []
    /** 统计只有看过实际样本后才被允许执行的评审。 */
    let reviews = 0
    /** 使用真实 Agent 工具调用协议，全部内容只在内存产生。 */
    const tools: AgentTool[] = [
      { name: 'canvas_inspect_media_content', label: '检查', description: '测试样本', parameters: Type.Object({}),
        execute: async () => ({ content: [sample], details: { inspectionEvidenceId: evidenceId } }) },
      { name: 'canvas_review_media', label: '评审', description: '测试评审', parameters: Type.Object({ inspectionEvidenceId: Type.String() }),
        execute: async () => { reviews += 1; return { content: [{ type: 'text', text: '已评审' }], details: {} } } },
    ]
    /** 生产顺序先安装样本生命周期，再包装最终 stream。 */
    const agent = new Agent({ initialState: { model: { ...provider.models[0], input: ['text', 'image'] }, tools }, streamFn: (model, context, options) => {
      contexts.push(context)
      return provider.provider.streamSimple(model, context, options)
    } })
    /** 在 finally 释放 Canvas 的订阅与临时样本状态。 */
    const release = installCanvasMediaSampleLifecycle(agent)
    installPiImageRequestPolicy(agent)
    try {
      await agent.prompt('检查和评审样本')
      expect(contexts.map(context => requestImages(context).length)).toEqual([0, 1, 0])
      expect(reviews).toBe(1)
      expect((await sharp(Buffer.from(requestImages(contexts[1]!)[0]!.data, 'base64')).metadata()).width).toBe(2000)
      expect(JSON.stringify(agent.state.messages)).not.toContain(sample.data)
      expect(JSON.stringify(agent.state.messages)).toContain(evidenceId)
    } finally { release() }
  })
})
