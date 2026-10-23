import { isPluginCapabilityId, type PluginCapabilityId } from './capabilities.js'
import type { ValidationIssue } from './contracts.js'
import { isPortableResourcePath, collectSchemaIssues } from './validation.js'
import type {
  PluginJsonSchema,
  PluginV3Manifest,
  PluginV3ParseResult,
  PluginV3Setting,
} from './v3.js'
import { PLUGIN_MANIFEST_V3_SCHEMA } from './v3-schema.js'

/** V3 工具名允许被 Pi 稳定注册。 */
const AGENT_NAME_PATTERN = /^[a-z][a-z0-9_]{0,63}$/
/** Surface bridge 方法只接受稳定标识，避免路径或表达式。 */
const METHOD_PATTERN = /^[a-z][A-Za-z0-9_]{0,63}$/
/** 工具输入 Schema 允许的字段白名单。 */
const TOOL_SCHEMA_FIELDS = new Set([
  'type', 'properties', 'items', 'required', 'additionalProperties', 'enum', 'const',
  'anyOf', 'oneOf', 'description', 'default', 'minimum', 'maximum', 'minLength',
  'maxLength', 'minItems', 'maxItems', 'uniqueItems',
])
/** JSON Schema 类型值白名单。 */
const TOOL_SCHEMA_TYPES = new Set(['object', 'array', 'string', 'number', 'integer', 'boolean', 'null'])
/** 设置字段白名单，拒绝任意运行表达式或 UI 脚本。 */
const SETTING_FIELDS = new Set([
  'key', 'type', 'label', 'description', 'required', 'apply', 'defaultValue',
  'minimum', 'maximum', 'maxLength', 'enumValues',
])

/** 添加带 JSON 路径的 V3 校验问题。 */
function addIssue(
  issues: ValidationIssue[],
  code: ValidationIssue['code'],
  field: string,
  message: string,
): void {
  issues.push({ code, field, file: 'plugin.json', message })
}

/** 校验值是否为 JSON 可表示数据，阻止函数、Symbol 和循环引用。 */
function isJsonValue(value: unknown, seen = new Set<object>()): boolean {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return true
  if (typeof value === 'number') return Number.isFinite(value)
  if (typeof value !== 'object') return false
  if (seen.has(value)) return false
  seen.add(value)
  const valid = Array.isArray(value)
    ? value.every(item => isJsonValue(item, seen))
    : Object.getPrototypeOf(value) === Object.prototype && Object.values(value as Record<string, unknown>).every(item => isJsonValue(item, seen))
  seen.delete(value)
  return valid
}

/** 递归校验工具输入 Schema 只使用宿主支持的 JSON Schema 子集。 */
function validateToolSchema(value: PluginJsonSchema, field: string, issues: ValidationIssue[], depth = 0): void {
  if (depth > 12) {
    addIssue(issues, 'budget', field, '工具输入 Schema 嵌套过深')
    return
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    addIssue(issues, 'schema', field, '工具输入 Schema 必须是普通对象')
    return
  }
  for (const [key, child] of Object.entries(value)) {
    if (!TOOL_SCHEMA_FIELDS.has(key)) addIssue(issues, 'unsupported', `${field}.${key}`, '工具输入 Schema 字段不受支持')
    if (key === 'type' && (typeof child !== 'string' || !TOOL_SCHEMA_TYPES.has(child))) {
      addIssue(issues, 'schema', `${field}.type`, 'JSON Schema 类型无效')
    }
    if (key === 'required' && (!Array.isArray(child) || !child.every(item => typeof item === 'string'))) {
      addIssue(issues, 'schema', `${field}.required`, 'required 必须为字符串数组')
    }
  }
  for (const [key, child] of Object.entries(value.properties ?? {})) {
    validateToolSchema(child, `${field}.properties.${key}`, issues, depth + 1)
  }
  if (value.items) validateToolSchema(value.items, `${field}.items`, issues, depth + 1)
  for (const [key, child] of (value.anyOf ?? []).entries()) validateToolSchema(child, `${field}.anyOf[${key}]`, issues, depth + 1)
  for (const [key, child] of (value.oneOf ?? []).entries()) validateToolSchema(child, `${field}.oneOf[${key}]`, issues, depth + 1)
  if (value.additionalProperties && typeof value.additionalProperties === 'object') {
    validateToolSchema(value.additionalProperties, `${field}.additionalProperties`, issues, depth + 1)
  }
  if (value.default !== undefined && !isJsonValue(value.default)) {
    addIssue(issues, 'schema', `${field}.default`, '默认值必须是 JSON 数据')
  }
}

/** 根据插件与模块身份生成稳定的 Pi 工具名。 */
export function pluginAgentToolName(pluginId: string, toolId: string): string {
  const normalized = `${pluginId}_${toolId}`.replace(/[.-]/g, '_').toLowerCase()
  return `plugin_${normalized}`.slice(0, 64)
}

/** 校验单个声明式设置的类型、范围与默认值。 */
function validateSetting(setting: PluginV3Setting, field: string, issues: ValidationIssue[]): void {
  const record = setting as unknown as Record<string, unknown>
  for (const key of Object.keys(record)) {
    if (!SETTING_FIELDS.has(key)) addIssue(issues, 'unsupported', `${field}.${key}`, '设置字段不受支持')
  }
  if (setting.type === 'enum') {
    if (!Array.isArray(setting.enumValues) || setting.enumValues.length === 0) {
      addIssue(issues, 'schema', `${field}.enumValues`, '枚举设置必须提供 enumValues')
    } else if (setting.defaultValue !== undefined && !setting.enumValues.includes(setting.defaultValue)) {
      addIssue(issues, 'schema', `${field}.defaultValue`, '枚举默认值不在候选列表中')
    }
  }
  if (setting.type === 'integer') {
    if (setting.defaultValue !== undefined && (!Number.isSafeInteger(setting.defaultValue)
      || (setting.minimum !== undefined && setting.defaultValue < setting.minimum)
      || (setting.maximum !== undefined && setting.defaultValue > setting.maximum))) {
      addIssue(issues, 'schema', `${field}.defaultValue`, '整数默认值无效或越界')
    }
    if (setting.minimum !== undefined && setting.maximum !== undefined && setting.minimum > setting.maximum) {
      addIssue(issues, 'schema', field, '整数设置上下限冲突')
    }
  }
  if (setting.type === 'text' && setting.defaultValue !== undefined
    && (typeof setting.defaultValue !== 'string' || (setting.maxLength !== undefined && [...setting.defaultValue].length > setting.maxLength))) {
    addIssue(issues, 'schema', `${field}.defaultValue`, '文本默认值无效或超出长度')
  }
  if (setting.type === 'boolean' && setting.defaultValue !== undefined && typeof setting.defaultValue !== 'boolean') {
    addIssue(issues, 'schema', `${field}.defaultValue`, '布尔默认值无效')
  }
}

/**
 * 解析并语义校验 V3 module-runtime manifest。
 * @param input 不可信 JSON 数据。
 * @returns 规范化后的 V3 manifest 或字段级错误。
 */
export function parsePluginManifestV3(input: unknown): PluginV3ParseResult {
  const issues = collectSchemaIssues(input, PLUGIN_MANIFEST_V3_SCHEMA)
  if (issues.length) return { ok: false, issues }
  const source = structuredClone(input) as PluginV3Manifest
  if (!source.id.startsWith(`${source.publisherId}.`) || source.publisherId === 'builtin' || source.id.startsWith('builtin.')) {
    addIssue(issues, 'identity', '$.id', 'V3 插件身份必须属于当前发布者且不得使用 builtin 保留身份')
  }
  if (source.runtime.format !== 'module-esm' || !isPortableResourcePath(source.runtime.entry) || !source.runtime.entry.startsWith('runtime/')) {
    addIssue(issues, 'path', '$.runtime.entry', 'runtime 入口必须是包内 runtime/ 下的 portable ESM 路径')
  }

  /** 建立本地模块 ID 到全限定模块 ID 的映射，贡献只接受声明过的 owner。 */
  const moduleIds = new Map<string, string>()
  const moduleIdSet = new Set<string>()
  for (const [index, module] of source.modules.entries()) {
    if (moduleIds.has(module.id)) addIssue(issues, 'identity', `$.modules[${index}].id`, '模块 ID 重复')
    const qualified = `${source.id}.${module.id}`
    moduleIds.set(module.id, qualified)
    moduleIdSet.add(qualified)
  }
  const resolveOwner = (owner: string, field: string): string => {
    const qualified = moduleIds.get(owner)
    if (!qualified) addIssue(issues, 'reference', field, 'ownerModuleId 未引用本插件模块')
    return qualified ?? owner
  }
  const ensureReferences = (entries: readonly string[], declared: ReadonlySet<string>, field: string): void => {
    for (const [index, id] of entries.entries()) {
      if (!declared.has(id)) addIssue(issues, 'reference', `${field}[${index}]`, '模块引用的贡献不存在')
    }
  }
  for (const [index, module] of source.modules.entries()) {
    module.id = moduleIds.get(module.id) ?? module.id
    module.scope = module.scope ?? 'project'
    for (const [kind, ids] of [
      ['tools', module.tools],
      ['surfaces', module.surfaces],
      ['services', module.services],
      ['artifacts', module.artifacts],
      ['prompts', module.promptRefs],
    ] as const) {
      const declared = new Set((source[kind === 'prompts' ? 'prompts' : kind] as Array<{ id: string }>).map(entry => entry.id))
      ensureReferences(ids, declared, `$.modules[${index}].${kind}`)
    }
  }

  for (const [index, tool] of source.tools.entries()) {
    tool.ownerModuleId = resolveOwner(tool.ownerModuleId, `$.tools[${index}].ownerModuleId`)
    if (!moduleIdSet.has(tool.ownerModuleId)) continue
    tool.agentName = tool.agentName || pluginAgentToolName(source.id, tool.id)
    if (!AGENT_NAME_PATTERN.test(tool.agentName)) addIssue(issues, 'schema', `$.tools[${index}].agentName`, 'Agent 工具名格式无效')
    if (!Number.isSafeInteger(tool.timeoutMs) || tool.timeoutMs < 1 || tool.timeoutMs > 900000) addIssue(issues, 'schema', `$.tools[${index}].timeoutMs`, '工具超时必须是 1..900000 的整数')
    validateToolSchema(tool.inputSchema, `$.tools[${index}].inputSchema`, issues)
  }
  const agentNames = new Set<string>()
  for (const [index, tool] of source.tools.entries()) {
    if (agentNames.has(tool.agentName)) addIssue(issues, 'identity', `$.tools[${index}].agentName`, 'Agent 工具名冲突')
    agentNames.add(tool.agentName)
  }

  for (const [index, surface] of source.surfaces.entries()) {
    surface.ownerModuleId = resolveOwner(surface.ownerModuleId, `$.surfaces[${index}].ownerModuleId`)
    if (!isPortableResourcePath(surface.entry) || !surface.entry.startsWith('surfaces/')) {
      addIssue(issues, 'path', `$.surfaces[${index}].entry`, 'Surface 入口必须是包内 surfaces/ 下的 portable 路径')
    }
    const methods = new Set<string>()
    for (const [methodIndex, method] of surface.methods.entries()) {
      if (!METHOD_PATTERN.test(method) || methods.has(method)) addIssue(issues, 'schema', `$.surfaces[${index}].methods[${methodIndex}]`, 'Surface 方法格式无效或重复')
      methods.add(method)
    }
  }

  for (const [index, artifact] of source.artifacts.entries()) {
    artifact.ownerModuleId = resolveOwner(artifact.ownerModuleId, `$.artifacts[${index}].ownerModuleId`)
    if (!artifact.mimeTypes.every(value => /^[a-z0-9][a-z0-9.+-]*\/[a-z0-9][a-z0-9.+-]*$/i.test(value))) {
      addIssue(issues, 'schema', `$.artifacts[${index}].mimeTypes`, '产物 MIME 类型无效')
    }
  }

  const promptIds = new Set<string>()
  for (const [index, prompt] of source.prompts.entries()) {
    if (promptIds.has(prompt.id)) addIssue(issues, 'identity', `$.prompts[${index}].id`, '提示 ID 重复')
    promptIds.add(prompt.id)
    if (!isPortableResourcePath(prompt.path) || !prompt.path.startsWith('prompts/')) {
      addIssue(issues, 'path', `$.prompts[${index}].path`, '提示必须位于 prompts/ 下')
    }
  }

  const settingKeys = new Set<string>()
  for (const [index, setting] of source.settings.entries()) {
    if (settingKeys.has(setting.key)) addIssue(issues, 'identity', `$.settings[${index}].key`, '设置 key 重复')
    settingKeys.add(setting.key)
    validateSetting(setting, `$.settings[${index}]`, issues)
  }

  const capabilities = new Set<string>()
  for (const [index, capability] of source.capabilities.entries()) {
    if (!isPluginCapabilityId(capability)) addIssue(issues, 'unsupported', `$.capabilities[${index}]`, '宿主不支持该能力')
    if (capabilities.has(capability)) addIssue(issues, 'identity', `$.capabilities[${index}]`, '能力声明重复')
    capabilities.add(capability)
  }

  if (new TextEncoder().encode(JSON.stringify(source)).byteLength > 1024 * 1024) {
    addIssue(issues, 'budget', '$', 'V3 manifest 超过 1 MiB')
  }
  return issues.length ? { ok: false, issues } : { ok: true, value: source, issues: [] }
}

/** 只保留能力 ID 的类型收窄入口，供宿主投影使用。 */
export function normalizePluginCapabilities(values: readonly string[]): PluginCapabilityId[] {
  return values.filter(isPluginCapabilityId)
}
