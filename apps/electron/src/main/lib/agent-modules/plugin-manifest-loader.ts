import { closeSync, constants, existsSync, fstatSync, lstatSync, openSync, opendirSync, readSync } from 'node:fs'
import type { Dirent } from 'node:fs'
import { join } from 'node:path'
import { parseAgentPluginManifest } from '@dutydeck/shared'
import type { AgentPluginDiagnostic, AgentPluginManifest } from '@dutydeck/shared'
import { getConfigDir } from '../config-paths'
import { diagnoseLegacyPluginEntry } from './plugin-migration'

/** 单清单磁盘字节预算；安装预检与读取必须共用，避免写出无法加载的插件。 */
export const AGENT_PLUGIN_MANIFEST_MAX_BYTES = 1024 * 1024

export interface AgentPluginLoadResult {
  plugins: AgentPluginManifest[]
  diagnostics: AgentPluginDiagnostic[]
}

/**
 * 读取受管插件根下的 plugin.json；不扫描 cwd、祖先目录或用户附加目录。
 * @param pluginRoot 受管插件目录，生产默认位于 ~/.DutyDeck/agent-plugins。
 * @returns 有效插件与逐插件诊断信息。
 */
export function loadAgentPluginManifests(pluginRoot = join(getConfigDir(), 'agent-plugins')): AgentPluginLoadResult {
  if (!existsSync(pluginRoot)) return { plugins: [], diagnostics: [] }
  const plugins: AgentPluginManifest[] = []
  const diagnostics: AgentPluginDiagnostic[] = []
  /** 有界枚举，根异常或超量只阻断安装插件，不阻断内置模块和 IPC 初始化。 */
  const entries: Dirent[] = []
  try {
    if (!lstatSync(pluginRoot).isDirectory()) throw new Error('AGENT_PLUGIN_ROOT_UNREADABLE')
    const directory = opendirSync(pluginRoot)
    let count = 0
    try {
      let entry: Dirent | null
      while ((entry = directory.readSync()) !== null) {
        count += 1
        if (entry.isDirectory()) entries.push(entry)
        if (entry.isSymbolicLink()) diagnostics.push({ pluginId: entry.name, path: join(pluginRoot, entry.name), status: 'rejected', warnings: [], errorCode: 'AGENT_PLUGIN_SYMLINK_REJECTED' })
        if (count > 256 || entries.length > 64) throw new Error('AGENT_PLUGIN_ROOT_LIMIT_EXCEEDED')
      }
    } finally { directory.closeSync() }
  } catch (cause) {
    const errorCode = cause instanceof Error && cause.message === 'AGENT_PLUGIN_ROOT_LIMIT_EXCEEDED'
      ? cause.message : 'AGENT_PLUGIN_ROOT_UNREADABLE'
    return { plugins: [], diagnostics: [{ pluginId: 'unknown', path: pluginRoot, status: 'rejected', warnings: [], errorCode }] }
  }
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    const pluginId = entry.name
    const manifestPath = join(pluginRoot, pluginId, 'plugin.json')
    const raw = readAgentPluginManifestFile(manifestPath)
    if (raw === null) {
      diagnostics.push({ pluginId, path: manifestPath, status: 'rejected', warnings: [], errorCode: 'AGENT_PLUGIN_MANIFEST_UNREADABLE' })
      continue
    }
    try {
      const parsed = parseAgentPluginManifest(raw)
      if (parsed.manifest.id !== pluginId) throw new Error('AGENT_PLUGIN_DIRECTORY_ID_MISMATCH')
      plugins.push(parsed.manifest)
      diagnostics.push({ pluginId: parsed.manifest.id, path: manifestPath, status: 'loaded', warnings: parsed.warnings })
    } catch (error) {
      const legacyDiagnostic = diagnoseLegacyPluginEntry(raw)
      diagnostics.push(legacyDiagnostic
        ? { ...legacyDiagnostic, path: manifestPath }
        : { pluginId, path: manifestPath, status: 'rejected', warnings: [], errorCode: error instanceof Error ? error.message : 'AGENT_PLUGIN_MANIFEST_INVALID' })
    }
  }
  return { plugins, diagnostics }
}

/** 只读 no-follow 有限读取；不恢复旧备份或改写损坏清单，防止加载过期声明。 */
export function readAgentPluginManifestFile(path: string): unknown | null {
  const limit = AGENT_PLUGIN_MANIFEST_MAX_BYTES
  let descriptor: number | undefined
  try {
    // 同时覆盖不支持 O_NOFOLLOW 的平台；打开后仍以 FD 身份和类型校验。
    if (!lstatSync(path).isFile()) return null
    descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
    const stat = fstatSync(descriptor)
    if (!stat.isFile() || stat.size > limit) return null
    const buffer = Buffer.alloc(limit + 1)
    let offset = 0
    while (offset < buffer.length) {
      const count = readSync(descriptor, buffer, offset, buffer.length - offset, offset)
      if (count === 0) break
      offset += count
    }
    if (offset > limit) return null
    return JSON.parse(buffer.subarray(0, offset).toString('utf8')) as unknown
  } catch {
    return null
  } finally {
    if (descriptor !== undefined) closeSync(descriptor)
  }
}
