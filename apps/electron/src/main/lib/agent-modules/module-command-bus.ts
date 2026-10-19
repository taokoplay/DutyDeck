import type {
  AgentModuleCommand,
  AgentModuleCommandInput,
  AgentModuleCommandStatus,
  AgentModuleManifest,
  AgentSessionModulePolicy,
} from '@dutydeck/shared'
import { randomUUID } from 'node:crypto'
import { AgentModuleCommandStore } from './module-command-store'

export interface AgentModuleCommandBusDependencies {
  /** 查询当前宿主注册的模块。 */
  getModule: (moduleId: string) => AgentModuleManifest | undefined
  /** 查询 Session 当前策略；调用方负责保证 Session 可见性。 */
  getPolicy: (sessionId: string) => AgentSessionModulePolicy
  /** 校验模块动作所需权限；未提供时由上层 IPC 继续执行权限校验。 */
  hasPermission?: (sessionId: string, module: AgentModuleManifest, capabilityId: string) => boolean
  /** 注入时间，便于测试和恢复扫描使用稳定时间。 */
  now?: () => number
  /** 持久化 outbox；未提供时使用受管 Session 文件。 */
  store?: AgentModuleCommandStore
}

/**
 * 模块命令的宿主级 outbox；它只管理命令事实和状态，不创建第二个 Agent runtime。
 * 实际执行由 Agent service 在确认命令后调用 markRunning/markApplied/markFailed。
 */
export class AgentModuleCommandBus {
  private readonly dependencies: AgentModuleCommandBusDependencies
  private readonly store: AgentModuleCommandStore
  private readonly knownCommands = new Map<string, AgentModuleCommand>()

  constructor(dependencies: AgentModuleCommandBusDependencies) {
    this.dependencies = dependencies
    this.store = dependencies.store ?? new AgentModuleCommandStore()
  }

  /** 提交模块动作；重复幂等键返回第一次命令，不会再次产生副作用。 */
  submit(input: AgentModuleCommandInput): AgentModuleCommand {
    return this.submitOnce(input).command
  }

  /** 同步持久化派发资格；仅首次创建可执行，重启后旧 outbox 永不隐式重放。 */
  submitOnce(input: AgentModuleCommandInput): { command: AgentModuleCommand; created: boolean } {
    const existing = this.store.list(input.sessionId).find((command) => command.idempotencyKey === input.idempotencyKey.trim())
    if (existing) {
      this.remember(existing)
      return { command: cloneCommand(existing), created: false }
    }

    const module = this.dependencies.getModule(input.moduleId)
    if (!module) throw new Error('AGENT_MODULE_NOT_FOUND')
    const declaredCapabilities = new Set([...module.toolRefs, ...module.skillRefs, ...module.surfaceIds])
    if (!declaredCapabilities.has(input.capabilityId)) throw new Error('AGENT_MODULE_CAPABILITY_NOT_DECLARED')
    const policy = this.dependencies.getPolicy(input.sessionId)
    if (policy.disabledModuleIds.includes(input.moduleId)) throw new Error('AGENT_MODULE_DISABLED')
    if (input.baseRevision !== policy.revision) throw new Error('AGENT_MODULE_POLICY_REVISION_CONFLICT')
    if (!input.idempotencyKey.trim()) throw new Error('AGENT_MODULE_IDEMPOTENCY_KEY_REQUIRED')
    if (!input.requestSummary.trim()) throw new Error('AGENT_MODULE_REQUEST_SUMMARY_REQUIRED')
    if (this.dependencies.hasPermission && !this.dependencies.hasPermission(input.sessionId, module, input.capabilityId)) {
      throw new Error('AGENT_MODULE_PERMISSION_DENIED')
    }

    const now = this.dependencies.now?.() ?? Date.now()
    const command: AgentModuleCommand = {
      commandId: randomUUID(),
      sessionId: input.sessionId,
      moduleId: input.moduleId,
      capabilityId: input.capabilityId,
      baseRevision: input.baseRevision,
      invocationMode: input.invocationMode,
      deliveryMode: input.deliveryMode ?? 'enqueue',
      requestSummary: input.requestSummary.trim(),
      input: { ...input.input },
      idempotencyKey: input.idempotencyKey.trim(),
      status: input.deliveryMode === 'draft' ? 'draft' : 'queued',
      createdAt: now,
      updatedAt: now,
    }
    this.store.upsert(command)
    this.remember(command)
    return { command: cloneCommand(command), created: true }
  }

  /** 将排队命令标记为运行中；终态命令不可重新运行。 */
  markRunning(commandId: string, sessionId?: string): AgentModuleCommand {
    return this.transition(commandId, 'running', sessionId)
  }

  /** 记录模块动作成功，供 Agent service 完成实际调用后提交。 */
  markApplied(commandId: string, sessionId?: string): AgentModuleCommand {
    return this.transition(commandId, 'applied', sessionId)
  }

  /** 记录模块动作失败，并保留可审计错误码。 */
  markFailed(commandId: string, errorCode: string, sessionId?: string): AgentModuleCommand {
    const command = this.requireCommand(commandId, sessionId)
    if (isTerminal(command.status)) throw new Error('AGENT_MODULE_COMMAND_TERMINAL')
    /** 仅保留宿主稳定错误码，运行时原始错误可能包含凭据或用户输入。 */
    const safeErrorCode = /^AGENT_MODULE_[A-Z_]+$/.test(errorCode) ? errorCode : 'AGENT_MODULE_COMMAND_FAILED'
    const updated = { ...command, status: 'failed' as const, errorCode: safeErrorCode, updatedAt: this.dependencies.now?.() ?? Date.now() }
    this.store.upsert(updated)
    this.remember(updated)
    return { ...updated, input: { ...updated.input } }
  }

  /** 运行被用户停止时写入 canceled 终态，保留命令事实供审计。 */
  markCanceled(commandId: string, sessionId?: string): AgentModuleCommand {
    return this.transition(commandId, 'canceled', sessionId)
  }

  /** 取消 queued 或 running 之前的命令；已完成命令不会被伪造为取消。 */
  cancel(commandId: string, sessionId?: string): AgentModuleCommand {
    const command = this.requireCommand(commandId, sessionId)
    if (isTerminal(command.status)) throw new Error('AGENT_MODULE_COMMAND_TERMINAL')
    return this.transition(commandId, 'canceled')
  }

  /** 按 Session 读取命令投影，防止跨 Session 泄露命令输入。 */
  list(sessionId: string, status?: AgentModuleCommandStatus): AgentModuleCommand[] {
    return this.store.list(sessionId)
      .filter((command) => status === undefined || command.status === status)
      .sort((left, right) => left.createdAt - right.createdAt)
      .map((command) => { this.remember(command); return { ...command, input: { ...command.input } } })
  }

  /** 清理 Session 的非终态命令；终态回执保留用于审计和 UI 展示。 */
  clearPending(sessionId: string): void {
    this.store.replace(sessionId, this.store.list(sessionId).filter((command) => isTerminal(command.status)))
  }

  private requireCommand(commandId: string, sessionId?: string): AgentModuleCommand {
    const command = this.findCommand(commandId, sessionId)
    if (!command) throw new Error('AGENT_MODULE_COMMAND_NOT_FOUND')
    return { ...command, input: { ...command.input } }
  }

  private transition(commandId: string, status: AgentModuleCommandStatus, sessionId?: string): AgentModuleCommand {
    const command = this.requireCommand(commandId, sessionId)
    if (isTerminal(command.status)) throw new Error('AGENT_MODULE_COMMAND_TERMINAL')
    if (status === 'running' && command.status !== 'queued') throw new Error('AGENT_MODULE_COMMAND_INVALID_TRANSITION')
    if (status === 'applied' && command.status !== 'running') throw new Error('AGENT_MODULE_COMMAND_INVALID_TRANSITION')
    const updated = { ...command, status, updatedAt: this.dependencies.now?.() ?? Date.now() }
    this.store.upsert(updated)
    this.remember(updated)
    return { ...updated, input: { ...updated.input } }
  }

  private findCommand(commandId: string, sessionId?: string): AgentModuleCommand | undefined {
    if (sessionId) {
      const command = this.store.list(sessionId).find((item) => item.commandId === commandId)
      if (command) this.remember(command)
      return command
    }
    return this.knownCommands.get(commandId)
  }

  private remember(command: AgentModuleCommand): void {
    this.knownCommands.set(command.commandId, cloneCommand(command))
  }
}

function isTerminal(status: AgentModuleCommandStatus): boolean {
  return status === 'applied' || status === 'canceled' || status === 'expired' || status === 'failed'
}

function cloneCommand(command: AgentModuleCommand): AgentModuleCommand {
  return { ...command, input: { ...command.input } }
}
