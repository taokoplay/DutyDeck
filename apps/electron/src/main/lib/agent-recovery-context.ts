import { createHash } from 'node:crypto'
import { realpathSync } from 'node:fs'
import type { AgentRunJournalEvent, AgentSessionMeta } from '@dutydeck/shared'
import { DUTYDECK_DEFAULT_PERMISSION_MODE } from '@dutydeck/shared'
import type { PiAgentQueryOptions } from './adapters/pi-agent-adapter'
import type { AgentRunExtensions } from './agent-run-extensions'

/** 恢复只接受普通用户运行；外部可信扩展含不可重建的闭包，不能从公共入口提升能力。 */
export function isExactRecoveryEligible(triggeredBy: string | undefined, extensions: AgentRunExtensions): boolean {
  return (!triggeredBy || triggeredBy === 'user')
    && (Object.keys(extensions).length === 0 || Boolean(extensions.piResumeContinuation && extensions.exactRecoveryEligible))
}

/** 将会话当前有效权限及配置投影成预检合同；空字段统一为 null，便于稳定比较。 */
export function getRecoverySessionContext(session: Pick<AgentSessionMeta, 'channelId' | 'modelId' | 'workspaceId' | 'toolMode' | 'permissionMode'>) {
  return { channelId: session.channelId, modelId: session.modelId ?? null, workspaceId: session.workspaceId ?? null,
    toolMode: session.toolMode ?? 'standard', permissionMode: session.permissionMode ?? DUTYDECK_DEFAULT_PERMISSION_MODE }
}

/** 找到实际发给 Pi 前保存的摘要；旧日志缺少证据时拒绝而不猜当前配置。 */
export function requireRecoveryContextDigest(events: readonly AgentRunJournalEvent[]): string {
  const digest = events.find((event) => event.payload.stage === 'runtime-context')?.payload.digest
  if (typeof digest !== 'string' || !/^[a-f0-9]{64}$/.test(digest)) throw new Error('AGENT_RUN_RECOVERY_CONTEXT_CHANGED')
  return digest
}

/** 原始用户身份必须同时出现于 Journal 和核验过的 Pi 绑定，用于恢复同一套会话工具。 */
export function requireRecoveryUserMessageUuid(events: readonly AgentRunJournalEvent[], entryBindings: Readonly<Record<string, string>>): string {
  const uuid = events.find((event) => event.eventType === 'user_turn')?.payload.userMessageUuid
  if (typeof uuid !== 'string' || !uuid || !entryBindings[uuid]) throw new Error('AGENT_RUN_RECOVERY_CONTEXT_CHANGED')
  return uuid
}

/**
 * 对实际授权根、渠道、工具合同和稳定指令求摘要；仅持久化 hash，不保存密钥或提示正文。
 * 排除用户 prompt、动态时间及当前 UI 状态，它们不构成新的运行授权。
 */
export function createRecoveryContextDigest(input: {
  query: PiAgentQueryOptions
  hostVersion: string
  modulePrompts: readonly string[]
  extensions: AgentRunExtensions
}): string {
  const { query, extensions } = input
  const snapshot = {
    version: 1, hostVersion: input.hostVersion,
    provider: query.provider, baseUrl: query.baseUrl, model: query.model, modelContextWindow: query.modelContextWindow,
    cwd: resolveRecoveryPath(query.cwd), additionalDirectories: query.additionalDirectories?.map(resolveRecoveryPath).sort(),
    permissionMode: query.permissionMode, toolMode: query.toolMode,
    activeToolNames: query.activeToolNames ? [...query.activeToolNames].sort() : null,
    customTools: query.customTools?.map((tool) => ({ name: tool.name, description: tool.description, parameters: tool.parameters }))
      .sort((left, right) => left.name.localeCompare(right.name)),
    instructions: query.projectInstructionFiles?.map((file) => ({ path: resolveRecoveryPath(file.path), content: file.content })),
    projectRoot: resolveRecoveryPath(query.projectInstructionScope?.projectRoot),
    skillPaths: query.additionalSkillPaths?.map(resolveRecoveryPath).sort(),
    modulePrompts: input.modulePrompts, extensionPrompt: extensions.systemPromptAppend,
    singleApprovalToolNames: extensions.singleApprovalToolNames ? [...extensions.singleApprovalToolNames].sort() : [],
    readOnlyToolNames: extensions.readOnlyToolNames ? [...extensions.readOnlyToolNames].sort() : [],
    toolCallLimits: extensions.toolCallLimits, skillsMode: extensions.skillsMode,
    thinkingLevel: query.thinkingLevel, openAIThinkingLevel: query.openAIThinkingLevel,
    runtimeEnv: query.runtimeEnv, proxyUrl: query.proxyUrl, transport: query.transport,
    maxTurns: query.maxTurns, maxBudgetUsd: query.maxBudgetUsd,
    localModel: query.localModelBinding ? { assetId: query.localModelBinding.assetId, modelId: query.localModelBinding.modelId,
      engineVersion: query.localModelBinding.engineVersion, contextWindow: query.localModelBinding.contextWindow, maxTokens: query.localModelBinding.maxTokens } : undefined,
  }
  return createHash('sha256').update(stableContextJson(snapshot)).digest('hex')
}

/** 真实路径防止同名目录通过 symlink 换根；缺失目录保留原路径，由运行时常规校验处理。 */
function resolveRecoveryPath(path: string | undefined): string | undefined {
  if (!path) return undefined
  try { return realpathSync(path) } catch { return path }
}

/** 对对象键排序，保持数组的合同顺序；不读取函数实现或隐藏属性。 */
function stableContextJson(value: unknown): string {
  if (value === undefined) return 'null'
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(stableContextJson).join(',')}]`
  const record = value as Record<string, unknown>
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${stableContextJson(record[key])}`).join(',')}}`
}
