/**
 * 手动压缩的摘要策略扩展。
 *
 * 通过 Pi 官方的 `session_before_compact` hook 接管“摘要内容怎么生成”，
 * 其余流程（切点、持久化、事件、上下文刷新、取消）仍由 Pi 负责，避免复制
 * Pi 的会话状态机。
 *
 * 只在摘要输入超过模型预算时介入：
 * 1. 先做一次有界降级（截断工具结果、丢弃 thinking）；
 * 2. 仍放不下时切成连续分块，逐块摘要并链式携带上一份摘要；
 * 3. 任何规划或鉴权失败都返回 undefined，让 Pi 回退到原有单次摘要路径。
 *
 * 自动阈值/溢出压缩不在此接管，保持 Pi 的自动续跑语义不变。
 */

import type { Api, Model, Usage } from '@earendil-works/pi-ai'
import type {
  AgentSession,
  CompactionResult,
  ExtensionAPI,
  ExtensionContext,
  FileOperations,
  InlineExtension,
  SessionBeforeCompactEvent,
} from '@earendil-works/pi-coding-agent'
import { compactionSummaryInputLimit, compactionSummaryOutputBudget, estimateSummaryPromptTokens, planSummaryChunks, reduceSummaryInput } from './pi-compaction-strategy'

type PiSdk = typeof import('@earendil-works/pi-coding-agent')
/** Pi 未从主入口导出 preparation 与 retry 类型，这里从函数签名推导。 */
type CompactionPreparation = SessionBeforeCompactEvent['preparation']
type RetryPolicy = Parameters<PiSdk['compact']>[9]

/** 扩展所需的宿主能力；全部由 adapter 闭包提供。 */
export interface PiCompactionExtensionDeps {
  sdk: PiSdk
  getSession: () => AgentSession | undefined
  getModel: () => Model<Api> | undefined
  getCompactionSettings: (model: Model<Api>) => {
    enabled: boolean
    reserveTokens: number
    keepRecentTokens: number
  }
  getRetrySettings: () => RetryPolicy
}

/** 空文件操作集合：前序分块不重复写文件清单。 */
function emptyFileOps(): FileOperations {
  return { read: new Set<string>(), written: new Set<string>(), edited: new Set<string>() }
}

/** 累加多次摘要请求的 usage。 */
function addSummaryUsage(total: Usage | undefined, next: Usage | undefined): Usage | undefined {
  if (!next) return total
  if (!total) return next
  return {
    ...total,
    reported: total.reported ?? next.reported,
    input: total.input + next.input,
    output: total.output + next.output,
    cacheRead: total.cacheRead + next.cacheRead,
    cacheWrite: total.cacheWrite + next.cacheWrite,
    ...(total.cacheWrite1h === undefined && next.cacheWrite1h === undefined
      ? {}
      : { cacheWrite1h: (total.cacheWrite1h ?? 0) + (next.cacheWrite1h ?? 0) }),
    ...(total.reasoning === undefined && next.reasoning === undefined
      ? {}
      : { reasoning: (total.reasoning ?? 0) + (next.reasoning ?? 0) }),
    totalTokens: total.totalTokens + next.totalTokens,
    cost: {
      input: total.cost.input + next.cost.input,
      output: total.cost.output + next.cost.output,
      cacheRead: total.cost.cacheRead + next.cost.cacheRead,
      cacheWrite: total.cost.cacheWrite + next.cost.cacheWrite,
      total: total.cost.total + next.cost.total,
    },
  }
}

/**
 * 生成一个只接管手动压缩摘要的 inline extension。
 *
 * 返回 undefined 时 Pi 走默认单次摘要，因此该扩展不会新增失败模式。
 */
export function createPiCompactionExtension(deps: PiCompactionExtensionDeps): InlineExtension {
  return {
    name: 'dutydeck-compaction',
    hidden: true,
    factory: (pi: ExtensionAPI) => {
      pi.on('session_before_compact', async (event, ctx) => {
        if (event.reason !== 'manual') return undefined
        try {
          return await compactByBudget(deps, event, ctx.model ?? deps.getModel(), ctx)
        } catch (error) {
          // 任何策略失败都交回 Pi 默认摘要，保持改造前的可观测行为。
          console.warn('[PiCompaction] 预算策略回退到默认摘要:', error)
          return undefined
        }
      })
    },
  }
}

/** 按预算决定降级、分块或交回默认路径。 */
async function compactByBudget(
  deps: PiCompactionExtensionDeps,
  event: SessionBeforeCompactEvent,
  model: Model<Api> | undefined,
  ctx: ExtensionContext,
): Promise<{ compaction: CompactionResult } | undefined> {
  if (!model) return undefined
  const { sdk } = deps
  const preparation = event.preparation
  const settings = deps.getCompactionSettings(model)
  if (!settings.enabled) return undefined

  const contextWindow = model.contextWindow ?? 200_000
  const reserveTokens = Math.max(1, settings.reserveTokens)
  const modelMaxTokens = model.maxTokens
  const inputLimit = compactionSummaryInputLimit({
    hardLimit: Math.max(1, contextWindow - reserveTokens),
    requestHeadroom: reserveTokens,
    modelMaxTokens,
  })
  const serialize = (messages: Parameters<typeof sdk.convertToLlm>[0]): string =>
    sdk.serializeConversation(sdk.convertToLlm(messages))
  const estimate = (message: Parameters<typeof sdk.estimateTokens>[0]): number =>
    sdk.estimateTokens(message)
  const overBudget = (input: CompactionPreparation): boolean =>
    estimateSummaryPromptTokens(input, serialize) >= inputLimit

  // 输入本身能放进单次请求：保持 Pi 默认摘要，不做多余改动。
  if (!overBudget(preparation)) return undefined

  const reduced = reduceSummaryInput(preparation) ?? preparation
  const chunks = overBudget(reduced)
    ? planSummaryChunks(reduced, {
        summaryInputLimit: inputLimit,
        reserveTokens: compactionSummaryOutputBudget({ requestHeadroom: reserveTokens, modelMaxTokens }),
        estimate,
      })
    : undefined
  // 分块不可行时交回默认路径；默认路径的成功/失败语义与改造前一致。
  if (overBudget(reduced) && !chunks) return undefined

  const auth = await eventAuth(ctx, model)
  if (!auth) return undefined
  const requestModel = auth.baseUrl ? { ...model, baseUrl: auth.baseUrl } : model
  const streamFn = deps.getSession()?.agent.streamFunction
  const thinkingLevel = ctx.thinkingLevel
  const retry = deps.getRetrySettings()
  const runCompact = (input: CompactionPreparation): Promise<CompactionResult> =>
    sdk.compact(
      input,
      requestModel,
      auth.apiKey,
      auth.headers as Record<string, string> | undefined,
      event.customInstructions,
      event.signal,
      thinkingLevel,
      streamFn,
      auth.env,
      retry,
      undefined,
      undefined,
    )

  if (!chunks) {
    return { compaction: await runCompact(reduced) }
  }

  // 分块链式摘要：每块携带上一块摘要，文件清单只附加到最后一块。
  let summary = reduced.previousSummary
  let usage: Usage | undefined
  let details: CompactionResult['details']
  for (const [index, messages] of chunks.entries()) {
    const last = index === chunks.length - 1
    const step = await runCompact({
      ...reduced,
      messagesToSummarize: messages,
      turnPrefixMessages: [],
      isSplitTurn: false,
      previousSummary: summary,
      fileOps: last ? reduced.fileOps : emptyFileOps(),
    })
    summary = step.summary
    usage = addSummaryUsage(usage, step.usage)
    if (last) details = step.details
  }
  return {
    compaction: {
      summary: summary ?? '',
      firstKeptEntryId: preparation.firstKeptEntryId,
      tokensBefore: preparation.tokensBefore,
      usage,
      details,
    },
  }
}

/** 从扩展上下文解析摘要请求的鉴权；模型未配置凭据时不接管。 */
async function eventAuth(
  ctx: ExtensionContext,
  model: Model<Api>,
): Promise<{ apiKey?: string; headers?: unknown; baseUrl?: string; env?: Record<string, string> } | undefined> {
  const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model)
  if (!auth.ok) return undefined
  return { apiKey: auth.apiKey, headers: auth.headers, baseUrl: auth.baseUrl, env: auth.env }
}
