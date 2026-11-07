import type { McpOAuthConfiguration } from '@dutydeck/shared'
import { createHash } from 'node:crypto'
import { isIP } from 'node:net'
import { inspectPluginPackage } from '@dutydeck/plugin-kit'
import { buildWorkspaceMcpEntry, requireWorkspaceMcpServerName } from '../../mcp-configuration-policy'

/** 固定审查的HTTP连接方案；stdio必须走独立执行批准流程，不属于此导入子集。 */
export interface StaticMcpImportTarget {
  name: string
  type: 'http'
  url: string
  timeout?: number
  oauth?: McpOAuthConfiguration
}
export interface StaticImportPlanInput {
  recipeId: string
  recipeVersion: string
  source: { name: string; version: string; sha256: string; url: string; license: string }
  contentBytes?: Uint8Array
  mcp?: StaticMcpImportTarget
}
export interface StaticImportPlan {
  hash: string
  recipeId: string
  recipeVersion: string
  source: StaticImportPlanInput['source']
  content?: { pluginId: string; packageHash: string; keyId: string; bytes: Uint8Array }
  mcp?: StaticMcpImportTarget
}
const HASH = /^[a-f0-9]{64}$/
const VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/
function invalid(): never { throw new Error('PLUGIN_IMPORT_PLAN_INVALID') }
function keys(value: unknown, allowed: string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !allowed.includes(key))) return invalid()
  return value as Record<string, unknown>
}
function publicUrl(value: unknown): string {
  if (typeof value !== 'string' || value.length > 2048 || /[\x00-\x20]/.test(value)) return invalid()
  let url: URL
  try { url = new URL(value) } catch { return invalid() }
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || url.port
    || isIP(url.hostname.replace(/^\[|\]$/g, '')) || !url.hostname.includes('.')
    || /(?:^|\.)(?:localhost|local|internal)$/.test(url.hostname)) return invalid()
  return url.href
}
function boundedString(value: unknown, max: number): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= max && !/[\x00-\x1f\x7f]/.test(value)
}

/** 只接受宿主固定配方，绝不将renderer提交的任意对象作为已审查方案。预览不写文件或联网。 */
export function createStaticImportPlan(input: StaticImportPlanInput): StaticImportPlan {
  keys(input, ['recipeId', 'recipeVersion', 'source', 'contentBytes', 'mcp'])
  if (!boundedString(input.recipeId, 128) || !/^[a-z][a-z0-9._-]+$/.test(input.recipeId)
    || !boundedString(input.recipeVersion, 128) || !VERSION.test(input.recipeVersion)) invalid()
  const source = keys(input.source, ['name', 'version', 'sha256', 'url', 'license'])
  if (!boundedString(source.name, 214) || !/^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/.test(source.name)
    || !boundedString(source.version, 128) || !VERSION.test(source.version)
    || typeof source.sha256 !== 'string' || !HASH.test(source.sha256) || !boundedString(source.license, 512)) invalid()
  const normalizedSource = { ...input.source, url: publicUrl(source.url) }
  if (new URL(normalizedSource.url).origin !== 'https://registry.npmjs.org') invalid()
  let content: StaticImportPlan['content']
  if (input.contentBytes !== undefined) {
    if (!(input.contentBytes instanceof Uint8Array) || input.contentBytes.length > 50 * 1024 * 1024) invalid()
    const bytes = Uint8Array.from(input.contentBytes)
    const inspected = inspectPluginPackage(bytes)
    if (inspected.manifest.formatVersion !== 2 || !inspected.signatureVerified || !inspected.signer) throw new Error('PLUGIN_IMPORT_SIGNED_CONTENT_REQUIRED')
    if (inspected.manifest.modules.some(module => module.activation !== 'message-explicit')) invalid()
    content = { bytes, pluginId: inspected.manifest.id, packageHash: inspected.packageHash, keyId: inspected.signer.keyId }
  }
  let mcp: StaticMcpImportTarget | undefined
  if (input.mcp !== undefined) {
    const target = keys(input.mcp, ['name', 'type', 'url', 'timeout', 'oauth'])
    if (target.type !== 'http' || !boundedString(target.name, 120)) invalid()
    try { requireWorkspaceMcpServerName(target.name) } catch { return invalid() }
    if (target.timeout !== undefined && (typeof target.timeout !== 'number' || !Number.isInteger(target.timeout) || target.timeout < 1 || target.timeout > 300)) invalid()
    if (target.oauth !== undefined) {
      const oauth = keys(target.oauth, ['provider', 'clientId', 'clientSecretRequired', 'scopes', 'authorizationEndpoint', 'tokenEndpoint', 'registrationEndpoint'])
      for (const key of ['provider', 'clientId']) if (oauth[key] !== undefined && !boundedString(oauth[key], 512)) invalid()
      for (const key of ['authorizationEndpoint', 'tokenEndpoint', 'registrationEndpoint']) if (oauth[key] !== undefined) publicUrl(oauth[key])
      if (oauth.clientSecretRequired !== undefined && typeof oauth.clientSecretRequired !== 'boolean') invalid()
      if (oauth.scopes !== undefined && (!Array.isArray(oauth.scopes) || oauth.scopes.length > 32 || oauth.scopes.some(scope => !boundedString(scope, 256)))) invalid()
    }
    const entry = buildWorkspaceMcpEntry({ ...input.mcp, url: publicUrl(target.url) })
    mcp = { name: target.name.trim(), type: 'http', url: entry.url!, ...(entry.timeout ? { timeout: entry.timeout } : {}), ...(entry.oauth ? { oauth: entry.oauth } : {}) }
  }
  if (!content && !mcp) invalid()
  const identity = { recipeId: input.recipeId, recipeVersion: input.recipeVersion, source: normalizedSource,
    ...(content ? { content: { pluginId: content.pluginId, packageHash: content.packageHash, keyId: content.keyId } } : {}), ...(mcp ? { mcp } : {}) }
  const hash = createHash('sha256').update(JSON.stringify(identity)).digest('hex')
  return { recipeId: input.recipeId, recipeVersion: input.recipeVersion, source: structuredClone(normalizedSource), hash,
    ...(mcp ? { mcp: structuredClone(mcp) } : {}), ...(content ? { content } : {}) }
}
