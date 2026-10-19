import type {
  AgentModuleAuditContribution, AgentModuleAuditSkill, AgentModuleMode, AgentModuleRunAudit,
  AgentModuleRunAuditQuery, AgentRunJournalEvent, SkillActivation,
} from '@dutydeck/shared'

/** 固定投影预算，避免审计 UI 复制无限历史或返回工具参数。 */
const MAX_RUNS = 20
const MAX_ITEMS = 64
const MAX_TOOLS = 128

/** 未知 payload 只按对象处理；不传播原始字段。 */
function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
}

/** 标识符拒绝超长值，不截断后产生身份碰撞。 */
function identifier(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 && value.length <= 256 ? value : undefined
}

/** 模式必须属于宿主合同，异常数据不猜测。 */
function mode(value: unknown): AgentModuleMode | undefined {
  return value === 'auto' || value === 'available' || value === 'pinned' ? value : undefined
}

/** 安全字符串列表，限定数量并拒绝非标识符内容。 */
function refs(value: unknown): string[] {
  return Array.isArray(value) ? value.slice(0, MAX_ITEMS).flatMap(item => identifier(item) ?? []) : []
}

/** 把成功加载的 Skill 绑定到所有实际提供它的模块，不以首个模块伪造唯一归属。 */
export function tagModuleSkillActivations(activations: SkillActivation[], modules: readonly AgentModuleAuditContribution[]): SkillActivation[] {
  return activations.flatMap(activation => {
    /** 同名但非受管来源的文件不能借用模块身份。 */
    const providers = activation.workspaceSlug && activation.workspaceSkillPath === `${activation.slug}/SKILL.md`
      ? modules.filter(module => module.skillRefs.includes(activation.slug)) : []
    if (providers.length === 0) {
      const { moduleId: _moduleId, moduleVersion: _moduleVersion, activationMode: _mode, ...ordinary } = activation
      return [ordinary]
    }
    return providers.map(module => ({
      ...activation,
      moduleId: module.moduleId,
      moduleVersion: module.moduleVersion,
      activationMode: module.invocationMode ?? (module.mode === 'pinned' ? 'pinned' : 'available'),
    }))
  })
}

/** 只投影 Skill 身份；路径、名称、正文均不进入审计读取。 */
export function projectModuleAuditSkills(activations: readonly SkillActivation[]): AgentModuleAuditSkill[] {
  return activations.slice(0, MAX_ITEMS).flatMap(activation => {
    if (!activation.moduleId || !activation.moduleVersion || !activation.activationMode) return []
    return [{ slug: activation.slug, moduleId: activation.moduleId, moduleVersion: activation.moduleVersion, activationMode: activation.activationMode }]
  })
}

/**
 * 从主进程的 Journal 生成有界审计；只按明确 runId/命令身份关联，不解析聊天文本。
 * @param sessionId 由 IPC 核验并用于读取 Journal 的会话身份。
 * @param events 该会话受管 Journal 的真实事件。
 * @param query 可选精确运行/命令过滤条件。
 * @returns 最近最多 20 次运行的安全投影，不含提示正文和工具参数。
 */
export function buildAgentModuleRunAudits(
  sessionId: string,
  events: readonly AgentRunJournalEvent[],
  query: Pick<AgentModuleRunAuditQuery, 'runId' | 'moduleCommandId'> = {},
): AgentModuleRunAudit[] {
  /** 从末尾选取有限运行；保留同一运行首次解析的权威模块快照。 */
  const contexts = new Map<string, AgentRunJournalEvent>()
  for (let index = events.length - 1; index >= 0; index--) {
    const event = events[index]!
    if (event.eventType !== 'checkpoint' || event.payload.stage !== 'module-context') continue
    if (query.runId && event.runId !== query.runId) continue
    if (event.payload.sessionId !== sessionId) continue
    if (!mode(event.payload.policyMode) || !Number.isSafeInteger(event.payload.policyRevision)) continue
    if (query.moduleCommandId && event.payload.moduleCommandId !== query.moduleCommandId) continue
    if (contexts.size >= MAX_RUNS && !contexts.has(event.runId)) continue
    contexts.set(event.runId, event)
  }
  return [...contexts.values()].map(context => {
    /** 所有输出字段重新构造；不把 payload 原样穿过 IPC。 */
    const payload = context.payload
    const rawModules = Array.isArray(payload.modules) ? payload.modules : []
    const modules: AgentModuleAuditContribution[] = rawModules.slice(0, MAX_ITEMS).flatMap(value => {
      const item = record(value)
      const moduleId = identifier(item.moduleId)
      const moduleVersion = identifier(item.moduleVersion)
      const policyMode = mode(item.mode)
      if (!moduleId || !moduleVersion || !policyMode || item.sessionId !== sessionId) return []
      return [{
        moduleId, moduleVersion, mode: policyMode,
        ...(identifier(item.displayName) ? { displayName: identifier(item.displayName) } : {}),
        ...(item.invocationMode === 'invoke' || item.invocationMode === 'pinned' || item.invocationMode === 'available' ? { invocationMode: item.invocationMode } : {}),
        skillRefs: refs(item.skillRefs), promptRefs: refs(item.promptRefs), declaredCapabilities: refs(item.declaredCapabilities),
        activatedAt: context.createdAt, sessionId, policyRevision: Number.isSafeInteger(payload.policyRevision) ? payload.policyRevision as number : 0,
      }]
    })
    const audit: AgentModuleRunAudit = {
      sessionId, runId: context.runId,
      ...(identifier(payload.moduleCommandId) ? { moduleCommandId: identifier(payload.moduleCommandId) } : {}),
      policyMode: mode(payload.policyMode) ?? 'auto',
      policyRevision: Number.isSafeInteger(payload.policyRevision) ? payload.policyRevision as number : 0,
      startedAt: context.createdAt, modules,
      unavailable: (Array.isArray(payload.unavailable) ? payload.unavailable : []).slice(0, MAX_ITEMS).flatMap(value => {
        const item = record(value)
        const moduleId = identifier(item.moduleId)
        const reason = identifier(item.reason)
        return moduleId && reason ? [{ moduleId, reason }] : []
      }),
      activatedSkills: [], tools: [], status: 'running',
      truncated: rawModules.length > MAX_ITEMS
        || (Array.isArray(payload.unavailable) && payload.unavailable.length > MAX_ITEMS)
        || rawModules.slice(0, MAX_ITEMS).some(value => {
          const item = record(value)
          return [item.skillRefs, item.promptRefs, item.declaredCapabilities].some(list => Array.isArray(list) && list.length > MAX_ITEMS)
        }),
    }
    /** 真实 start 事件 ID 和调用 ID 双重匹配，不能用同名工具或最近消息配对。 */
    const toolStarts = new Map<string, number>()
    const skillKeys = new Set<string>()
    for (const event of events) {
      if (event.runId !== context.runId) continue
      if (event.eventType === 'tool_started') {
        const toolUseId = identifier(event.payload.toolUseId)
        const toolName = identifier(event.payload.toolName)
        if (!toolUseId || !toolName) continue
        if (audit.tools.length >= MAX_TOOLS) { audit.truncated = true; continue }
        toolStarts.set(event.eventId, audit.tools.length)
        audit.tools.push({ toolUseId, toolName, status: 'started' })
      } else if (event.eventType === 'tool_result' && event.parentEventId) {
        const toolIndex = toolStarts.get(event.parentEventId)
        const tool = toolIndex === undefined ? undefined : audit.tools[toolIndex]
        if (tool && tool.toolUseId === event.payload.toolUseId) tool.status = event.payload.isError === true ? 'failed' : 'completed'
      } else if (event.eventType === 'checkpoint' && event.payload.stage === 'module-skill-activated') {
        if (Array.isArray(event.payload.skills) && event.payload.skills.length > MAX_ITEMS) audit.truncated = true
        for (const value of Array.isArray(event.payload.skills) ? event.payload.skills.slice(0, MAX_ITEMS) : []) {
          const item = record(value)
          const provider = modules.find(module => module.moduleId === item.moduleId && module.moduleVersion === item.moduleVersion && module.skillRefs.includes(String(item.slug)))
          if (!provider || (item.activationMode !== 'available' && item.activationMode !== 'pinned' && item.activationMode !== 'invoke')) continue
          const slug = identifier(item.slug)
          const key = JSON.stringify([item.moduleId, item.moduleVersion, slug])
          if (!slug || skillKeys.has(key)) continue
          if (audit.activatedSkills.length >= MAX_ITEMS) { audit.truncated = true; continue }
          skillKeys.add(key)
          audit.activatedSkills.push({ slug, moduleId: provider.moduleId, moduleVersion: provider.moduleVersion, activationMode: item.activationMode })
        }
      } else if (event.eventType === 'run_completed') audit.status = 'completed'
      else if (event.eventType === 'run_failed') audit.status = 'failed'
      else if (event.eventType === 'run_stopped') audit.status = 'stopped'
    }
    return audit
  }).sort((a, b) => b.startedAt - a.startedAt)
}
