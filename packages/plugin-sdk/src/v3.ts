import type { PluginCapabilityId } from './capabilities.js'
import type { ValidationResult } from './contracts.js'

/** V3 可执行插件使用的清单格式版本。 */
export const PLUGIN_V3_FORMAT_VERSION = 3 as const
/** V3 清单当前 API 版本。 */
export const PLUGIN_V3_API_VERSION = '1.0.0' as const

/** 插件只允许三种激活/审批模式中的稳定值。 */
export type PluginApprovalMode = 'none' | 'per-call' | 'write'

/** 模块引用现有 Skill 注册表的稳定身份。 */
export interface PluginSkillReference {
  id: string
  scope: 'project' | 'workspace' | 'builtin'
  versionRange?: string
  required: boolean
}

/** 工具对 Agent 暴露的输入合同。 */
export interface PluginJsonSchema {
  type?: 'object' | 'array' | 'string' | 'number' | 'integer' | 'boolean' | 'null'
  properties?: Record<string, PluginJsonSchema>
  items?: PluginJsonSchema
  required?: readonly string[]
  additionalProperties?: boolean | PluginJsonSchema
  enum?: readonly unknown[]
  const?: unknown
  anyOf?: readonly PluginJsonSchema[]
  oneOf?: readonly PluginJsonSchema[]
  description?: string
  default?: unknown
  minimum?: number
  maximum?: number
  minLength?: number
  maxLength?: number
  minItems?: number
  maxItems?: number
  uniqueItems?: boolean
}

/** V3 模块声明。运行时输出中的 id 是全限定身份。 */
export interface PluginV3Module {
  id: string
  displayName: string
  description: string
  icon: string
  /** 模块作用域；旧 V3 草稿缺失时规范化到 project。 */
  scope?: 'session' | 'project' | 'global'
  activation: 'message-explicit' | 'session-toggle'
  skillRefs: PluginSkillReference[]
  promptRefs: string[]
  tools: string[]
  surfaces: string[]
  services: string[]
  artifacts: string[]
}

/** V3 Agent 工具声明；`agentName` 由解析器生成或校验。 */
export interface PluginV3Tool {
  id: string
  ownerModuleId: string
  agentName: string
  title: string
  description: string
  inputSchema: PluginJsonSchema
  annotations: {
    readOnly: boolean
    destructive: boolean
    idempotent: boolean
    openWorld: boolean
  }
  approval: PluginApprovalMode
  timeoutMs: number
  concurrencyKey?: string
}

/** V3 右侧 Surface 声明。 */
export interface PluginV3Surface {
  id: string
  ownerModuleId: string
  title: string
  entry: string
  apiVersion: 1
  defaultPlacement: 'right-panel'
  methods: string[]
}

/** V3 插件级服务声明。 */
export interface PluginV3Service {
  id: string
  title: string
  start: 'lazy'
  idleStopMs: number
}

/** 项目产物或插件私有产物的稳定声明。 */
export interface PluginV3Artifact {
  id: string
  ownerModuleId: string
  title: string
  schemaVersion: number
  mimeTypes: string[]
  retention: 'project' | 'plugin'
}

/** 插件可声明的普通文本提示。 */
export interface PluginV3Prompt {
  id: string
  version: string
  kind: 'workflow' | 'output-contract' | 'style-guidance'
  path: string
}

/** 声明式设置的基础字段。 */
interface PluginV3SettingBase {
  key: string
  label: string
  description?: string
  required?: boolean
  apply: 'next-run' | 'restart-runtime'
}

/** 布尔设置。 */
export interface PluginV3BooleanSetting extends PluginV3SettingBase {
  type: 'boolean'
  defaultValue?: boolean
}

/** 有界整数设置。 */
export interface PluginV3IntegerSetting extends PluginV3SettingBase {
  type: 'integer'
  defaultValue?: number
  minimum?: number
  maximum?: number
}

/** 普通文本设置。 */
export interface PluginV3TextSetting extends PluginV3SettingBase {
  type: 'text'
  defaultValue?: string
  maxLength?: number
}

/** 枚举设置。 */
export interface PluginV3EnumSetting extends PluginV3SettingBase {
  type: 'enum'
  defaultValue?: string
  enumValues: string[]
}

/** 只保存凭据引用的敏感设置。 */
export interface PluginV3CredentialSetting extends PluginV3SettingBase {
  type: 'credentialRef'
}

/** V3 支持的声明式设置联合。 */
export type PluginV3Setting =
  | PluginV3BooleanSetting
  | PluginV3IntegerSetting
  | PluginV3TextSetting
  | PluginV3EnumSetting
  | PluginV3CredentialSetting

/** 插件依赖与导出沿用包管理合同；V3 可执行能力不能通过依赖传递授权。 */
export interface PluginV3Dependency {
  pluginId: string
  versionRange: string
  required: boolean
}

/** 插件对其它插件公开的资源。 */
export interface PluginV3Export {
  resourceId: string
  kind: 'artifact' | 'tool' | 'surface'
  apiVersion: number
  visibility: 'public' | string[]
}

/** 通过校验后的 V3 manifest。 */
export interface PluginV3Manifest {
  formatVersion: typeof PLUGIN_V3_FORMAT_VERSION
  apiVersion: typeof PLUGIN_V3_API_VERSION
  id: string
  publisherId: string
  version: string
  displayName: string
  description: string
  license: string
  profile: 'module-runtime'
  compatibility: {
    hostApi: string
    runtimeProtocol: 1
    platforms: Array<'darwin' | 'win32' | 'linux'>
    architectures: Array<'arm64' | 'x64'>
  }
  runtime: {
    entry: string
    format: 'module-esm'
  }
  modules: PluginV3Module[]
  tools: PluginV3Tool[]
  surfaces: PluginV3Surface[]
  services: PluginV3Service[]
  artifacts: PluginV3Artifact[]
  prompts: PluginV3Prompt[]
  settings: PluginV3Setting[]
  capabilities: PluginCapabilityId[]
  dependencies: PluginV3Dependency[]
  exports: PluginV3Export[]
}

/** V3 解析结果沿用 SDK 的字段级校验结果。 */
export type PluginV3ParseResult = ValidationResult<PluginV3Manifest>
