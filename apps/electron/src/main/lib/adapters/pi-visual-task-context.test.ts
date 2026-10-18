import { describe, expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import sharp from 'sharp'
import { Agent } from '@earendil-works/pi-agent-core'
import type { AgentMessage, AgentTool, StreamFn } from '@earendil-works/pi-agent-core'
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from '@earendil-works/pi-ai'
import type { ImageContent, TranscriptContext } from '@earendil-works/pi-ai'
import { streamSimple } from '@earendil-works/pi-ai/api/openai-completions'
import { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager } from '@earendil-works/pi-coding-agent'
import type { ToolDefinition } from '@earendil-works/pi-coding-agent'
import { Type } from 'typebox'
import type { VisualTaskContextEvent, VisualTaskContextPolicy } from '../visual-production/context-contract'
import { installVisualTaskContextLifecycle } from './pi-visual-task-context'
import { installPiImageRequestPolicy } from './pi-image-request-policy'

/** 真实 PNG 字节用于同时验证内容 hash、请求预览和持久化隔离。 */
const image: ImageContent = { type: 'image', mimeType: 'image/png', data: (await sharp({ create: { width: 20, height: 20, channels: 3, background: 'red' } }).png().toBuffer()).toString('base64') }
/** 媒体身份绑定原始内容，避免以文件路径代替身份。 */
const mediaHash = createHash('sha256').update(Buffer.from(image.data, 'base64')).digest('hex')
/** 工具名称同时约束真实 Pi 调用与可信事件来源。 */
const names = { open: 'visual_production_open_context', inspect: 'visual_production_inspect_media', observation: 'visual_production_record_observation', close: 'visual_production_close_context' } as const

/** 构造指定范围和证据的真实 Pi 工具调用。 */
function call(action: keyof typeof names, id: string, contextId = 'context-a', evidenceId = 'evidence-a') {
  return fauxToolCall(names[action], { contextId, evidenceIds: [evidenceId], evidenceId }, { id })
}

/** 统计最终 provider 上下文中的实际图片数量。 */
function imageCount(context: TranscriptContext): number {
  return context.messages.reduce((count, message) => count + (Array.isArray(message.content) ? message.content.filter(block => block.type === 'image').length : 0), 0)
}

/** 构造离线真实 Agent 和宿主工具，允许测试选择初始范围与模型能力。 */
function fixture(policy: VisualTaskContextPolicy = { runId: 'run-a' }, vision = true, configure?: (agent: Agent) => void) {
  /** faux 只替代外部模型，工具执行、事件和 Agent 生命周期保持真实。 */
  const provider = fauxProvider({ models: [{ id: 'visual-test', input: vision ? ['text', 'image'] : ['text'] }] })
  /** 每次实际 provider 调用的完整输入快照。 */
  const contexts: TranscriptContext[] = []
  /** 实际执行的观察次数，用于验证模型无法同批盲评。 */
  let observations = 0
  /** 最终持久化事件中的图片数量。 */
  const eventImages: number[] = []
  /** 四个工具通过宿主事件协议控制范围，未授权名称不能触发生命周期。 */
  const tools: AgentTool[] = Object.entries(names).map(([action, name]) => ({
    name, label: name, description: name,
    parameters: Type.Object({ contextId: Type.String(), evidenceIds: Type.Array(Type.String()), evidenceId: Type.String() }),
    execute: async (_toolCallId, input) => {
      if (action === 'observation') observations += 1
      /** 参数已由真实 Pi 按上述 schema 验证，再收窄宽类型工具签名。 */
      const fields = input as { contextId: string; evidenceId: string }
      /** details 模拟已经通过主进程执行及 JSON 边界的宿主事实。 */
      const event: VisualTaskContextEvent = { version: 1, runId: policy.runId, contextId: fields.contextId, action: action as VisualTaskContextEvent['action'],
        ...(action === 'inspect' ? { evidenceId: fields.evidenceId, mediaId: mediaHash, mediaHash, inspectionKind: 'visual' as const } : {}) }
      return { content: action === 'inspect' ? [{ type: 'text' as const, text: '已检查固定媒体' }, image] : [{ type: 'text' as const, text: action }], details: { visualTaskContext: event } }
    },
  }))
  /** 测试可切换真实编码器来验证预算，始终通过同一个已安装的生命周期。 */
  let requestStream: StreamFn = provider.provider.streamSimple
  /** 顺序工具执行与生产 adapter 一致。 */
  const agent = new Agent({ initialState: { model: provider.models[0], tools }, toolExecution: 'sequential', streamFn: (model, context, options) => {
    contexts.push(context)
    return requestStream(model, context, options)
  } })
  configure?.(agent)
  /** 安装器返回真正运行结束时使用的释放函数。 */
  const release = installVisualTaskContextLifecycle(agent, policy)
  agent.subscribe(event => {
    if (event.type === 'message_end' && event.message.role === 'toolResult') eventImages.push(event.message.content.filter(block => block.type === 'image').length)
  })
  return { provider, agent, contexts, eventImages, release, getObservations: () => observations,
    setStream: (stream: StreamFn): void => { requestStream = stream } }
}

/** 单独触发真实工具准入边界，确认失败请求未把待检查证据误标为已读。 */
async function observationBlocked(agent: Agent): Promise<boolean> {
  /** 这一调用尚未经过新模型请求，因此不能顺便消费仍待发送的样本。 */
  const toolCall = call('observation', 'guard-observation')
  /** 只观察 beforeToolCall 的公开合同，不直接读取生命周期内部状态。 */
  const result = await agent.beforeToolCall?.({ toolCall, args: toolCall.arguments,
    assistantMessage: fauxAssistantMessage(toolCall, { stopReason: 'toolUse' }),
    context: { messages: agent.state.messages, tools: agent.state.tools } })
  return result?.block === true
}

describe('Pi 影像任务上下文生命周期', () => {
  test('Given 同一任务已看图 When 多轮比较并显式关闭 Then 图片持续到关闭且最终工具事件与历史无字节', async () => {
    /** 本次完整任务包含两轮比较，观察成功不会隐式释放图片。 */
    const current = fixture()
    current.provider.setResponses([
      fauxAssistantMessage([call('open', 'open-1'), call('inspect', 'inspect-1')], { stopReason: 'toolUse' }),
      fauxAssistantMessage(call('observation', 'observe-1'), { stopReason: 'toolUse' }),
      fauxAssistantMessage(call('close', 'close-1'), { stopReason: 'toolUse' }),
      fauxAssistantMessage('完成'),
    ])
    try {
      await current.agent.prompt('对比本次镜头')
      expect(current.contexts.map(imageCount)).toEqual([0, 1, 1, 0])
      expect(current.getObservations()).toBe(1)
      expect(current.eventImages).toEqual([0, 0, 0, 0])
      expect(JSON.stringify(current.agent.state.messages)).not.toContain(image.data)
      expect(JSON.stringify(current.agent.state.messages)).toContain(mediaHash)
    } finally { current.release() }
  })

  test('Given inspect和record同批 When 模型尚未成功收到图 Then 观察被阻止并保留后续图片', async () => {
    /** 宿主预先打开范围，首轮无需 open 工具事件。 */
    const current = fixture({ runId: 'run-a', initialContextId: 'context-a' })
    current.provider.setResponses([
      fauxAssistantMessage([call('inspect', 'inspect-1'), call('observation', 'observe-1')], { stopReason: 'toolUse' }),
      fauxAssistantMessage('先查看图片'),
    ])
    try {
      await current.agent.prompt('检查')
      expect(current.getObservations()).toBe(0)
      expect(current.contexts.map(imageCount)).toEqual([0, 1])
      expect(JSON.stringify(current.agent.state.messages)).toContain('VISUAL_CONTEXT_SAMPLES_NOT_DELIVERED')
    } finally { current.release() }
  })

  test('Given 原生请求失败并结束底层agent循环 When 继续重试 Then 必需样本仍在且成功后允许观察', async () => {
    /** 同一运行保留活动范围，模拟 Pi Session 在 agent_end 后继续重试。 */
    const current = fixture({ runId: 'run-a', initialContextId: 'context-a' })
    current.provider.setResponses([
      fauxAssistantMessage(call('inspect', 'inspect-1'), { stopReason: 'toolUse' }),
      fauxAssistantMessage('', { stopReason: 'error', errorMessage: 'TypeError: Failed to fetch' }),
    ])
    try {
      await current.agent.prompt('检查')
      current.provider.setResponses([
        fauxAssistantMessage(call('observation', 'observe-1'), { stopReason: 'toolUse' }),
        fauxAssistantMessage('已查看'),
      ])
      // Pi Session 原生重试先移除错误 assistant，再继续此前完整工具结果。
      current.agent.state.messages.pop()
      await current.agent.continue()
      expect(current.contexts.map(imageCount)).toEqual([0, 1, 1, 1])
      expect(current.getObservations()).toBe(1)
    } finally { current.release() }
  })

  test('Given 已看过旧范围 When 打开新范围并引用旧证据 Then 旧图退出且观察不能越界', async () => {
    /** 两个范围共享会话，但证据不能跨任务继承。 */
    const current = fixture({ runId: 'run-a', initialContextId: 'context-a' })
    current.provider.setResponses([
      fauxAssistantMessage(call('inspect', 'inspect-1'), { stopReason: 'toolUse' }),
      fauxAssistantMessage([call('open', 'open-2', 'context-b'), call('observation', 'observe-1', 'context-b')], { stopReason: 'toolUse' }),
      fauxAssistantMessage('新任务需要重新看图'),
    ])
    try {
      await current.agent.prompt('切换镜头')
      expect(current.contexts.map(imageCount)).toEqual([0, 1, 0])
      expect(current.getObservations()).toBe(0)
    } finally { current.release() }
  })

  test('Given 文本模型 When 检查图片并登记观察 Then 不注入图片且明确禁止冒充视觉评审', async () => {
    /** 图片能力由当前真实模型决定，不能由工具参数声明。 */
    const current = fixture({ runId: 'run-a', initialContextId: 'context-a' }, false)
    current.provider.setResponses([
      fauxAssistantMessage(call('inspect', 'inspect-1'), { stopReason: 'toolUse' }),
      fauxAssistantMessage(call('observation', 'observe-1'), { stopReason: 'toolUse' }),
      fauxAssistantMessage('只能读取技术信息'),
    ])
    try {
      await current.agent.prompt('评审')
      expect(current.contexts.map(imageCount)).toEqual([0, 0, 0])
      expect(current.getObservations()).toBe(0)
      expect(JSON.stringify(current.agent.state.messages)).toContain('VISUAL_CONTEXT_VISION_UNAVAILABLE')
    } finally { current.release() }
  })

  test('Given 历史普通read有完整配对 When 精确命中宿主范围hash Then 只投影去除该图片并保留未知图片', async () => {
    /** 另一张字节不同的历史图不在授权优化范围。 */
    const unknownImage: ImageContent = { ...image, data: Buffer.from('unknown-image').toString('base64') }
    /** 配对调用可区分真正 read 结果与孤立或伪造记录。 */
    const history: AgentMessage[] = [
      fauxAssistantMessage(fauxToolCall('read', { path: 'old.png' }, { id: 'old-read' }), { stopReason: 'toolUse' }),
      { role: 'toolResult', toolCallId: 'old-read', toolName: 'read', content: [image, unknownImage], isError: false, timestamp: 1 },
    ]
    /** 原始历史必须完全保持，优化只影响请求投影。 */
    const original = JSON.stringify(history)
    /** 宿主已确认这些旧媒体属于本次明确影像任务。 */
    const current = fixture({ runId: 'run-a', initialContextId: 'context-a', legacyMedia: [{ mediaId: mediaHash, hash: mediaHash }] })
    current.agent.state.messages = history
    current.provider.setResponses([fauxAssistantMessage('按引用重新看图')])
    try {
      await current.agent.prompt('继续影像任务')
      expect(current.contexts.map(imageCount)).toEqual([1])
      expect(JSON.stringify(current.contexts)).toContain(mediaHash)
      expect(JSON.stringify(history)).toBe(original)
    } finally { current.release() }
  })

  test('Given 旧read缺少同分支调用 When hash恰好相同 Then 保留图片且不推断归属', async () => {
    /** 孤立结果无法证明调用来源，即使内容命中范围也不能静默删除。 */
    const current = fixture({ runId: 'run-a', initialContextId: 'context-a', legacyMedia: [{ mediaId: mediaHash, hash: mediaHash }] })
    current.agent.state.messages = [{ role: 'toolResult', toolCallId: 'orphan', toolName: 'read', content: [image], isError: false, timestamp: 1 }]
    current.provider.setResponses([fauxAssistantMessage('保守保留')])
    try {
      await current.agent.prompt('继续')
      expect(current.contexts.map(imageCount)).toEqual([1])
    } finally { current.release() }
  })

  test('Given 宿主签发音频技术事实 When 文本模型成功读到事实后record Then 允许技术记录且不注入图片', async () => {
    /** 明确技术证据只验证工具事实送达，不冒充视觉或听觉验收。 */
    const current = fixture({ runId: 'run-a', initialContextId: 'context-a' }, false)
    current.agent.state.tools.find(tool => tool.name === names.inspect)!.execute = async () => ({
      content: [{ type: 'text', text: '音频时长12秒；未检查听觉内容。' }],
      details: { visualTaskContext: { version: 1, runId: 'run-a', contextId: 'context-a', action: 'inspect', evidenceId: 'evidence-a', mediaId: mediaHash, mediaHash, inspectionKind: 'technical' } },
    })
    current.provider.setResponses([
      fauxAssistantMessage(call('inspect', 'inspect-1'), { stopReason: 'toolUse' }),
      fauxAssistantMessage(call('observation', 'observe-1'), { stopReason: 'toolUse' }),
      fauxAssistantMessage('仅记录技术事实'),
    ])
    try {
      await current.agent.prompt('核对音频技术参数')
      expect(current.getObservations()).toBe(1)
      expect(current.contexts.map(imageCount)).toEqual([0, 0, 0])
    } finally { current.release() }
  })

  test('Given 宿主声明visual但缺少样本 When 之后成功模型响应 Then 仍禁止视觉观察', async () => {
    /** 缺图不得自动降级成技术证据绕过视觉验收。 */
    const current = fixture({ runId: 'run-a', initialContextId: 'context-a' })
    current.agent.state.tools.find(tool => tool.name === names.inspect)!.execute = async () => ({
      content: [{ type: 'text', text: '图片未能解码' }],
      details: { visualTaskContext: { version: 1, runId: 'run-a', contextId: 'context-a', action: 'inspect', evidenceId: 'evidence-a', mediaId: mediaHash, mediaHash, inspectionKind: 'visual' } },
    })
    current.provider.setResponses([
      fauxAssistantMessage(call('inspect', 'inspect-1'), { stopReason: 'toolUse' }),
      fauxAssistantMessage(call('observation', 'observe-1'), { stopReason: 'toolUse' }),
      fauxAssistantMessage('不能视觉验收'),
    ])
    try {
      await current.agent.prompt('评审')
      expect(current.getObservations()).toBe(0)
      expect(JSON.stringify(current.agent.state.messages)).toContain('VISUAL_CONTEXT_IMAGE_MISSING')
    } finally { current.release() }
  })

  test('Given 真实AgentSession瞬时网络错误 When Pi原生自动重试 Then 样本跨agent_end保留且真实转录无图片', async () => {
    /** 本例使用 SDK 的完整会话重试循环，不手动模拟 agent_end 或重放工具。 */
    const current = fixture({ runId: 'run-a', initialContextId: 'context-a' })
    /** 本地隔离目录保证不读写用户正式会话或凭据。 */
    const directory = mkdtempSync(join(tmpdir(), 'dutydeck-visual-context-'))
    /** session 负责真实转录和原生重试，faux 仅替代外部服务。 */
    const sessionManager = SessionManager.create(directory, directory)
    /** 明确禁止模型注册时刷新外部端点。 */
    const modelRuntime = await ModelRuntime.create({ authPath: join(directory, 'auth.json'), modelsPath: null, refreshOnCreate: false })
    modelRuntime.registerNativeProvider(current.provider.provider)
    /** 零延迟的原生重试避免测试耗时；关闭自动压缩和预热以保持调用数量确定。 */
    const settingsManager = SettingsManager.inMemory({ cacheWarming: 'off', compaction: { enabled: false }, retry: { enabled: true, maxRetries: 1, baseDelayMs: 0 } })
    /** 空目录只包含本测试固定提示，没有用户项目扩展。 */
    const resourceLoader = new DefaultResourceLoader({ cwd: directory, agentDir: directory, settingsManager, systemPromptOverride: () => '离线影像测试' })
    await resourceLoader.reload()
    /** 使用真实宿主工具返回协议，保留 SDK 的全部工具事件及持久化。 */
    const { session } = await createAgentSession({ cwd: directory, agentDir: directory, modelRuntime, settingsManager, resourceLoader,
      sessionManager, model: current.provider.models[0], thinkingLevel: 'off', noTools: 'builtin', customTools: current.agent.state.tools as unknown as ToolDefinition[] })
    /** 记录每次真实 stream 的图片数量。 */
    const counts: number[] = []
    /** SDK 已安装好的 provider stream 保持原状。 */
    const originalStream = session.agent.streamFunction
    session.agent.streamFunction = (model, context, options) => { counts.push(imageCount(context)); return originalStream(model, context, options) }
    /** 生命周期跟随真正 session 收尾，不订阅低层 agent_end。 */
    const release = installVisualTaskContextLifecycle(session.agent, { runId: 'run-a', initialContextId: 'context-a' })
    /** 统计自动重试事件，证明是 SDK 原生重试链路。 */
    let retries = 0
    session.subscribe(event => { if (event.type === 'auto_retry_start') retries += 1 })
    current.provider.setResponses([
      fauxAssistantMessage(call('inspect', 'inspect-1'), { stopReason: 'toolUse' }),
      fauxAssistantMessage('', { stopReason: 'error', errorMessage: 'TypeError: Failed to fetch' }),
      fauxAssistantMessage(call('observation', 'observe-1'), { stopReason: 'toolUse' }),
      fauxAssistantMessage(call('close', 'close-1'), { stopReason: 'toolUse' }),
      fauxAssistantMessage('完成'),
    ])
    try {
      await session.prompt('检查镜头')
      expect(retries).toBe(1)
      expect(counts).toEqual([0, 1, 1, 1, 0])
      expect(current.getObservations()).toBe(1)
      expect(JSON.stringify(sessionManager.getEntries())).not.toContain(image.data)
    } finally { release(); session.dispose(); current.release(); rmSync(directory, { recursive: true, force: true }) }
  })

  test('Given 待发送样本 When 真实payload预算拒绝或请求取消 Then 不登记已读且下一次有效请求仍携带样本', async () => {
    /** 先让一次失败请求留下未消费图片。 */
    const current = fixture({ runId: 'run-a', initialContextId: 'context-a' })
    current.provider.setResponses([fauxAssistantMessage(call('inspect', 'inspect-1'), { stopReason: 'toolUse' }), fauxAssistantMessage('', { stopReason: 'error', errorMessage: 'Failed to fetch' })])
    /** 离线 fetch 兜底；预算拒绝应发生在调用它之前。 */
    let fetches = 0
    try {
      await current.agent.prompt('检查')
      current.setStream((model, context, options) => streamSimple({ ...model, api: 'openai-completions' }, context, { ...options, apiKey: 'offline', maxRetries: 0,
        fetch: Object.assign(async () => { fetches += 1; throw new Error('测试禁止联网') }, { preconnect: () => undefined }) }))
      installPiImageRequestPolicy(current.agent)
      /** 复用上一失败请求实际含图的上下文，通过完整编码器触发最终 payload 上限。 */
      const context = current.contexts[1]!
      /** 原有 payload hook 的返回值仍受到通用预算保护。 */
      const budgetStream = await current.agent.streamFunction(current.agent.state.model!, context, { onPayload: () => ({ padding: 'x'.repeat(17 * 1024 * 1024) }) })
      expect((await budgetStream.result()).errorMessage).toContain('MODEL_REQUEST_BUDGET_EXCEEDED')
      expect(fetches).toBe(0)
      expect(await observationBlocked(current.agent)).toBe(true)
      /** 取消也必须保持失败语义，不能利用同一待检查样本放行 record。 */
      const controller = new AbortController()
      controller.abort()
      /** 通用策略将取消转换成正常 Pi aborted 终态。 */
      const cancelled = await current.agent.streamFunction(current.agent.state.model!, context, { signal: controller.signal })
      expect((await cancelled.result()).stopReason).toBe('aborted')
      expect(await observationBlocked(current.agent)).toBe(true)
      current.setStream(current.provider.provider.streamSimple)
      current.provider.setResponses([fauxAssistantMessage(call('observation', 'observe-1'), { stopReason: 'toolUse' }), fauxAssistantMessage('成功')])
      await current.agent.prompt('重新检查')
      expect(current.getObservations()).toBe(1)
      expect(current.contexts.slice(-2).map(imageCount)).toEqual([1, 1])
    } finally { current.release() }
  })

  test('Given 重复检查同一图片 When 通用策略精确去重 Then 实际一张图片即可支持两个对应证据', async () => {
    /** 相同图片的不同检查证据都应建立在同一次成功送达上。 */
    const current = fixture({ runId: 'run-a', initialContextId: 'context-a' })
    installPiImageRequestPolicy(current.agent)
    current.provider.setResponses([
      fauxAssistantMessage([call('inspect', 'inspect-1'), call('inspect', 'inspect-2', 'context-a', 'evidence-b')], { stopReason: 'toolUse' }),
      fauxAssistantMessage(fauxToolCall(names.observation, { contextId: 'context-a', evidenceIds: ['evidence-a', 'evidence-b'], evidenceId: 'unused' }, { id: 'observe-both' }), { stopReason: 'toolUse' }),
      fauxAssistantMessage('比较完成'),
    ])
    try {
      await current.agent.prompt('重复图片的两个检查角度')
      expect(current.contexts.map(imageCount)).toEqual([0, 1, 1])
      expect(current.getObservations()).toBe(1)
    } finally { current.release() }
  })

  test('Given 前置权限与结果钩子 When 安装影像生命周期 Then 原阻断、终止标记和details继续生效', async () => {
    /** 原权限逻辑阻止 record，即使本次图片已成功送达也不能覆盖其决定。 */
    const current = fixture({ runId: 'run-a', initialContextId: 'context-a' }, true, agent => {
      agent.beforeToolCall = async context => context.toolCall.name === names.observation ? { block: true, reason: 'EXISTING_PERMISSION_BLOCK' } : undefined
      agent.afterToolCall = async context => context.toolCall.name === names.inspect
        ? { details: { ...(context.result.details as Record<string, unknown>), existing: 'preserved' }, terminate: true } : undefined
    })
    current.provider.setResponses([fauxAssistantMessage(call('inspect', 'inspect-1'), { stopReason: 'toolUse' }), fauxAssistantMessage('不应调用')])
    try {
      await current.agent.prompt('检查')
      expect(current.contexts.length).toBe(1)
      expect(JSON.stringify(current.agent.state.messages)).toContain('preserved')
      expect(JSON.stringify(current.agent.state.messages)).not.toContain(image.data)
      expect(await observationBlocked(current.agent)).toBe(true)
    } finally { current.release() }
  })

  test('Given 当前任务样本超过内存预算 When 多次inspect Then 拒绝额外样本并保留先前必要图片', async () => {
    /** 大字节仅用于内存预算边界，不经过图片编码器或联网。 */
    const current = fixture({ runId: 'run-a', initialContextId: 'context-a' })
    /** 每次原始样本 25 MiB，第二张超过 48 MiB 暂存上限；与最终预览预算分开。 */
    const oversized = { ...image, data: 'A'.repeat(25 * 1024 * 1024) }
    current.agent.state.tools.find(tool => tool.name === names.inspect)!.execute = async (_callId, input) => ({
      content: [oversized], details: { visualTaskContext: { version: 1, runId: 'run-a', contextId: 'context-a', action: 'inspect', evidenceId: (input as { evidenceId: string }).evidenceId, mediaId: mediaHash, mediaHash, inspectionKind: 'visual' } },
    })
    current.provider.setResponses([fauxAssistantMessage([call('inspect', 'inspect-1'), call('inspect', 'inspect-2', 'context-a', 'evidence-b')], { stopReason: 'toolUse' }), fauxAssistantMessage('先处理第一张')])
    try {
      await current.agent.prompt('比较')
      expect(current.contexts.map(imageCount)).toEqual([0, 1])
      expect(JSON.stringify(current.agent.state.messages)).toContain('VISUAL_CONTEXT_SAMPLE_BUDGET')
      expect(JSON.stringify(current.agent.state.messages).length).toBeLessThan(15000)
    } finally { current.release() }
  })

  test('Given 运行已结束并从历史恢复 When 引用旧证据 Then 只保留重读引用且不能冒充重新看过', async () => {
    /** 首次检查成功但没有显式关闭，运行收尾仍必须释放内存。 */
    const current = fixture({ runId: 'run-a', initialContextId: 'context-a' })
    current.provider.setResponses([fauxAssistantMessage(call('inspect', 'inspect-1'), { stopReason: 'toolUse' }), fauxAssistantMessage('已查看')])
    await current.agent.prompt('检查')
    current.release()
    /** 恢复只使用持久消息，没有复制旧运行内存或 delivered 状态。 */
    const restored = fixture({ runId: 'run-b', initialContextId: 'context-a' })
    restored.agent.state.messages = structuredClone(current.agent.state.messages)
    restored.provider.setResponses([fauxAssistantMessage(call('observation', 'observe-1'), { stopReason: 'toolUse' }), fauxAssistantMessage('需要重读')])
    try {
      await restored.agent.prompt('继续')
      expect(restored.contexts.map(imageCount)).toEqual([0, 0])
      expect(restored.getObservations()).toBe(0)
      expect(JSON.stringify(restored.agent.state.messages)).toContain('重新打开任务上下文')
    } finally { restored.release() }
  })

  test('Given 原图超过12MiB但可压缩 When 影像暂存后经通用预览 Then 合法原图可看且最终请求仍小于12MiB', async () => {
    /** 低压缩 PNG 约27MB，处于作品32MiB源文件范围，预览可明显缩小。 */
    const bytes = await sharp({ create: { width: 3000, height: 3000, channels: 3, background: '#334455' } }).png({ compressionLevel: 0 }).toBuffer()
    /** 原图内容身份与预览内容身份不同，不能提前替换全局去重身份。 */
    const largeHash = createHash('sha256').update(bytes).digest('hex')
    /** 工具提供的原始字节只暂存在当前运行，不进入会话。 */
    const originalImage: ImageContent = { type: 'image', mimeType: 'image/png', data: bytes.toString('base64') }
    /** 完整安装顺序与生产 adapter 一致。 */
    const current = fixture({ runId: 'run-a', initialContextId: 'context-a' })
    current.agent.state.tools.find(tool => tool.name === names.inspect)!.execute = async () => ({
      content: [originalImage], details: { visualTaskContext: { version: 1, runId: 'run-a', contextId: 'context-a', action: 'inspect', evidenceId: 'evidence-a', mediaId: largeHash, mediaHash: largeHash, inspectionKind: 'visual' } },
    })
    installPiImageRequestPolicy(current.agent)
    current.provider.setResponses([fauxAssistantMessage(call('inspect', 'inspect-1'), { stopReason: 'toolUse' }), fauxAssistantMessage(call('observation', 'observe-1'), { stopReason: 'toolUse' }), fauxAssistantMessage('已检查预览')])
    try {
      await current.agent.prompt('查看大原图')
      expect(bytes.length).toBeLessThan(32 * 1024 * 1024)
      expect(originalImage.data.length).toBeGreaterThan(12 * 1024 * 1024)
      expect(current.contexts.map(imageCount)).toEqual([0, 1, 1])
      expect(JSON.stringify(current.contexts[1]).length).toBeLessThan(12 * 1024 * 1024)
      expect(JSON.stringify(current.contexts[1])).toContain(`image-${largeHash}`)
      expect(current.getObservations()).toBe(1)
      expect(JSON.stringify(current.agent.state.messages).length).toBeLessThan(15000)
    } finally { current.release() }
  })

  test('Given 非影像工具返回相似details When 名称恰好与对象原型属性相同 Then 不介入其结果或赋予任务权限', async () => {
    /** constructor 是合法工具名称，但不属于精确的宿主影像工具白名单。 */
    const current = fixture({ runId: 'run-a', initialContextId: 'context-a' })
    current.agent.state.tools.push({ name: 'constructor', label: '其他工具', description: '无影像权限', parameters: Type.Object({}),
      execute: async () => ({ content: [{ type: 'text', text: '普通工具结果' }], details: { visualTaskContext: { version: 1, runId: 'run-a', contextId: 'context-b', action: 'open' } } }) })
    current.provider.setResponses([fauxAssistantMessage(fauxToolCall('constructor', {}, { id: 'unrelated-tool' }), { stopReason: 'toolUse' }), fauxAssistantMessage('普通结果')])
    try {
      await current.agent.prompt('执行其他工具')
      /** 验证真实工具结果没有被影像钩子误改成错误。 */
      const result = current.agent.state.messages.find(message => message.role === 'toolResult' && message.toolCallId === 'unrelated-tool')
      expect(result?.role === 'toolResult' && result.isError).toBe(false)
      expect(JSON.stringify(current.agent.state.messages)).not.toContain('VISUAL_CONTEXT_EVENT_INVALID')
    } finally { current.release() }
  })
})
