import type { AgentModuleActivation, AgentModuleMode } from './agent-modules'

/** 主进程解析的模块贡献快照；声明能力并不代表工具授权或执行事实。 */
export interface AgentModuleAuditContribution extends AgentModuleActivation {
  /** 模块清单中的用户可读名称；旧 Journal 缺失时由界面回退到 moduleId。 */
  displayName?: string
  declaredCapabilities: string[]
}

/** 仅包含成功加载的 Skill 来源，不携带本地路径或正文。 */
export interface AgentModuleAuditSkill {
  slug: string
  moduleId: string
  moduleVersion: string
  activationMode: 'available' | 'pinned' | 'invoke'
}

/** 一个实际 Pi 工具调用；不尝试推测它由哪个模块引发。 */
export interface AgentModuleAuditTool {
  toolUseId: string
  toolName: string
  status: 'started' | 'completed' | 'failed'
}

/** 受管 Journal 的有界安全投影，按 runId 精确关联。 */
export interface AgentModuleRunAudit {
  sessionId: string
  runId: string
  moduleCommandId?: string
  policyMode: AgentModuleMode
  policyRevision: number
  startedAt: number
  modules: AgentModuleAuditContribution[]
  unavailable: Array<{ moduleId: string; reason: string }>
  activatedSkills: AgentModuleAuditSkill[]
  tools: AgentModuleAuditTool[]
  status: 'running' | 'completed' | 'failed' | 'stopped'
  truncated: boolean
}

/** 查询只能限定当前 Session 的真实运行/命令，不能提交伪造审计内容。 */
export interface AgentModuleRunAuditQuery {
  sessionId: string
  runId?: string
  moduleCommandId?: string
}
