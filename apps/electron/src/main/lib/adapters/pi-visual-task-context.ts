import { createHash } from 'node:crypto'
import type { Agent, AgentMessage } from '@earendil-works/pi-agent-core'
import type { ImageContent, TextContent, TranscriptContext } from '@earendil-works/pi-ai'
import type { VisualTaskContextEvent, VisualTaskContextPolicy } from '../visual-production/context-contract'

/** 仅这些宿主工具能够变更影像任务范围；其他工具的同名 details 字段没有权限。 */
const TOOL_ACTIONS: Readonly<Record<string, VisualTaskContextEvent['action']>> = {
  visual_production_open_context: 'open',
  visual_production_inspect_media: 'inspect',
  visual_production_record_observation: 'observation',
  visual_production_close_context: 'close',
}
/** 原始暂存最多 48 MiB Base64，可容纳作品上限 32 MiB 的单图；最终预览仍受通用 12 MiB 请求预算限制。
 * 保留原始字节身份，避免提前有损编码让不同原图被通用策略误合并，并避免重复编码。
 */
const MAX_SAMPLE_CHARACTERS = 48 * 1024 * 1024
/** 一个任务至多缓存 64 次检查，超过后要求显式拆分任务。 */
const MAX_SAMPLE_COUNT = 64
/** 已验证内容身份使用完整 SHA-256，避免前缀碰撞或文件名归属推断。 */
const HASH_PATTERN = /^[a-f0-9]{64}$/

/** 一个工具结果对应的临时图片与固定引用；不写入 transcript。 */
interface VisualSamples {
  /** 宿主签发的身份描述。 */
  event: VisualTaskContextEvent
  /** 仅图片字节保留在当前运行内存中。 */
  images: ImageContent[]
  /** 原始样本内容身份，也用于识别通用预览策略生成的去重引用。 */
  hashes: string[]
  /** 技术检查的原文必须实际进入成功请求，单独留下工具身份不算读取。 */
  texts: string[]
}

/** 只读取普通 JSON 对象字段，不接受文本或数组声明宿主事件。 */
function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined
}

/** 宿主身份只允许有界非空字符串，防止任意正文进入恢复提示。 */
function identifier(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 256
}

/** 校验可序列化协议形状；本轮 run 和动作权限还需由调用点重新核对。 */
function readEvent(details: unknown): VisualTaskContextEvent | undefined {
  /** 只有指定字段承载协议，其余 details 保留原状。 */
  const event = record(record(details)?.visualTaskContext)
  if (!event || event.version !== 1 || !identifier(event.runId) || !identifier(event.contextId)
    || !['open', 'inspect', 'close', 'observation'].includes(String(event.action))) return undefined
  return event as unknown as VisualTaskContextEvent
}

/** 按实际图片字节计算身份，避免 Base64 不同文本表示影响精确去重。 */
function imageHash(image: ImageContent): string {
  return createHash('sha256').update(Buffer.from(image.data, 'base64')).digest('hex')
}

/** 用固定媒体引用说明恢复动作；引用本身不能证明模型已经看过图片。 */
function imageReference(event?: VisualTaskContextEvent): TextContent {
  /** 无效或旧协议也不复活历史样本，只呈现经过长度限制的媒体身份。 */
  const mediaId = identifier(event?.mediaId) ? event.mediaId : '原工具结果中的媒体'
  return { type: 'text', text: `[影像图片引用 ${mediaId}：图片仅在当前任务内临时加载。恢复或切换任务后，请重新打开任务上下文并调用 visual_production_inspect_media 读取同一媒体；不能仅凭此引用声称已看图，不要重新生成素材。]` }
}

/** 只替换图片块，保留原始工具文字和工具调用对应关系。 */
function withoutImages(content: Array<ImageContent | TextContent>, event?: VisualTaskContextEvent): Array<ImageContent | TextContent> {
  return content.map(block => block.type === 'image' ? imageReference(event) : block)
}

/** 找到当前分支中完整且唯一的普通 read 调用配对；孤立、缺失或重复记录不授权去图。 */
function pairedReadResults(messages: AgentMessage[]): Set<AgentMessage> {
  /** 全分支唯一性防止重复 toolCallId 将不同调用误关联。 */
  const callCounts = new Map<string, number>()
  /** 工具结果同样必须唯一。 */
  const resultCounts = new Map<string, number>()
  for (const message of messages) {
    if (message.role === 'assistant') for (const block of message.content) {
      if (block.type === 'toolCall') callCounts.set(block.id, (callCounts.get(block.id) ?? 0) + 1)
    }
    if (message.role === 'toolResult') resultCounts.set(message.toolCallId, (resultCounts.get(message.toolCallId) ?? 0) + 1)
  }
  /** 只返回完整工具批次中的普通 read 结果对象。 */
  const paired = new Set<AgentMessage>()
  for (let index = 0; index < messages.length; index += 1) {
    /** 每个 assistant 工具批次独立核验，不能跨用户回合补配。 */
    const message = messages[index]!
    if (message.role !== 'assistant') continue
    /** 工具名称与身份一起匹配，避免自定义工具冒充 read。 */
    const calls = message.content.filter(block => block.type === 'toolCall')
    if (calls.length === 0) continue
    /** 正常 Pi 工具结果在该批次之后连续出现。 */
    const results: Extract<AgentMessage, { role: 'toolResult' }>[] = []
    for (let next = index + 1; next < messages.length; next += 1) {
      /** 遇到用户、assistant 或其他事件立即结束配对范围。 */
      const result = messages[next]!
      if (result.role !== 'toolResult') break
      results.push(result)
    }
    if (results.length !== calls.length || calls.some(call => callCounts.get(call.id) !== 1
      || resultCounts.get(call.id) !== 1 || !results.some(result => result.toolCallId === call.id && result.toolName === call.name))) continue
    for (const result of results) if (result.toolName === 'read' && !result.isError) paired.add(result)
  }
  return paired
}

/** 收集请求实际携带的图片身份；兼容通用预览的压缩与精确去重，文字引用单独不算看图。 */
function sentImageHashes(context: TranscriptContext): Set<string> {
  /** 只有真实 image 块才建立已发送身份。 */
  const hashes = new Set<string>()
  for (const message of context.messages) {
    if (!Array.isArray(message.content)) continue
    for (let index = 0; index < message.content.length; index += 1) {
      /** 预览策略紧邻图片之前写入完整原始内容 SHA-256。 */
      const block = message.content[index]!
      if (block.type !== 'image') continue
      hashes.add(imageHash(block))
      /** 只接受与真实图片紧邻的预览标签，重复图片的纯文字引用不会独立产生证据。 */
      const previous = message.content[index - 1]
      if (previous?.type === 'text') {
        /** 格式由现有 pi-image-request-policy 生成，标识仍须命中内存中的可信样本。 */
        const match = /^\[图片 image-([a-f0-9]{64})：识图预览 /.exec(previous.text)
        if (match?.[1]) hashes.add(match[1])
      }
    }
  }
  return hashes
}

/**
 * 为当前运行安装影像图片隔离、显式任务生命周期与观察准入。
 * @param agent 真实 Pi Agent；应在通用图片请求策略之前安装，以观察最终预览请求。
 * @param policy 宿主签发的可序列化范围策略，不能从模型文字重建。
 * @returns 仅在真实运行收尾调用的释放函数；原生 agent_end 和失败重试不释放样本。
 */
export function installVisualTaskContextLifecycle(agent: Agent, policy: VisualTaskContextPolicy): () => void {
  /** 固定运行身份，不持有可能被外部改写的 policy 对象。 */
  const runId = policy.runId
  /** 主进程可在第一轮模型请求之前建立初始范围。 */
  let activeContextId = policy.initialContextId
  /** 范围曾被明确建立后，已经归属的旧图片保持引用，关闭任务不会复活旧字节。 */
  let explicitScope = identifier(activeContextId)
  /** 真正收尾后禁止异步迟到响应重新登记已读取证据。 */
  let disposed = false
  /** 工具调用身份绑定本轮样本，不从恢复历史重建内存权限。 */
  const samples = new Map<string, VisualSamples>()
  /** 成功请求实际携带的证据；对象身份防止同 ID 迟到结果影响新样本。 */
  const delivered = new Set<VisualSamples>()
  /** 当前临时图片的总 Base64 大小。 */
  let sampleCharacters = 0
  /** 只使用宿主明确提供的精确内容身份，未知媒体保持普通历史行为。 */
  const legacyMedia = new Map((policy.legacyMedia ?? []).filter(media => HASH_PATTERN.test(media.hash)).map(media => [media.hash, media.mediaId]))
  /** 对未改变的历史图片弱缓存 hash，避免每轮重复解码且不延长历史对象寿命。 */
  const legacyHashes = new WeakMap<ImageContent, string>()
  /** 前置权限、运行守卫和其他模块的上下文钩子必须完整保留。 */
  const previousBefore = agent.beforeToolCall
  /** 前置工具结果可能已经带有 isError、terminate 或 usage。 */
  const previousAfter = agent.afterToolCall
  /** 原上下文包含附件、项目指令与旧图校验。 */
  const previousTransform = agent.transformContext
  /** 当前 stream 包含渠道认证、代理等既有运行逻辑。 */
  const previousStream = agent.streamFunction
  /** 清理当前范围的图片和已读取证据，不修改 transcript。 */
  const clear = (): void => { samples.clear(); delivered.clear(); sampleCharacters = 0 }

  agent.beforeToolCall = async (context, signal) => {
    /** 保留已有权限阻断，不让影像逻辑覆盖其他模块的决定。 */
    const previous = await previousBefore?.(context, signal)
    if (previous?.block || context.toolCall.name !== 'visual_production_record_observation') return previous
    /** 观察只接受当前范围内已成功送达的全部证据。 */
    const args = record(context.args)
    /** 空证据、未知证据和其他范围都不能登记视觉观察。 */
    const evidenceIds = args?.evidenceIds
    if (disposed || !activeContextId || args?.contextId !== activeContextId
      || !Array.isArray(evidenceIds) || evidenceIds.length === 0 || evidenceIds.length > MAX_SAMPLE_COUNT
      || evidenceIds.some(id => !identifier(id) || ![...delivered].some(sample => sample.event.evidenceId === id && sample.event.contextId === activeContextId
        && (sample.event.inspectionKind === 'technical' || agent.state.model?.input.includes('image'))))) {
      return { ...previous, block: true, reason: 'VISUAL_CONTEXT_SAMPLES_NOT_DELIVERED: 请先在当前任务读取对应图片，等待模型成功收到实际画面后再登记观察；不能同批读图并盲评。' }
    }
    return previous
  }

  agent.afterToolCall = async (context, signal) => {
    /** 链式结果覆盖按 Pi 原语义保留，不吞掉已有错误或提前终止。 */
    const previous = await previousAfter?.(context, signal)
    /** 精确名称决定动作，任意 MCP 结果不能声明宿主生命周期。 */
    const action = Object.hasOwn(TOOL_ACTIONS, context.toolCall.name) ? TOOL_ACTIONS[context.toolCall.name] : undefined
    if (!action) return previous
    /** 使用前置钩子最终内容与 details，避免绕过其校验。 */
    const content = previous?.content ?? context.result.content
    /** 序列化的宿主事件仅在本次 execute 成功时生效。 */
    const event = readEvent(previous?.details ?? context.result.details)
    /** 检查工具无论成功或失败都不能把图片持久化。 */
    const stripped = action === 'inspect' ? withoutImages(content, event) : content
    /** 运行及范围校验失败返回可诊断工具错误，不在钩子抛错丢失引用。 */
    const reject = (message: string) => ({ ...previous, content: [...stripped, { type: 'text' as const, text: message }], isError: true })
    if (previous?.isError ?? context.isError) return action === 'inspect' ? { ...previous, content: stripped } : previous
    if (disposed || !event || event.runId !== runId || event.action !== action) return reject('VISUAL_CONTEXT_EVENT_INVALID: 当前工具结果缺少有效的本轮任务身份。')
    if (action === 'open') { clear(); activeContextId = event.contextId; explicitScope = true; return previous }
    if (event.contextId !== activeContextId) return reject('VISUAL_CONTEXT_SCOPE_CHANGED: 图片所属任务已关闭或切换，请重新打开明确任务。')
    if (action === 'close') { clear(); activeContextId = undefined; return previous }
    if (action !== 'inspect') return previous
    if (event.inspectionKind !== 'visual' && event.inspectionKind !== 'technical') return reject('VISUAL_CONTEXT_INSPECTION_KIND_INVALID: 宿主必须明确检查提供视觉样本还是技术事实，不能自动降级。')
    if (event.inspectionKind === 'visual' && !agent.state.model?.input.includes('image')) return reject('VISUAL_CONTEXT_VISION_UNAVAILABLE: 当前模型不支持图片，只能核对技术信息，不能登记画面观察。')
    if (!identifier(event.evidenceId) || !identifier(event.mediaId) || typeof event.mediaHash !== 'string' || !HASH_PATTERN.test(event.mediaHash)) {
      return reject('VISUAL_CONTEXT_EVIDENCE_INVALID: 图片缺少固定媒体身份或检查证据，请重新读取。')
    }
    /** 同一范围的检查证据不能被另一次工具调用重新绑定。 */
    if ([...samples.values()].some(sample => sample.event.evidenceId === event.evidenceId)) return reject('VISUAL_CONTEXT_EVIDENCE_REUSED: 检查证据已经存在，请使用原证据或重新签发检查。')
    /** 只在验证全部预算后将图片加入内存，失败不影响此前已读取的比较对象。 */
    const images = content.filter((block): block is ImageContent => block.type === 'image')
    /** 技术结论原文必须实际送达；保留引用而不复制正文副本。 */
    const texts = content.filter((block): block is TextContent => block.type === 'text').map(block => block.text)
    /** Base64 长度直接对应主要内存占用，不解码超出预算的图片。 */
    const characters = images.reduce((total, block) => total + block.data.length, 0)
    if (event.inspectionKind === 'visual' && (images.length === 0 || images.length > MAX_SAMPLE_COUNT || characters === 0)) return reject('VISUAL_CONTEXT_IMAGE_MISSING: 工具未提供有效图片，请重新读取。')
    if (event.inspectionKind === 'technical' && (images.length > 0 || !texts.some(text => text.trim().length > 0))) return reject('VISUAL_CONTEXT_TECHNICAL_EVIDENCE_INVALID: 技术检查必须提供纯文字事实，不能携带未声明的视觉样本。')
    if (samples.size >= MAX_SAMPLE_COUNT || sampleCharacters + characters > MAX_SAMPLE_CHARACTERS) {
      return reject('VISUAL_CONTEXT_SAMPLE_BUDGET: 当前任务图片达到内存上限，请先完成本次比较并显式关闭，再分批检查；已有图片仍保留。')
    }
    samples.set(context.toolCall.id, { event: { ...event }, images: images.map(block => ({ ...block })), hashes: images.map(imageHash), texts })
    sampleCharacters += characters
    return { ...previous, content: stripped }
  }

  agent.transformContext = async (messages, signal) => {
    /** 所有既有投影先完成，影像层仅复制需要变更的工具结果。 */
    const transformed = await previousTransform?.(messages, signal) ?? messages
    /** 没有明确范围时不尝试归属旧普通 read。 */
    const pairedReads = explicitScope && legacyMedia.size > 0 ? pairedReadResults(transformed) : new Set<AgentMessage>()
    return transformed.map((message): AgentMessage => {
      if (message.role !== 'toolResult') return message
      if (message.toolName === 'visual_production_inspect_media') {
        /** 恢复历史绝不重新授权旧 run 的样本，只从本轮已验证内存中加载。 */
        const sample = samples.get(message.toolCallId)
        /** 历史实验版可能残留字节，也只在请求副本去除。 */
        const content = withoutImages(message.content, readEvent(message.details))
        return { ...message, content: !disposed && sample && sample.event.contextId === activeContextId && agent.state.model?.input.includes('image')
          ? [...content, ...sample.images] : content }
      }
      if (!pairedReads.has(message)) return message
      return { ...message, content: message.content.map(block => {
        if (block.type !== 'image') return block
        /** 对象内容来自不可变历史，不修改原图或原工具结果。 */
        const hash = legacyHashes.get(block) ?? imageHash(block)
        legacyHashes.set(block, hash)
        /** hash 未命中宿主范围时保守原样保留。 */
        const mediaId = legacyMedia.get(hash)
        return mediaId ? imageReference({ version: 1, runId, contextId: activeContextId ?? '', action: 'inspect', mediaId }) : block
      }) }
    })
  }

  agent.streamFunction = async (model, context, options) => {
    /** 只有真正 stream 调用中的图片才有资格在成功后记为可观察。 */
    const hashes = model.input.includes('image') && samples.size > 0 ? sentImageHashes(context) : new Set<string>()
    /** 同时要求本次请求包含该检查的工具结果，避免压缩或其他支路误消费证据。 */
    const toolResults = new Map(context.messages.filter(message => message.role === 'toolResult').map(message => [message.toolCallId, message]))
    /** 固定本次发送集合，期间打开新范围也不会把迟到响应记到新任务。 */
    const sent = [...samples.entries()].filter(([toolCallId, sample]) => {
      /** 请求中的同一工具结果必须仍包含对应事实，防止被其他上下文钩子移除后误判已读。 */
      const result = toolResults.get(toolCallId)
      return result && sample.event.contextId === activeContextId && (sample.event.inspectionKind === 'technical'
        ? sample.texts.every(text => result.content.some(block => block.type === 'text' && block.text === text))
        : sample.hashes.every(hash => hashes.has(hash)))
    })
    /** 原有 stream 负责所有真实 provider 错误与取消协议。 */
    const stream = await previousStream(model, context, options)
    void stream.result().then(message => {
      if (disposed || options?.signal?.aborted || !['stop', 'toolUse', 'length'].includes(message.stopReason)) return
      for (const [toolCallId, sample] of sent) {
        if (samples.get(toolCallId) === sample && sample.event.contextId === activeContextId) delivered.add(sample)
      }
    }).catch(() => { /* 观察失败不影响 provider 生命周期，也不能伪造已看图。 */ })
    return stream
  }

  return () => { disposed = true; clear(); activeContextId = undefined }
}
