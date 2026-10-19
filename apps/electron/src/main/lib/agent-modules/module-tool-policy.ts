import type { AgentToolMode } from '@dutydeck/shared'
import type { PermissionResult } from '../agent-permission-service'

/** 宿主拥有的专业工具命名空间；插件 manifest 的 toolRefs 不能扩充此授权表。 */
const PROFESSIONAL_TOOL_MODULES: Readonly<Record<string, readonly string[]>> = {
  prototype_: ['interaction-design'],
  visual_: ['visual-production'],
  canvas_: ['canvas'],
  media_: ['canvas', 'visual-production'],
  server_: ['server-ops'],
  ops_: ['server-ops'],
  api_: ['api-workbench'],
  factory_: ['capability-factory'],
}

/** 单轮模块准入只接受已解析模块与宿主实际提供的扩展工具，不读取会话固定策略。 */
export interface AgentModuleToolPolicyInput {
  /** 本轮成功解析的显式模块 ID。 */
  activeModuleIds: readonly string[]
  /** 已经通过顶层会话来源检查的受限运行模式。 */
  toolMode: AgentToolMode
  /** 宿主内部扩展实际注册的精确工具名，仍须经过原有运行白名单与权限检查。 */
  trustedToolNames?: readonly string[]
}

/**
 * 创建单轮专业能力门禁，基础工具保持原来的自动调用和审批规则。
 * @param input 已核验的模块选择、工具模式和宿主扩展。
 * @returns 模块装配判断及工具执行拒绝结果；undefined 表示继续既有权限校验。
 */
export function createAgentModuleToolPolicy(input: AgentModuleToolPolicyInput) {
  /** 冻结本轮选择，后续 UI 或会话策略变更不能扩权。 */
  const activeIds = new Set(input.activeModuleIds)
  /** 内部任务仅继承宿主提供的具体工具，不能因一个工具而开启整个模块。 */
  const trustedTools = new Set(input.trustedToolNames ?? [])
  /** 运维专用会话已有独立显式授权，不要求重复选择。 */
  const hasModule = (moduleId: string): boolean => activeIds.has(moduleId)
    || (moduleId === 'server-ops' && input.toolMode !== 'standard')
  /** 专业门禁先于参数解析与副作用执行，不能由 bypassPermissions 绕过。 */
  const denyTool = (toolName: string): PermissionResult | undefined => {
    if (trustedTools.has(toolName)) return undefined
    /** 只匹配宿主约定的前缀；MCP 工具和基础终端不属于专业模块。 */
    const moduleIds = Object.entries(PROFESSIONAL_TOOL_MODULES).find(([prefix]) => toolName.startsWith(prefix))?.[1]
    if (!moduleIds || moduleIds.some(hasModule)) return undefined
    return { behavior: 'deny', message: `请先在当前消息中选择对应专业模块，再使用工具：${toolName}` }
  }
  return { hasModule, denyTool }
}
