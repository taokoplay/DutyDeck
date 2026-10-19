import { getRecoverySessionContext, requireRecoveryContextDigest, requireRecoveryUserMessageUuid } from './agent-recovery-context'
import { getReferencedMediaModelRefs } from './agent-media-model-selection'
import { ipcMain } from 'electron'
import { AGENT_IPC_CHANNELS, DUTYDECK_DEFAULT_PERMISSION_MODE } from '@dutydeck/shared'
import type { AgentRunRecoveryInput, AgentSessionMeta } from '@dutydeck/shared'
import { AgentRunRecoveryService } from './agent-run-recovery'
import type { AgentRunJournalStore } from './agent-run-journal'
import type { AgentPluginRegistry } from './agent-modules/plugin-registry'
import type { AgentModuleCommandBus } from './agent-modules/module-command-bus'
import { buildAgentModuleRunAudits } from './agent-modules/module-run-audit'
import { getAgentSessionModulePolicy } from './agent-modules/module-policy-store'
import { assertPiExactContinuation } from './adapters/pi-exact-continuation'
import { isAgentSessionBusy, reserveAgentSessionStart, runAgent } from './agent-service'

/** 真实运行恢复四层合同的主进程实现；对外只接收身份和 CAS，不接收路径/提示词。 */
export function registerAgentRunRecoveryIpc(input: {
  journal: AgentRunJournalStore
  registry: AgentPluginRegistry
  bus: AgentModuleCommandBus
  requireVisibleSession: (sessionId: string) => AgentSessionMeta
}): void {
  /** SDK 只在用户检查恢复时延迟加载，普通会话启动无额外初始化。 */
  let servicePromise: Promise<AgentRunRecoveryService> | undefined
  const getService = (): Promise<AgentRunRecoveryService> => {
    servicePromise ??= import('@earendil-works/pi-coding-agent').then(({ SessionManager }) => new AgentRunRecoveryService({
      journal: input.journal,
      isBusy: isAgentSessionBusy,
      getSession: input.requireVisibleSession,
      validateContinuation: (expected) => assertPiExactContinuation(SessionManager.open(expected.expectedSessionFile), expected),
      assertContextCurrent: (sessionId, events) => {
        const session = input.requireVisibleSession(sessionId)
        const preflight = events.find((event) => event.payload.stage === 'preflight-complete')
        const saved = preflight?.payload.runContext
        const current = getRecoverySessionContext(session)
        requireRecoveryContextDigest(events)
        requireRecoveryUserMessageUuid(events, input.journal.getPiBinding(sessionId, events[0]!.runId)?.entryBindings ?? {})
        const contextEvent = events.find((event) => event.payload.stage === 'module-context')
        const audit = buildAgentModuleRunAudits(sessionId, events)[0]
        const policy = getAgentSessionModulePolicy(sessionId)
        if (preflight?.payload.exactRecoveryEligible !== true || !saved || JSON.stringify(saved) !== JSON.stringify(current) || !contextEvent || contextEvent.payload.policyRevision !== policy.revision) {
          throw new Error('AGENT_RUN_RECOVERY_CONTEXT_CHANGED')
        }
        for (const contribution of audit?.modules ?? []) {
          const module = input.registry.getModule(contribution.moduleId)
          if (!module || module.version !== contribution.moduleVersion || JSON.stringify(module.skillRefs) !== JSON.stringify(contribution.skillRefs)
            || JSON.stringify(module.promptRefs) !== JSON.stringify(contribution.promptRefs) || JSON.stringify(module.toolRefs) !== JSON.stringify(contribution.declaredCapabilities)) {
            throw new Error('AGENT_RUN_RECOVERY_CONTEXT_CHANGED')
          }
        }
      },
      onAbandon: (sessionId, events) => {
        /** 只终结精确关联的非终态命令，不撤销其他队列。 */
        const commandIds = new Set(events.map((event) => event.commandId).filter((id): id is string => typeof id === 'string'))
        for (const audit of buildAgentModuleRunAudits(sessionId, events)) if (audit.moduleCommandId) commandIds.add(audit.moduleCommandId)
        for (const command of input.bus.list(sessionId)) {
          if (commandIds.has(command.commandId) && ['draft', 'queued', 'running'].includes(command.status)) input.bus.markCanceled(command.commandId, sessionId)
        }
      },
    }))
    return servicePromise
  }
  ipcMain.handle(AGENT_IPC_CHANNELS.GET_AGENT_RUN_RECOVERY_PLANS, async (_, sessionId: string) => {
    input.requireVisibleSession(sessionId)
    return (await getService()).list(sessionId)
  })
  ipcMain.handle(AGENT_IPC_CHANNELS.APPLY_AGENT_RUN_RECOVERY, async (event, request: AgentRunRecoveryInput) => {
    input.requireVisibleSession(request.sessionId)
    return (await getService()).apply(request, async (context) => {
      const session = input.requireVisibleSession(context.agentSessionId)
      if (!session.channelId) throw new Error('AGENT_RUN_RECOVERY_CHANNEL_REQUIRED')
      const release = reserveAgentSessionStart(session.id)
      try {
        const audit = buildAgentModuleRunAudits(session.id, context.events, { runId: context.runId })[0]
        const preflight = context.events.find((entry) => entry.payload.stage === 'preflight-complete')
        const moduleIds = Array.isArray(preflight?.payload.moduleIds) ? preflight.payload.moduleIds.filter((id): id is string => typeof id === 'string') : []
        await runAgent({
          sessionId: session.id, userMessage: '', rawUserMessage: '', channelId: session.channelId,
          modelId: session.modelId, workspaceId: session.workspaceId, triggeredBy: 'user',
          permissionModeOverride: session.permissionMode ?? DUTYDECK_DEFAULT_PERMISSION_MODE,
          moduleIds, moduleInvocationMode: moduleIds.length ? 'invoke' : undefined,
          /** 还原原运行显式选择，确保精确恢复装配同一媒体工具集合；旧记录不推断授权。 */
          mentionedMediaModelRefs: getReferencedMediaModelRefs(preflight?.payload.mentionedMediaModelRefs),
          modulePolicyRevision: audit?.policyRevision,
          ...(audit?.moduleCommandId ? { moduleCommandId: audit.moduleCommandId } : {}),
        }, event.sender, { exactRecoveryEligible: true, piResumeContinuation: { runId: context.runId, contextDigest: requireRecoveryContextDigest(context.events), userMessageUuid: requireRecoveryUserMessageUuid(context.events, input.journal.getPiBinding(session.id, context.runId)?.entryBindings ?? {}), expectedSessionFile: context.expectedSessionFile, sessionId: context.sessionId, branchTipId: context.branchTipId, artifactSha256: context.artifactSha256 } })
      } finally { release() }
    })
  })
}
