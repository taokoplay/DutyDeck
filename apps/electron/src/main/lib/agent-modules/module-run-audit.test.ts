import { describe, expect, test } from 'bun:test'
import type { AgentModuleAuditContribution, AgentRunJournalEvent, SkillActivation } from '@dutydeck/shared'
import { mergeSkillActivations } from '@dutydeck/shared'
import { buildAgentModuleRunAudits, tagModuleSkillActivations } from './module-run-audit'

/** 测试模块快照，声明能力故意不同于 Pi 工具名。 */
const module: AgentModuleAuditContribution = {
  moduleId: 'canvas', moduleVersion: '1.2.3', mode: 'pinned', skillRefs: ['canvas-production'],
  promptRefs: ['canvas.system.v1'], declaredCapabilities: ['canvas.document'], sessionId: 'session', policyRevision: 4, activatedAt: 1,
}
/** 创建固定身份的 Journal 测试事件。 */
function event(eventType: AgentRunJournalEvent['eventType'], payload: Record<string, unknown>, extra: Partial<AgentRunJournalEvent> = {}): AgentRunJournalEvent {
  return { runId: 'run-1', branchId: 'branch', sequence: 1, eventId: 'event-1', eventType, payload, createdAt: 1, ...extra }
}
/** 主进程解析快照，夹带未知敏感字段用来验证白名单投影。 */
function context(extra: Record<string, unknown> = {}, runId = 'run-1'): AgentRunJournalEvent {
  return event('checkpoint', { stage: 'module-context', sessionId: 'session', policyMode: 'pinned', policyRevision: 4,
    modules: [module], unavailable: [], secretPrompt: 'SECRET_PROMPT', ...extra }, { runId })
}

describe('模块运行审计', () => {
  test('Given 包资源上下文 When 读取审计 Then 保留版本摘要而不冒充 Pi Skill 加载或泄露正文', () => {
    /** 保留资源种类字面量，与生产审计合同一致。 */
    const resource = { id: 'acme.notes/skills/assist', kind: 'skill' as const, version: '1.0.0', byteLength: 128 }
    const contribution = { ...module, pluginId: 'acme.notes', packageHash: 'a'.repeat(64), skillRefs: [resource.id],
      packageResources: [{ ...resource, content: 'SECRET_BODY', path: '/SECRET/path' }, { ...resource, id: 'another/private' }],
    }
    const audit = buildAgentModuleRunAudits('session', [context({ modules: [contribution] })])[0]!
    expect(audit.modules[0]?.packageHash).toBe('a'.repeat(64))
    expect(audit.modules[0]?.packageResources).toEqual([resource])
    expect(audit.activatedSkills).toEqual([])
    expect(JSON.stringify(audit)).not.toContain('SECRET')
    expect(JSON.stringify(audit)).not.toContain('another/private')
  })
  test('Given 主进程快照与工具事件 When 投影 Then 按运行和 parentEventId 绑定且不泄露参数', () => {
    const audits = buildAgentModuleRunAudits('session', [context({ moduleCommandId: 'command-1' }),
      event('tool_started', { toolUseId: 'call-1', toolName: 'read', input: { secret: 'SECRET_ARGS' } }, { eventId: 'start-1' }),
      event('tool_result', { toolUseId: 'call-1', isError: false }, { parentEventId: 'wrong' }),
      event('tool_result', { toolUseId: 'call-2', isError: false }, { parentEventId: 'start-1' }),
      event('run_completed', {}),
    ])
    expect(audits[0]?.tools).toEqual([{ toolUseId: 'call-1', toolName: 'read', status: 'started' }])
    expect(audits[0]?.modules[0]?.declaredCapabilities).toEqual(['canvas.document'])
    expect(audits[0]?.status).toBe('completed')
    expect(JSON.stringify(audits)).not.toContain('SECRET')
    expect(buildAgentModuleRunAudits('session', [context(), event('tool_started', { toolUseId: 'call-1', toolName: 'read' }, { eventId: 'start-1' }),
      event('tool_result', { toolUseId: 'call-1', isError: true }, { parentEventId: 'start-1' })])[0]?.tools[0]?.status).toBe('failed')
  })

  test('Given 多运行和其他会话 When 查询 Then 不从最近消息或工具名称推断关联', () => {
    const events = [context({ moduleCommandId: 'command-1' }), context({ moduleCommandId: 'command-2' }, 'run-2'),
      context({ sessionId: 'other' }, 'run-3')]
    expect(buildAgentModuleRunAudits('session', events, { moduleCommandId: 'command-1' }).map(audit => audit.runId)).toEqual(['run-1'])
    expect(buildAgentModuleRunAudits('session', events, { runId: 'run-2' }).map(audit => audit.runId)).toEqual(['run-2'])
    expect(buildAgentModuleRunAudits('session', events, { runId: 'missing' })).toEqual([])
  })

  test('Given 缺失或禁用模块 When 解析失败 Then 保留失败闭合的原因快照', () => {
    const audit = buildAgentModuleRunAudits('session', [context({ modules: [], unavailable: [{ moduleId: 'canvas', reason: 'AGENT_MODULE_DISABLED' }] }), event('run_failed', {})])[0]!
    expect(audit.modules).toEqual([])
    expect(audit.unavailable).toEqual([{ moduleId: 'canvas', reason: 'AGENT_MODULE_DISABLED' }])
    expect(audit.status).toBe('failed')
  })

  test('Given 旧 Journal 或未知 payload When 投影 Then 不猜测缺失模块来源', () => {
    expect(buildAgentModuleRunAudits('session', [event('tool_started', { toolName: 'read' })])).toEqual([])
    expect(buildAgentModuleRunAudits('session', [context({ modules: [null, { moduleId: 'forged' }] })])[0]?.modules).toEqual([])
  })

  test('Given 模块名称快照 When 投影新旧 Journal Then 保留历史名称且不传播无效字段', () => {
    /** 名称只允许有界文本，其他 manifest 字段不穿过审计 IPC。 */
    const namedModule = { ...module, displayName: '画布工作台', localPath: '/SECRET/path' }
    const namedAudit = buildAgentModuleRunAudits('session', [context({ modules: [namedModule] })])[0]!
    expect(namedAudit.modules[0]?.displayName).toBe('画布工作台')
    expect(JSON.stringify(namedAudit)).not.toContain('SECRET')
    expect(buildAgentModuleRunAudits('session', [context()])[0]?.modules[0]?.displayName).toBeUndefined()
    for (const displayName of [null, 42, '', 'x'.repeat(257)]) {
      expect(buildAgentModuleRunAudits('session', [context({ modules: [{ ...module, displayName }] })])[0]?.modules[0]?.displayName).toBeUndefined()
    }
  })

  test('Given 超量历史与工具 When 读取 Then 返回固定预算并标记截断', () => {
    const contexts = Array.from({ length: 30 }, (_, index) => context({}, `run-${index}`))
    expect(buildAgentModuleRunAudits('session', contexts)).toHaveLength(20)
    const tools = Array.from({ length: 200 }, (_, index) => event('tool_started', { toolUseId: `call-${index}`, toolName: 'read' }, { eventId: `start-${index}` }))
    const audit = buildAgentModuleRunAudits('session', [context(), ...tools])[0]!
    expect(audit.tools).toHaveLength(128)
    expect(audit.truncated).toBe(true)
  })

  test('Given 同一受管 Skill 由多个模块提供 When 激活和归并 Then 版本与模式不丢失', () => {
    const activation: SkillActivation = { slug: 'canvas-production', name: 'Canvas', workspaceSlug: 'workspace', workspaceSkillPath: 'canvas-production/SKILL.md', sources: ['explicit'] }
    const tagged = tagModuleSkillActivations([activation], [module, { ...module, moduleId: 'second', moduleVersion: '2.0.0', invocationMode: 'invoke' }])
    const merged = mergeSkillActivations(tagged, tagged)
    expect(merged).toHaveLength(2)
    expect(merged[0]).toMatchObject({ moduleId: 'canvas', moduleVersion: '1.2.3', activationMode: 'pinned' })
    expect(merged[1]).toMatchObject({ moduleId: 'second', moduleVersion: '2.0.0', activationMode: 'invoke' })
    expect(tagModuleSkillActivations([{ ...activation, workspaceSlug: undefined, moduleId: 'fake', moduleVersion: '9.0.0', activationMode: 'invoke' }], [module])[0]?.moduleId).toBeUndefined()
  })

  test('Given 激活记录与模块版本不匹配 When 投影 Then 不冒认成功加载', () => {
    const audit = buildAgentModuleRunAudits('session', [context(), event('checkpoint', { stage: 'module-skill-activated', skills: [
      { slug: 'canvas-production', moduleId: 'canvas', moduleVersion: '0.0.1', activationMode: 'pinned' },
      { slug: 'canvas-production', moduleId: 'canvas', moduleVersion: '1.2.3', activationMode: 'pinned' },
    ] })])[0]!
    expect(audit.activatedSkills).toEqual([{ slug: 'canvas-production', moduleId: 'canvas', moduleVersion: '1.2.3', activationMode: 'pinned' }])
  })
})
