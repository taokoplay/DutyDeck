import type { AgentModuleCommand, AgentModuleCommandInput } from '@dutydeck/shared'
import type { AgentModuleCommandBus } from './module-command-bus'

/** 宿主注入真实 deferred queue；协调器不另建运行时。 */
export interface AgentModuleCommandDispatcherDependencies {
  /** 持久化命令事实源。 */
  bus: AgentModuleCommandBus
  /** 精确撤销尚未派发的消息；false 表示未确认撤销，禁止伪造取消。 */
  cancelQueued: (sessionId: string, commandId: string) => boolean
}

/** 将 outbox 的创建事实与真实派发/取消衔接；未知历史状态不自动重放。 */
export class AgentModuleCommandDispatcher {
  constructor(private readonly dependencies: AgentModuleCommandDispatcherDependencies) {}

  /** 仅首次持久化成功才执行 callback；重复提交返回原回执，包括重启后的未知状态。 */
  async submit(input: AgentModuleCommandInput, dispatch: (command: AgentModuleCommand) => Promise<void>): Promise<AgentModuleCommand> {
    const { command, created } = this.dependencies.bus.submitOnce(input)
    if (!created || command.deliveryMode === 'draft') return command
    try {
      await dispatch(command)
    } catch {
      // 不保存供应商/运行时原始错误，防止凭据、路径或用户输入进入回执。
      const current = this.requireCommand(command.sessionId, command.commandId)
      if (current.status === 'queued' || current.status === 'running') {
        this.dependencies.bus.markFailed(command.commandId, 'AGENT_MODULE_COMMAND_DISPATCH_FAILED', command.sessionId)
      }
      throw new Error('AGENT_MODULE_COMMAND_DISPATCH_FAILED')
    }
    return this.requireCommand(command.sessionId, command.commandId)
  }

  /** 只有草稿或已被真实队列撤销的命令能标记取消；运行态必须由运行时停止回调确认。 */
  cancel(input: { sessionId: string; commandId: string }): AgentModuleCommand {
    const command = this.requireCommand(input.sessionId, input.commandId)
    if (command.status === 'canceled') return command
    if (command.status === 'draft') return this.dependencies.bus.cancel(command.commandId, command.sessionId)
    if (command.status !== 'queued' && command.status !== 'running') throw new Error('AGENT_MODULE_COMMAND_TERMINAL')
    if (command.status === 'running') throw new Error('AGENT_MODULE_COMMAND_CANCEL_UNCONFIRMED')
    try {
      if (!this.dependencies.cancelQueued(command.sessionId, command.commandId)) {
        throw new Error('AGENT_MODULE_COMMAND_CANCEL_UNCONFIRMED')
      }
    } catch {
      throw new Error('AGENT_MODULE_COMMAND_CANCEL_UNCONFIRMED')
    }
    /** 队列宿主可能同步回写取消终态，重读后避免二次推进。 */
    const current = this.requireCommand(command.sessionId, command.commandId)
    if (current.status === 'canceled') return current
    if (current.status !== 'queued') throw new Error('AGENT_MODULE_COMMAND_CANCEL_UNCONFIRMED')
    return this.dependencies.bus.cancel(command.commandId, command.sessionId)
  }

  /** 按 Session 查询命令，避免误取消同会话其他运行或跨会话命令。 */
  private requireCommand(sessionId: string, commandId: string): AgentModuleCommand {
    const command = this.dependencies.bus.list(sessionId).find((candidate) => candidate.commandId === commandId)
    if (!command) throw new Error('AGENT_MODULE_COMMAND_NOT_FOUND')
    return command
  }
}
