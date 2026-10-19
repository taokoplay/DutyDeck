import type {
  AgentModuleAuditContribution,
  AgentModuleInvocationMode,
  AgentModuleManifest,
  AgentSessionModulePolicy,
  SkillMeta,
} from '@dutydeck/shared'
import { getWorkspaceSkills } from '../agent-workspace-manager'
import { BUILTIN_AGENT_MODULE_PROMPTS, isAutomaticAgentModuleId } from '@dutydeck/shared'
import { listBuiltinAgentModules } from './module-registry'
import { RESOURCE_LIMITS } from '@dutydeck/plugin-sdk'
import type { ResolvedContentModule } from '../agent-plugins/content-plugin-service'

export interface ResolvedAgentModuleContext {
  modules: AgentModuleAuditContribution[]
  skillMentions: string[]
  promptFragments: string[]
  /** 兼容输出保留为空；manifest capability ID 不可用作 Pi 工具权限。 */
  allowedToolNames: string[]
  unavailable: Array<{ moduleId: string; reason: string }>
}

export interface ResolveActiveModuleContextInput {
  workspaceSlug?: string
  /** 运行期权限快照；受限或禁用 Skills 的运行不得通过模块扩权。 */
  skillsEnabled?: boolean
  sessionId: string
  policy: AgentSessionModulePolicy
  explicitModuleIds?: string[]
  invocationMode?: AgentModuleInvocationMode
  now?: number
}

export interface ResolveActiveModuleContextDependencies {
  listModules: () => readonly AgentModuleManifest[]
  getSkills: (workspaceSlug: string) => readonly SkillMeta[]
  /** 仅已选包模块进入此有界解析，不经过工作区 Skill 目录。 */
  resolvePackageModules: (moduleIds: readonly string[]) => readonly ResolvedContentModule[]
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values)]
}

/** 运行时只接受当前消息显式选择的模块；Session 策略不再自动扩展模型上下文。 */
function resolveSelectedModuleIds(input: ResolveActiveModuleContextInput): string[] {
  return unique(input.explicitModuleIds ?? []).filter((moduleId) => !isAutomaticAgentModuleId(moduleId))
}

function getSkillStatus(skills: readonly SkillMeta[]): Map<string, SkillMeta> {
  return new Map(skills.filter((skill) => skill.enabled).map((skill) => [skill.slug, skill]))
}

/** 主进程初始化后的目录快照；解析每轮不扫描插件磁盘目录。 */
let runtimeCatalog: readonly AgentModuleManifest[] | undefined
/** 只有已接纳插件的有界纯文本可进入提示快照。 */
let runtimePrompts: Readonly<Record<string, string>> = {}
/** 宿主注入的包读取入口，测试可明确移除。 */
let packageModuleResolver: ResolveActiveModuleContextDependencies['resolvePackageModules'] | undefined

/** 注入生产安装服务的读取能力，不向模型暴露文件系统根或管理权限。 */
export function setPackageModuleResolver(resolver: ResolveActiveModuleContextDependencies['resolvePackageModules'] | undefined): void {
  packageModuleResolver = resolver
}

/** 安装目录加载后注入副本；null 恢复内置目录，便于独立测试隔离。 */
export function setAgentModuleRuntimeCatalog(modules: readonly AgentModuleManifest[] | null, prompts: Readonly<Record<string, string>> = {}): void {
  runtimeCatalog = modules === null ? undefined : structuredClone(modules)
  runtimePrompts = modules === null ? {} : { ...prompts }
}

/** 内置提示优先，插件内容不能覆盖宿主提示；未知 ID 不作为文件路径读取。 */
function resolveModulePrompt(ref: string): string | undefined {
  if (Object.hasOwn(BUILTIN_AGENT_MODULE_PROMPTS, ref)) return BUILTIN_AGENT_MODULE_PROMPTS[ref]
  return Object.hasOwn(runtimePrompts, ref) ? runtimePrompts[ref] : undefined
}

/** 返回宿主已加载快照；没有宿主初始化时使用内置模块。 */
function listRuntimeModules(): readonly AgentModuleManifest[] {
  return runtimeCatalog ?? listBuiltinAgentModules()
}

/**
 * 返回本轮不得自动发现的专业 Skill；共享 Skill 只要由已选模块提供即可保留。
 * @param activeModuleIds 本轮解析成功的模块集合。
 * @param catalog 宿主目录快照，测试可注入；不扫描插件磁盘。
 * @param explicitSkillSlugs 内部任务由宿主核验的显式 Skill 配置，不能从普通消息转交。
 * @returns 应从 Pi 资源目录及显式 Skill 展开中排除的 slug。
 */
export function getInactiveModuleSkillSlugs(
  activeModuleIds: readonly string[],
  catalog: readonly AgentModuleManifest[] = listRuntimeModules(),
  explicitSkillSlugs: readonly string[] = [],
): string[] {
  /** 基础能力及本轮已选模块共享的 Skill 不受专业模块门禁影响。 */
  const activeIds = new Set(activeModuleIds)
  const allowedSkills = new Set([...explicitSkillSlugs, ...catalog.filter((module) => isAutomaticAgentModuleId(module.id) || activeIds.has(module.id))
    .flatMap((module) => module.skillRefs)])
  return unique(catalog.filter((module) => !isAutomaticAgentModuleId(module.id) && !activeIds.has(module.id))
    .flatMap((module) => module.skillRefs)).filter((slug) => !allowedSkills.has(slug))
}

/**
 * 按当前消息显式选择解析 Agent 本轮可用的 Skill、提示词和工具。
 * @param input 当前工作区、Session、模块策略和显式模块调用。
 * @param dependencies 可替换的注册表与 Skill 读取依赖，便于测试和未来第三方插件。
 * @returns 模块激活记录、可调用 Skill、提示摘要、工具和不可用原因。
 */
export function resolveActiveModuleContext(
  input: ResolveActiveModuleContextInput,
  dependencies: Partial<ResolveActiveModuleContextDependencies> = {},
): ResolvedAgentModuleContext {
  const now = input.now ?? Date.now()
  const disabled = new Set(input.policy.disabledModuleIds)
  const selectedIds = resolveSelectedModuleIds(input)
  // 未显式选择模块时直接返回，避免每轮读取 Skills 目录和构建模块提示。
  if (selectedIds.length === 0) {
    return { modules: [], skillMentions: [], promptFragments: [], allowedToolNames: [], unavailable: [] }
  }
  const moduleMap = new Map((dependencies.listModules ?? listRuntimeModules)().map((module) => [module.id, module]))
  /** 仅真正需要 Skills 且运行允许时读取受管目录。 */
  const needsSkills = selectedIds.some((id) => !disabled.has(id) && moduleMap.get(id)?.resourceSource !== 'package' && (moduleMap.get(id)?.skillRefs.length ?? 0) > 0)
  const skills = getSkillStatus(input.workspaceSlug && input.skillsEnabled !== false && needsSkills
    ? (dependencies.getSkills ?? getWorkspaceSkills)(input.workspaceSlug) : [])
  const modules: AgentModuleAuditContribution[] = []
  const skillMentions: string[] = []
  const promptFragments: string[] = []
  const unavailable: Array<{ moduleId: string; reason: string }> = []
  /** 同一轮一次批量解析，宿主按不可变包身份去重读取。 */
  const packageIds = selectedIds.filter(id => !disabled.has(id) && input.skillsEnabled !== false && moduleMap.get(id)?.resourceSource === 'package')
  let packageModules: readonly ResolvedContentModule[] = []
  if (packageIds.length) {
    try { packageModules = (dependencies.resolvePackageModules ?? packageModuleResolver)?.(packageIds) ?? [] }
    catch { /* 下方按明确选中项产生审计失败，不能转为普通聊天静默执行。 */ }
  }
  const includedResources = new Set<string>()
  let packageSkillBytes = 0
  let packagePromptBytes = 0

  for (const moduleId of selectedIds) {
    if (disabled.has(moduleId)) {
      unavailable.push({ moduleId, reason: 'AGENT_MODULE_DISABLED' })
      continue
    }
    const module = moduleMap.get(moduleId)
    if (!module) {
      unavailable.push({ moduleId, reason: 'AGENT_MODULE_NOT_FOUND' })
      continue
    }
    if (module.resourceSource === 'package') {
      if (input.skillsEnabled === false) {
        unavailable.push({ moduleId, reason: 'AGENT_MODULE_SKILLS_DISABLED' })
        continue
      }
      const resolved = packageModules.find(entry => entry.moduleId === moduleId)
      if (!resolved || resolved.pluginId !== module.pluginId || resolved.version !== module.version || resolved.packageHash !== module.packageHash) {
        unavailable.push({ moduleId, reason: 'AGENT_MODULE_PACKAGE_UNAVAILABLE' })
        continue
      }
      /** 宿主身份和声明逐项匹配，包正文不能冒充另一模块的资源。 */
      const expectedIds = new Set([...module.skillRefs, ...module.promptRefs])
      const ids = new Set(resolved.resources.map(resource => resource.id))
      if (ids.size !== resolved.resources.length || ids.size !== expectedIds.size || resolved.resources.some(resource => !expectedIds.has(resource.id) || !resource.ownerModuleIds.includes(moduleId))) {
        unavailable.push({ moduleId, reason: 'AGENT_MODULE_PACKAGE_UNAVAILABLE' })
        continue
      }
      const fragments = resolved.resources.filter(resource => !includedResources.has(resource.id)).map(resource => ({ resource,
        text: `[插件 ${resolved.pluginId} v${resolved.version} · 模块 ${module.displayName} · ${resource.kind} ${resource.id} v${resource.version}]\n${resource.content}`,
      }))
      const skillBytes = fragments.filter(entry => entry.resource.kind === 'skill').reduce((sum, entry) => sum + Buffer.byteLength(entry.text), 0)
      const promptBytes = fragments.filter(entry => entry.resource.kind !== 'skill').reduce((sum, entry) => sum + Buffer.byteLength(entry.text), 0)
      if (packageSkillBytes + skillBytes > RESOURCE_LIMITS.turnSkillBytes || packagePromptBytes + promptBytes > RESOURCE_LIMITS.turnPromptBytes) {
        unavailable.push({ moduleId, reason: 'AGENT_MODULE_PACKAGE_CONTEXT_LIMIT' })
        continue
      }
      packageSkillBytes += skillBytes
      packagePromptBytes += promptBytes
      for (const entry of fragments) { includedResources.add(entry.resource.id); promptFragments.push(entry.text) }
      modules.push({ moduleId, moduleVersion: module.version, displayName: module.displayName, declaredCapabilities: [],
        pluginId: resolved.pluginId, packageHash: resolved.packageHash,
        packageResources: resolved.resources.map(({ id, version, kind, byteLength }) => ({ id, version, kind, byteLength })),
        mode: 'available', invocationMode: input.invocationMode ?? 'invoke', skillRefs: [...module.skillRefs], promptRefs: [...module.promptRefs],
        activatedAt: now, sessionId: input.sessionId, policyRevision: input.policy.revision,
      })
      continue
    }
    /** 只校验该模块的真实依赖；无 Skill 的会话运维不依赖项目 Skills 开关。 */
    if (!input.workspaceSlug && (module.scope === 'project' || module.skillRefs.length > 0)) {
      unavailable.push({ moduleId, reason: 'AGENT_MODULE_WORKSPACE_REQUIRED' })
      continue
    }
    if (input.skillsEnabled === false && module.skillRefs.length > 0) {
      unavailable.push({ moduleId, reason: 'AGENT_MODULE_SKILLS_DISABLED' })
      continue
    }
    const missingPrompts = module.promptRefs.filter((ref) => resolveModulePrompt(ref) === undefined)
    if (missingPrompts.length > 0) {
      unavailable.push({ moduleId, reason: 'AGENT_MODULE_PROMPT_UNAVAILABLE' })
      continue
    }
    const missingSkills = module.skillRefs.filter((skillRef) => !skills.has(skillRef))
    if (missingSkills.length > 0) {
      unavailable.push({ moduleId, reason: 'AGENT_MODULE_SKILL_UNAVAILABLE' })
      continue
    }
    const mode = input.policy.mode === 'pinned' || input.policy.pinnedModuleIds.includes(moduleId) ? 'pinned' : input.policy.mode
    modules.push({
      moduleId: module.id,
      moduleVersion: module.version,
      displayName: module.displayName,
      declaredCapabilities: [...module.toolRefs],
      mode,
      ...(input.invocationMode ? { invocationMode: input.invocationMode } : {}),
      skillRefs: [...module.skillRefs],
      promptRefs: [...module.promptRefs],
      activatedAt: now,
      sessionId: input.sessionId,
      policyRevision: input.policy.revision,
    })
    skillMentions.push(...module.skillRefs)
    for (const ref of module.promptRefs) promptFragments.push(resolveModulePrompt(ref)!)
    // toolRefs 是能力标识，不是 Pi 工具名；权限仍由既有工具装配链校验。
  }

  return {
    modules,
    skillMentions: unique(skillMentions),
    promptFragments: unique(promptFragments),
    allowedToolNames: [],
    unavailable,
  }
}
