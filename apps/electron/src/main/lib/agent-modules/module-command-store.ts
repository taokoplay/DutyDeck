import { closeSync, existsSync, fstatSync, mkdirSync, openSync, readSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { AgentModuleCommand } from '@dutydeck/shared'
import { getAgentSessionMessagesPath } from '../config-paths'
import { writeJsonFileAtomic } from '../safe-file'

/** outbox 只读诊断，不包含命令文本或原始异常。 */
export interface AgentModuleCommandStoreDiagnostic {
  kind: 'module-command'
  status: 'quarantined'
  code: string
}

interface AgentModuleCommandSnapshot {
  version: 1
  commands: AgentModuleCommand[]
}

export interface AgentModuleCommandStoreOptions {
  /** 测试注入独立文件路径；生产路径绑定受管 Session 数据根。 */
  resolvePath?: (sessionId: string) => string
}

/**
 * 模块命令持久化 outbox。
 * 每个 Session 使用独立快照文件，命令状态更新通过安全原子写提交，避免跨会话泄露输入。
 */
export class AgentModuleCommandStore {
  private readonly options: AgentModuleCommandStoreOptions

  constructor(options: AgentModuleCommandStoreOptions = {}) {
    this.options = options
  }

  /** 读取一个 Session 的全部命令；缺失文件按空 outbox 处理。 */
  list(sessionId: string): AgentModuleCommand[] {
    const inspection = this.inspect(sessionId)
    if (!inspection.writable) throw new Error('AGENT_MODULE_COMMAND_STORE_REQUIRES_REVIEW')
    return inspection.commands
  }

  /** 只读诊断旧、损坏和未来快照；不回退旧备份，避免恢复已执行命令后重复派发。 */
  inspect(sessionId: string): { commands: AgentModuleCommand[]; diagnostics: AgentModuleCommandStoreDiagnostic[]; writable: boolean } {
    const path = this.resolvePath(sessionId)
    if (!existsSync(path)) return { commands: [], diagnostics: [], writable: true }
    const rejected = (code: string, diagnostics: AgentModuleCommandStoreDiagnostic[] = []) => ({
      commands: [], writable: false,
      diagnostics: [{ kind: 'module-command' as const, status: 'quarantined' as const, code }, ...diagnostics],
    })
    let descriptor: number | undefined
    try {
      descriptor = openSync(path, 'r')
      const size = fstatSync(descriptor).size
      if (size > 4 * 1024 * 1024) return rejected('AGENT_MODULE_COMMAND_SNAPSHOT_TOO_LARGE')
      const buffer = Buffer.alloc(size + 1)
      const bytes = readSync(descriptor, buffer, 0, buffer.length, 0)
      if (bytes > size) return rejected('AGENT_MODULE_COMMAND_SNAPSHOT_CHANGED')
      const raw: unknown = JSON.parse(buffer.subarray(0, bytes).toString('utf8'))
      if (isSnapshot(raw)) {
        const identities = new Set(raw.commands.map((command) => command.commandId))
        const keys = new Set(raw.commands.map((command) => command.idempotencyKey))
        if (raw.commands.some((command) => command.sessionId !== sessionId || !command.idempotencyKey.trim())
          || identities.size !== raw.commands.length || keys.size !== raw.commands.length) {
          return rejected('AGENT_MODULE_COMMAND_SNAPSHOT_IDENTITY_INVALID')
        }
        return { commands: raw.commands.map(cloneCommand), diagnostics: [], writable: true }
      }
      return rejected('AGENT_MODULE_COMMAND_SNAPSHOT_UNSUPPORTED')
    } catch {
      return rejected('AGENT_MODULE_COMMAND_SNAPSHOT_INVALID')
    } finally {
      if (descriptor !== undefined) closeSync(descriptor)
    }
  }

  /** 写入一个 Session 的完整命令快照。 */
  replace(sessionId: string, commands: readonly AgentModuleCommand[]): void {
    if (!this.inspect(sessionId).writable) throw new Error('AGENT_MODULE_COMMAND_STORE_REQUIRES_REVIEW')
    const path = this.resolvePath(sessionId)
    mkdirSync(dirname(path), { recursive: true })
    writeJsonFileAtomic(path, {
      version: 1,
      commands: commands.map(cloneCommand),
    })
  }

  /** 插入或更新一个命令，commandId 在同一 Session 内必须唯一。 */
  upsert(command: AgentModuleCommand): AgentModuleCommand {
    const current = this.list(command.sessionId)
    const index = current.findIndex((item) => item.commandId === command.commandId)
    if (index === -1) current.push(cloneCommand(command))
    else current[index] = cloneCommand(command)
    this.replace(command.sessionId, current)
    return cloneCommand(command)
  }

  /** 测试及诊断用的路径投影，避免调用方依赖实际 data root。 */
  pathFor(sessionId: string): string {
    return this.resolvePath(sessionId)
  }

  private resolvePath(sessionId: string): string {
    return this.options.resolvePath?.(sessionId)
      ?? join(dirname(getAgentSessionMessagesPath(sessionId)), `${sessionId}.module-commands.json`)
  }
}

function isSnapshot(value: unknown): value is AgentModuleCommandSnapshot {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const record = value as Record<string, unknown>
  return record.version === 1 && Array.isArray(record.commands) && record.commands.every(isCommand)
}

function isCommand(value: unknown): value is AgentModuleCommand {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const record = value as Record<string, unknown>
  return typeof record.commandId === 'string'
    && typeof record.sessionId === 'string'
    && typeof record.moduleId === 'string'
    && typeof record.capabilityId === 'string'
    && typeof record.baseRevision === 'number'
    && (record.invocationMode === 'available' || record.invocationMode === 'pinned' || record.invocationMode === 'invoke')
    && (record.deliveryMode === 'draft' || record.deliveryMode === 'enqueue' || record.deliveryMode === 'auto')
    && typeof record.requestSummary === 'string'
    && isRecord(record.input)
    && typeof record.idempotencyKey === 'string'
    && (record.status === 'draft' || record.status === 'queued' || record.status === 'running' || record.status === 'applied' || record.status === 'canceled' || record.status === 'expired' || record.status === 'failed')
    && typeof record.createdAt === 'number'
    && typeof record.updatedAt === 'number'
    && (record.errorCode === undefined || typeof record.errorCode === 'string')
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value))
}

function cloneCommand(command: AgentModuleCommand): AgentModuleCommand {
  return { ...command, input: { ...command.input } }
}
