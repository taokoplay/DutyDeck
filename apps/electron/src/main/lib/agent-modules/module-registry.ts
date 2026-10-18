import type { AgentModuleManifest } from '@dutydeck/shared'

/**
 * DutyDeck 内置模块清单。
 *
 * 这里声明用户可见的模块边界，具体执行仍由现有 Agent tool provider 和业务服务负责。
 * Skill 引用使用 workspace Skill slug，未安装时由 resolver 返回可执行的缺失原因。
 */
export const BUILTIN_AGENT_MODULES: readonly AgentModuleManifest[] = [
  {
    id: 'canvas',
    version: '1.0.0',
    apiVersion: 1,
    displayName: '画布',
    description: '创建、编辑和评审可持续复用的画布产物。',
    icon: 'layout-dashboard',
    scope: 'project',
    contributions: ['surface', 'skill', 'prompt', 'tool', 'artifact'],
    skillRefs: ['canvas-production'],
    promptRefs: ['canvas.system.v1'],
    toolRefs: ['canvas.inspect', 'canvas.create_node', 'canvas.update_node'],
    artifactTypes: ['canvas.document', 'canvas.node'],
    surfaceIds: ['canvas'],
    requiredPermissions: ['project.files.read', 'project.files.write'],
  },
  {
    id: 'visual-production',
    version: '1.0.0',
    apiVersion: 1,
    displayName: '影像',
    description: '按已配置的模型和工作流生成、评审和交付媒体产物。',
    icon: 'clapperboard',
    scope: 'project',
    contributions: ['surface', 'skill', 'prompt', 'tool', 'artifact'],
    skillRefs: ['media-models', 'canvas-production'],
    promptRefs: ['visual-production.system.v1'],
    toolRefs: ['media.list_models', 'media.generate', 'media.review'],
    artifactTypes: ['media.image', 'media.video', 'media.audio'],
    surfaceIds: ['visual-production'],
    requiredPermissions: ['project.files.read', 'project.files.write', 'media.execute'],
  },
  {
    id: 'interaction-design',
    version: '1.0.0',
    apiVersion: 1,
    displayName: '交互设计',
    description: '生成、还原和迭代可点击的 App/Web 原型。',
    icon: 'mouse-pointer-2',
    scope: 'project',
    contributions: ['surface', 'skill', 'prompt', 'tool', 'artifact'],
    skillRefs: ['interaction-design'],
    promptRefs: ['interaction-design.system.v1'],
    toolRefs: ['prototype.list', 'prototype.read', 'prototype.propose'],
    artifactTypes: ['interaction.prototype', 'interaction.page'],
    surfaceIds: ['interaction-design'],
    requiredPermissions: ['project.files.read', 'project.files.write'],
  },
  {
    id: 'browser',
    version: '1.0.0',
    apiVersion: 1,
    displayName: '浏览器',
    description: '使用当前会话关联的受管浏览器访问和操作网页。',
    icon: 'globe-2',
    scope: 'session',
    contributions: ['surface', 'skill', 'prompt', 'tool', 'artifact'],
    skillRefs: ['in-app-browser'],
    promptRefs: ['browser.system.v1'],
    toolRefs: ['browser.navigate', 'browser.observe', 'browser.act'],
    artifactTypes: ['browser.page', 'browser.screenshot'],
    surfaceIds: ['browser'],
    requiredPermissions: ['network.request'],
  },
  {
    id: 'terminal',
    version: '1.0.0',
    apiVersion: 1,
    displayName: '终端',
    description: '在当前项目边界内检查、构建和运行命令。',
    icon: 'square-terminal',
    scope: 'session',
    contributions: ['surface', 'prompt', 'tool', 'artifact'],
    skillRefs: [],
    promptRefs: ['terminal.system.v1'],
    toolRefs: ['terminal.exec', 'terminal.read_output'],
    artifactTypes: ['terminal.command', 'terminal.output'],
    surfaceIds: ['terminal'],
    requiredPermissions: ['process.spawn'],
  },
]

/** 返回稳定顺序的内置模块清单副本，避免调用方修改注册表。 */
export function listBuiltinAgentModules(): AgentModuleManifest[] {
  return BUILTIN_AGENT_MODULES.map((module) => ({
    ...module,
    contributions: [...module.contributions],
    skillRefs: [...module.skillRefs],
    promptRefs: [...module.promptRefs],
    toolRefs: [...module.toolRefs],
    artifactTypes: [...module.artifactTypes],
    surfaceIds: [...module.surfaceIds],
    requiredPermissions: [...module.requiredPermissions],
  }))
}

/** 根据稳定模块 ID 查找模块；返回副本以阻止运行时注册表被污染。 */
export function getBuiltinAgentModule(moduleId: string): AgentModuleManifest | undefined {
  const module = BUILTIN_AGENT_MODULES.find((candidate) => candidate.id === moduleId)
  return module ? listBuiltinAgentModules().find((candidate) => candidate.id === moduleId) : undefined
}
