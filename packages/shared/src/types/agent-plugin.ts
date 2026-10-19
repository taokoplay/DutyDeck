import type { AgentModuleManifest } from './agent-modules'
import { parseAgentModuleManifest } from './agent-modules'

export interface AgentPluginEntry {
  kind: 'manifest-only'
}

export interface AgentPluginManifest {
  id: string
  version: string
  apiVersion: 1
  displayName: string
  description: string
  modules: AgentModuleManifest[]
  entry: AgentPluginEntry
  /** 插件自有纯文本提示，键必须以插件 ID 加点号开头；不接受文件路径或执行入口。 */
  prompts?: Record<string, string>
}

export interface ParsedAgentPluginManifest {
  manifest: AgentPluginManifest
  warnings: string[]
}

export interface AgentPluginDiagnostic {
  pluginId: string
  path: string
  status: 'loaded' | 'rejected'
  warnings: string[]
  errorCode?: string
}

export type AgentPluginLifecycleState = 'registered' | 'starting' | 'running' | 'stopping' | 'stopped' | 'failed'

/** 插件宿主健康快照；错误只保存可展示的 code，不保存异常正文或凭据。 */
export interface AgentPluginHealth {
  pluginId: string
  state: AgentPluginLifecycleState
  updatedAt: number
  errorCode?: string
}

/** 宿主固定提示引用；插件可引用但不得覆盖。 */
export const BUILTIN_AGENT_MODULE_PROMPT_IDS = [
  'canvas.system.v1', 'visual-production.system.v1', 'interaction-design.system.v1',
  'browser.system.v1', 'terminal.system.v1',
] as const

/** 每个插件的提示数量、单条字符数及合计字符数上限，限制常驻快照和上下文开销。 */
const MAX_PLUGIN_PROMPTS = 32
const MAX_PLUGIN_PROMPT_LENGTH = 16 * 1024
const MAX_PLUGIN_PROMPTS_TOTAL_LENGTH = 64 * 1024

const PLUGIN_ID_PATTERN = /^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/
const VERSION_PATTERN = /^[0-9]+\.[0-9]+\.[0-9]+(?:[-+][0-9A-Za-z.-]+)?$/

/**
 * 解析 manifest-only 插件清单；首版不接受可执行入口，避免第三方文件获得主进程权限。
 * @param value 未信任的 plugin.json 内容。
 * @returns 规范化后的插件清单和非阻断警告。
 */
export function parseAgentPluginManifest(value: unknown): ParsedAgentPluginManifest {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('AGENT_PLUGIN_MANIFEST_INVALID')
  const record = value as Record<string, unknown>
  for (const key of ['id', 'version', 'displayName', 'description'] as const) {
    if (typeof record[key] !== 'string' || record[key].trim().length === 0) throw new Error(`AGENT_PLUGIN_${key.toUpperCase()}_INVALID`)
  }
  const id = (record.id as string).trim()
  const version = (record.version as string).trim()
  if (!PLUGIN_ID_PATTERN.test(id)) throw new Error('AGENT_PLUGIN_ID_INVALID')
  if (!VERSION_PATTERN.test(version)) throw new Error('AGENT_PLUGIN_VERSION_INVALID')
  if (record.apiVersion !== 1) throw new Error('AGENT_PLUGIN_API_VERSION_UNSUPPORTED')
  if (!record.entry || typeof record.entry !== 'object' || Array.isArray(record.entry) || (record.entry as Record<string, unknown>).kind !== 'manifest-only') {
    throw new Error('AGENT_PLUGIN_ENTRY_UNSUPPORTED')
  }
  if (!Array.isArray(record.modules) || record.modules.length === 0) throw new Error('AGENT_PLUGIN_MODULES_REQUIRED')
  if (record.modules.length > 32) throw new Error('AGENT_PLUGIN_MODULES_TOO_LARGE')

  const prompts = parsePluginPrompts(record.prompts, id)
  const warnings: string[] = []
  const moduleIds = new Set<string>()
  const modules = (record.modules as unknown[]).map((candidate) => {
    const parsed = parseAgentModuleManifest(candidate)
    if (moduleIds.has(parsed.manifest.id)) throw new Error('AGENT_PLUGIN_MODULE_ID_DUPLICATE')
    for (const ref of parsed.manifest.promptRefs) {
      if (!(BUILTIN_AGENT_MODULE_PROMPT_IDS as readonly string[]).includes(ref) && !Object.hasOwn(prompts ?? {}, ref)) {
        throw new Error('AGENT_PLUGIN_PROMPT_REFERENCE_UNAVAILABLE')
      }
    }
    moduleIds.add(parsed.manifest.id)
    warnings.push(...parsed.warnings.map((warning) => `${parsed.manifest.id}:${warning}`))
    return parsed.manifest
  })
  return {
    manifest: {
      id,
      version,
      apiVersion: 1,
      displayName: (record.displayName as string).trim(),
      description: (record.description as string).trim(),
      modules,
      entry: { kind: 'manifest-only' },
      ...(prompts ? { prompts } : {}),
    },
    warnings,
  }
}


/** 解析有限纯文本提示目录；非法键和值整体拒绝，不截断、不自动修复引用。 */
function parsePluginPrompts(value: unknown, pluginId: string): Record<string, string> | undefined {
  if (value === undefined) return undefined
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('AGENT_PLUGIN_PROMPTS_INVALID')
  const entries = Object.entries(value as Record<string, unknown>)
  if (entries.length > MAX_PLUGIN_PROMPTS) throw new Error('AGENT_PLUGIN_PROMPTS_TOO_LARGE')
  const prompts: Record<string, string> = {}
  let totalLength = 0
  for (const [id, content] of entries) {
    if (!id.startsWith(`${pluginId}.`) || id.length > 160 || !PLUGIN_ID_PATTERN.test(id)
      || (BUILTIN_AGENT_MODULE_PROMPT_IDS as readonly string[]).includes(id)) {
      throw new Error('AGENT_PLUGIN_PROMPT_ID_INVALID')
    }
    if (typeof content !== 'string' || !content.trim() || /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/.test(content)) {
      throw new Error('AGENT_PLUGIN_PROMPT_CONTENT_INVALID')
    }
    totalLength += content.length
    if (content.length > MAX_PLUGIN_PROMPT_LENGTH || totalLength > MAX_PLUGIN_PROMPTS_TOTAL_LENGTH) {
      throw new Error('AGENT_PLUGIN_PROMPTS_TOO_LARGE')
    }
    prompts[id] = content
  }
  return prompts
}

/** 用户确认前的本地插件预览；令牌绑定主进程保存的规范化内容。 */
export interface AgentPluginPreview {
  token: string
  sourcePath: string
  contentHash: string
  manifest: AgentPluginManifest
  warnings: string[]
}

/** 安装目录与 Agent 运行时同步发布的快照。 */
export interface AgentPluginCatalogSnapshot {
  modules: AgentModuleManifest[]
  diagnostics: AgentPluginDiagnostic[]
  refreshedAt: number
}
