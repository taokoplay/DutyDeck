/**
 * Agent 模块与插件的跨进程合同。
 *
 * 模块是用户可见的能力集合；Plugin 是模块的安装/运行载体；Skill、prompt、tool
 * 是模块向 Agent 暴露的具体贡献。该文件只放可序列化类型和纯校验，避免依赖 Electron。
 */

/**
 * 判断模块是否属于宿主固定的常用自动能力；第三方清单不能自行申请自动接入。
 * @param moduleId 稳定模块 ID。
 * @returns 仅浏览器和终端返回 true，专业模块与未来插件均须显式选择。
 */
export function isAutomaticAgentModuleId(moduleId: string): boolean {
  return moduleId === 'browser' || moduleId === 'terminal'
}

export type AgentModuleMode = 'auto' | 'available' | 'pinned'
export type AgentModuleInvocationMode = 'available' | 'pinned' | 'invoke'
export type AgentModuleScope = 'session' | 'project' | 'global'
export type AgentModuleContribution = 'surface' | 'skill' | 'prompt' | 'tool' | 'artifact'
/** 模块默认接入方式；旧清单缺失时必须保持逐消息显式调用。 */
export type AgentModuleActivationMode = 'message-explicit' | 'session-toggle'

/** Session 接入时冻结的模块身份；插件升级或替换后旧运行会 fail closed。 */
export interface AgentSessionModuleBinding {
  moduleId: string
  moduleVersion: string
  packageHash?: string
}

export interface AgentModuleManifest {
  id: string
  version: string
  apiVersion: 1
  displayName: string
  description: string
  icon: string
  scope: AgentModuleScope
  contributions: AgentModuleContribution[]
  skillRefs: string[]
  promptRefs: string[]
  toolRefs: string[]
  artifactTypes: string[]
  surfaceIds: string[]
  requiredPermissions: string[]
  /** 只有 session-toggle 模块才能由右侧菜单附着到当前 Session。 */
  activation?: AgentModuleActivationMode
  minHostVersion?: string
  /** 宿主目录投影的来源；第三方 manifest 不可通过输入清单自行伪造。 */
  source?: 'builtin' | 'installed'
  /** 宿主目录投影中的插件身份。 */
  pluginId?: string
  /** 包资源由插件宿主验证，不使用工作区 Skill 文件的管理语义。 */
  resourceSource?: 'package'
  /** 不可变包身份，用于运行前核验及恢复上下文绑定。 */
  packageHash?: string
}

export interface AgentSessionModulePolicy {
  mode: AgentModuleMode
  enabledModuleIds: string[]
  disabledModuleIds: string[]
  pinnedModuleIds: string[]
  revision: number
  updatedAt: number
  /** 可选以兼容旧会话；新右侧接入会写入版本/hash 快照。 */
  moduleBindings?: AgentSessionModuleBinding[]
}

export interface AgentModuleActivation {
  moduleId: string
  moduleVersion: string
  mode: AgentModuleMode
  invocationMode?: AgentModuleInvocationMode
  skillRefs: string[]
  promptRefs: string[]
  activatedAt: number
  sessionId: string
  policyRevision: number
}

export type AgentModuleCommandStatus = 'draft' | 'queued' | 'running' | 'applied' | 'canceled' | 'expired' | 'failed'

export interface AgentModuleCommand {
  commandId: string
  sessionId: string
  moduleId: string
  capabilityId: string
  baseRevision: number
  invocationMode: AgentModuleInvocationMode
  deliveryMode: 'draft' | 'enqueue' | 'auto'
  requestSummary: string
  input: Record<string, unknown>
  idempotencyKey: string
  status: AgentModuleCommandStatus
  createdAt: number
  updatedAt: number
  errorCode?: string
}

/** 更新 Session 模块策略的 IPC 输入。 */
export interface AgentSessionModulePolicyUpdateInput {
  sessionId: string
  policy: Partial<AgentSessionModulePolicy>
  expectedRevision?: number
}

/** Session 右侧工具目录中单个模块的可见状态。 */
export type AgentSessionModuleEntryState = 'available' | 'attached' | 'unavailable'

/** 右侧工具菜单使用的模块目录条目；只投影宿主已知的面板入口。 */
export interface WorkspaceToolEntry {
  id: string
  displayName: string
  description: string
  icon: string
  group: '专业工具' | '插件工具'
  surfaceId: string
  moduleVersion: string
  activation: AgentModuleActivationMode
  state: AgentSessionModuleEntryState
  source?: AgentModuleManifest['source']
  pluginId?: string
  packageHash?: string
  reason?: string
}

/** 当前 Session 的模块目录快照；revision 与策略保持同一提交边界。 */
export interface AgentSessionModuleCatalog {
  sessionId: string
  revision: number
  policy: AgentSessionModulePolicy
  entries: WorkspaceToolEntry[]
}

/** 从右侧工具菜单原子接入或移除一个模块。 */
export interface AgentSessionModuleToggleInput {
  sessionId: string
  moduleId: string
  enabled: boolean
  expectedRevision?: number
}

/** 提交模块动作的 IPC 输入；宿主会在执行前重新校验权限和版本。 */
export interface AgentModuleCommandInput {
  sessionId: string
  moduleId: string
  capabilityId: string
  baseRevision: number
  invocationMode: AgentModuleInvocationMode
  deliveryMode?: AgentModuleCommand['deliveryMode']
  requestSummary: string
  input: Record<string, unknown>
  idempotencyKey: string
}

/** 模块命令查询条件；缺省时只返回当前 Session 的全部命令。 */
export interface AgentModuleCommandQuery {
  sessionId: string
  status?: AgentModuleCommandStatus
}

export interface ParsedAgentModuleManifest {
  manifest: AgentModuleManifest
  warnings: string[]
}

const MODULE_ID_PATTERN = /^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/
const VERSION_PATTERN = /^[0-9]+\.[0-9]+\.[0-9]+(?:[-+][0-9A-Za-z.-]+)?$/

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string' && item.trim().length > 0)
}

function uniqueStrings(values: readonly string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))]
}

/**
 * 解析并校验插件模块 manifest；错误直接抛出，避免不可用模块进入 Agent 能力目录。
 * @param value 未信任的 manifest 数据。
 * @returns 规范化后的 manifest 和非阻断警告。
 */
export function parseAgentModuleManifest(value: unknown): ParsedAgentModuleManifest {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('AGENT_MODULE_MANIFEST_INVALID')
  const record = value as Record<string, unknown>
  const requiredStrings = ['id', 'version', 'displayName', 'description', 'icon', 'scope'] as const
  for (const key of requiredStrings) {
    if (typeof record[key] !== 'string' || record[key].trim().length === 0) {
      throw new Error(`AGENT_MODULE_MANIFEST_${key.toUpperCase()}_INVALID`)
    }
  }
  const id = record.id as string
  const version = record.version as string
  const scope = record.scope as string
  if (!MODULE_ID_PATTERN.test(id)) throw new Error('AGENT_MODULE_MANIFEST_ID_INVALID')
  if (!VERSION_PATTERN.test(version)) throw new Error('AGENT_MODULE_MANIFEST_VERSION_INVALID')
  if (record.apiVersion !== 1) throw new Error('AGENT_MODULE_MANIFEST_API_VERSION_UNSUPPORTED')
  if (scope !== 'session' && scope !== 'project' && scope !== 'global') throw new Error('AGENT_MODULE_MANIFEST_SCOPE_INVALID')
  if (record.activation !== undefined && record.activation !== 'session-toggle' && record.activation !== 'message-explicit') {
    throw new Error('AGENT_MODULE_MANIFEST_ACTIVATION_INVALID')
  }

  const arrayFields = ['contributions', 'skillRefs', 'promptRefs', 'toolRefs', 'artifactTypes', 'surfaceIds', 'requiredPermissions'] as const
  for (const key of arrayFields) {
    /** 引用是有限能力声明；在去重前限制数量，防止重复项放大解析和落盘开销。 */
    const refs = record[key]
    if (Array.isArray(refs) && (refs.length > 256 || refs.some((ref) => typeof ref === 'string' && ref.length > 256))) {
      throw new Error(`AGENT_MODULE_MANIFEST_${key.toUpperCase()}_TOO_LARGE`)
    }
    if (!isStringArray(record[key])) throw new Error(`AGENT_MODULE_MANIFEST_${key.toUpperCase()}_INVALID`)
  }

  const contributions = uniqueStrings(record.contributions as string[]) as AgentModuleContribution[]
  const allowedContributions = new Set<AgentModuleContribution>(['surface', 'skill', 'prompt', 'tool', 'artifact'])
  if (contributions.some((item) => !allowedContributions.has(item))) throw new Error('AGENT_MODULE_MANIFEST_CONTRIBUTION_INVALID')

  const manifest: AgentModuleManifest = {
    id,
    version,
    apiVersion: 1,
    displayName: (record.displayName as string).trim(),
    description: (record.description as string).trim(),
    icon: (record.icon as string).trim(),
    scope: scope as AgentModuleScope,
    contributions,
    skillRefs: uniqueStrings(record.skillRefs as string[]),
    promptRefs: uniqueStrings(record.promptRefs as string[]),
    toolRefs: uniqueStrings(record.toolRefs as string[]),
    artifactTypes: uniqueStrings(record.artifactTypes as string[]),
    surfaceIds: uniqueStrings(record.surfaceIds as string[]),
    requiredPermissions: uniqueStrings(record.requiredPermissions as string[]),
    ...(record.activation === 'session-toggle' || record.activation === 'message-explicit'
      ? { activation: record.activation }
      : {}),
    ...(typeof record.minHostVersion === 'string' && record.minHostVersion.trim().length > 0
      ? { minHostVersion: record.minHostVersion.trim() }
      : {}),
  }
  const warnings: string[] = []
  if (manifest.contributions.includes('skill') && manifest.skillRefs.length === 0) warnings.push('AGENT_MODULE_SKILL_CONTRIBUTION_EMPTY')
  if (manifest.contributions.includes('surface') && manifest.surfaceIds.length === 0) warnings.push('AGENT_MODULE_SURFACE_CONTRIBUTION_EMPTY')
  return { manifest, warnings }
}

/**
 * 规范化 Session 模块策略；旧数据或非法数组按安全默认值回退。
 * @param value 可能来自旧 Session JSON 的未知数据。
 * @param now 当前时间戳，用于补齐更新时间。
 * @returns 可直接持久化和比较的模块策略。
 */
export function normalizeAgentSessionModulePolicy(value: unknown, now = Date.now()): AgentSessionModulePolicy {
  const record = value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
  const mode = record.mode === 'available' || record.mode === 'pinned' ? record.mode : 'auto'
  const normalizeIds = (field: string): string[] => {
    const raw = record[field]
    return isStringArray(raw) ? uniqueStrings(raw) : []
  }
  const disabledModuleIds = normalizeIds('disabledModuleIds')
  const disabled = new Set(disabledModuleIds)
  const enabledModuleIds = normalizeIds('enabledModuleIds').filter((id) => !disabled.has(id))
  const enabled = new Set(enabledModuleIds)
  const pinnedModuleIds = normalizeIds('pinnedModuleIds').filter((id) => enabled.has(id))
  const moduleBindings = Array.isArray(record.moduleBindings)
    ? record.moduleBindings.flatMap((item): AgentSessionModuleBinding[] => {
      if (!item || typeof item !== 'object' || Array.isArray(item)) return []
      const binding = item as Record<string, unknown>
      if (typeof binding.moduleId !== 'string' || typeof binding.moduleVersion !== 'string') return []
      if (binding.packageHash !== undefined && typeof binding.packageHash !== 'string') return []
      return [{ moduleId: binding.moduleId, moduleVersion: binding.moduleVersion, ...(typeof binding.packageHash === 'string' ? { packageHash: binding.packageHash } : {}) }]
    })
    : []
  const revision = typeof record.revision === 'number' && Number.isSafeInteger(record.revision) && record.revision >= 0
    ? record.revision
    : 0
  const updatedAt = typeof record.updatedAt === 'number' && Number.isFinite(record.updatedAt) && record.updatedAt > 0
    ? record.updatedAt
    : now
  return { mode, enabledModuleIds, disabledModuleIds, pinnedModuleIds, revision, updatedAt, ...(moduleBindings.length ? { moduleBindings } : {}) }
}

/**
 * 判断运行日志是否按严格序列递增；空日志视为有效。
 * @param sequences 已读取的事件序列。
 * @returns 是否满足从 1 开始的连续序列合同。
 */
export function isJournalEventSequenceValid(sequences: readonly number[]): boolean {
  return sequences.every((sequence, index) => Number.isSafeInteger(sequence) && sequence === index + 1)
}

/**
 * 判断命令是否已使用过同一个幂等键，供恢复时阻止重复副作用。
 * @param seenKeys 已提交的幂等键集合。
 * @param idempotencyKey 待检查的幂等键。
 * @returns 已存在时为 true。
 */
export function isIdempotentReplay(seenKeys: ReadonlySet<string>, idempotencyKey: string): boolean {
  return idempotencyKey.trim().length > 0 && seenKeys.has(idempotencyKey)
}
