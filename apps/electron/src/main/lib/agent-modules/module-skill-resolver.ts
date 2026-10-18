import type {
  AgentModuleActivation,
  AgentModuleInvocationMode,
  AgentModuleManifest,
  AgentSessionModulePolicy,
  SkillMeta,
} from '@dutydeck/shared'
import { getWorkspaceSkills } from '../agent-workspace-manager'
import { getBuiltinAgentModule, listBuiltinAgentModules } from './module-registry'

export interface ResolvedAgentModuleContext {
  modules: AgentModuleActivation[]
  skillMentions: string[]
  promptFragments: string[]
  allowedToolNames: string[]
  unavailable: Array<{ moduleId: string; reason: string }>
}

export interface ResolveActiveModuleContextInput {
  workspaceSlug: string
  sessionId: string
  policy: AgentSessionModulePolicy
  explicitModuleIds?: string[]
  invocationMode?: AgentModuleInvocationMode
  now?: number
}

export interface ResolveActiveModuleContextDependencies {
  listModules: () => readonly AgentModuleManifest[]
  getSkills: (workspaceSlug: string) => readonly SkillMeta[]
}

const MODULE_PROMPTS: Readonly<Record<string, string>> = {
  canvas: '当前模块是画布。只有用户明确需要持续复用的画布产物、节点关系或画布编排时才使用画布工具；普通文本和一次性代码任务不要强行转入画布。',
  'visual-production': '当前模块是影像。执行媒体任务前先发现真实可用模型和配置，固定任务归属与来源，不使用过期模型名或猜测服务能力。',
  'interaction-design': '当前模块是交互设计。先读取已有原型模块和目标页面边界，再按项目身份提交候选，不把整套页面藏在单个 HTML 中。',
  browser: '当前模块是浏览器。匹配的专用 API/MCP 优先；只有当前任务需要网页界面或没有更结构化能力时才使用受管浏览器。',
  terminal: '当前模块是终端。命令必须限制在当前项目和已授权目录内；涉及写入、外部服务或高风险命令时先获取权限。',
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values)]
}

function resolveSelectedModuleIds(input: ResolveActiveModuleContextInput): string[] {
  if (input.explicitModuleIds && input.explicitModuleIds.length > 0) return unique(input.explicitModuleIds)
  if (input.policy.mode === 'auto') return []
  if (input.policy.mode === 'pinned') return unique(input.policy.pinnedModuleIds)
  return unique(input.policy.enabledModuleIds)
}

function getSkillStatus(skills: readonly SkillMeta[]): Map<string, SkillMeta> {
  return new Map(skills.filter((skill) => skill.enabled).map((skill) => [skill.slug, skill]))
}

function getModulePrompt(module: AgentModuleManifest): string | undefined {
  return MODULE_PROMPTS[module.id]
}

/**
 * 按 Session 模块策略解析 Agent 本轮可用的 Skill、提示词和工具。
 * @param input 当前工作区、Session、模块策略和显式模块调用。
 * @param dependencies 可替换的注册表与 Skill 读取依赖，便于测试和未来第三方插件。
 * @returns 模块激活记录、可调用 Skill、提示摘要、工具和不可用原因。
 */
export function resolveActiveModuleContext(
  input: ResolveActiveModuleContextInput,
  dependencies: ResolveActiveModuleContextDependencies = {
    listModules: listBuiltinAgentModules,
    getSkills: getWorkspaceSkills,
  },
): ResolvedAgentModuleContext {
  const now = input.now ?? Date.now()
  const disabled = new Set(input.policy.disabledModuleIds)
  const moduleMap = new Map(dependencies.listModules().map((module) => [module.id, module]))
  const selectedIds = resolveSelectedModuleIds(input).filter((moduleId) => !disabled.has(moduleId))
  const skills = getSkillStatus(dependencies.getSkills(input.workspaceSlug))
  const modules: AgentModuleActivation[] = []
  const skillMentions: string[] = []
  const promptFragments: string[] = []
  const allowedToolNames: string[] = []
  const unavailable: Array<{ moduleId: string; reason: string }> = []

  for (const moduleId of selectedIds) {
    const module = moduleMap.get(moduleId) ?? getBuiltinAgentModule(moduleId)
    if (!module) {
      unavailable.push({ moduleId, reason: 'AGENT_MODULE_NOT_FOUND' })
      continue
    }
    const missingSkills = module.skillRefs.filter((skillRef) => !skills.has(skillRef))
    if (missingSkills.length > 0) {
      unavailable.push({ moduleId, reason: `AGENT_MODULE_SKILL_UNAVAILABLE:${missingSkills.join(',')}` })
      continue
    }
    const mode = input.policy.mode === 'pinned' || input.policy.pinnedModuleIds.includes(moduleId) ? 'pinned' : input.policy.mode
    modules.push({
      moduleId: module.id,
      moduleVersion: module.version,
      mode,
      ...(input.invocationMode ? { invocationMode: input.invocationMode } : {}),
      skillRefs: [...module.skillRefs],
      promptRefs: [...module.promptRefs],
      activatedAt: now,
      sessionId: input.sessionId,
      policyRevision: input.policy.revision,
    })
    skillMentions.push(...module.skillRefs)
    const prompt = getModulePrompt(module)
    if (prompt) promptFragments.push(prompt)
    allowedToolNames.push(...module.toolRefs)
  }

  return {
    modules,
    skillMentions: unique(skillMentions),
    promptFragments: unique(promptFragments),
    allowedToolNames: unique(allowedToolNames),
    unavailable,
  }
}
