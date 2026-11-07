import { createHash, type KeyObject } from 'node:crypto'
import { parsePluginManifest, type PluginPackageManifest } from '@dutydeck/plugin-sdk'
import { createPluginPackage, inspectPluginPackage } from '@dutydeck/plugin-kit'
import { readNpmTarball } from '../catalog/npm-package-analysis'

/** 仅由宿主随版本审查的配方提供；不是目录字段或renderer提交的安装授权。 */
export interface StaticContentRecipe {
  formatVersion: 1
  id: string
  version: string
  source: { name: string; version: string; url: string; sha256: string; license: string; licensePath: string; licenseSha256: string }
  manifest: PluginPackageManifest
  resources: Array<{ sourcePath: string; targetPath: string; sha256: string }>
  independentResourcesReviewed: boolean
}
export interface ConvertedStaticContent {
  bytes: Buffer
  packageHash: string
  recipeHash: string
  signatureVerified: boolean
}
const digest = (bytes: Uint8Array | string): string => createHash('sha256').update(bytes).digest('hex')
const HASH = /^[a-f0-9]{64}$/
const ID = /^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/
const VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/
function fail(): never { throw new Error('PLUGIN_IMPORT_RECIPE_INVALID') }
function safePath(path: string): boolean {
  return typeof path === 'string' && path.length > 0 && path.length <= 512
    && !/[\\\x00-\x1f\x7f:]/.test(path) && path.split('/').every(part => part && part !== '.' && part !== '..')
}

/**
 * 静态转换不安装、不授信、不执行上游代码。调用方必须使用宿主审查的配方；
 * independentResourcesReviewed仅记录审查结论，不把外部传入的true当用户授权。
 * 输出签名只属于转换方，不代表上游作者签署了转换产物。
 */
export function convertStaticContent(recipe: StaticContentRecipe, archive: Buffer, signingKey?: KeyObject): ConvertedStaticContent {
  const encodedRecipe = JSON.stringify(recipe)
  if (Buffer.byteLength(encodedRecipe) > 256 * 1024 || recipe.formatVersion !== 1
    || typeof recipe.id !== 'string' || recipe.id.length > 128 || !ID.test(recipe.id)
    || typeof recipe.version !== 'string' || recipe.version.length > 128 || !VERSION.test(recipe.version)
    || recipe.independentResourcesReviewed !== true) fail()
  const source = recipe.source
  if (!source || !HASH.test(source.sha256) || !HASH.test(source.licenseSha256)
    || typeof source.license !== 'string' || !source.license.trim() || source.license.length > 512
    || !safePath(source.licensePath) || typeof source.url !== 'string' || source.url.length > 2048) fail()
  let url: URL
  try { url = new URL(source.url) } catch { return fail() }
  if (url.origin !== 'https://registry.npmjs.org' || url.username || url.password || url.search || url.hash) fail()
  if (digest(archive) !== source.sha256) throw new Error('PLUGIN_IMPORT_SOURCE_CHANGED')
  const files = readNpmTarball(archive)
  let upstream: Record<string, unknown>
  const upstreamBytes = files.get('package.json')
  if (!upstreamBytes || upstreamBytes.length > 1024 * 1024) fail()
  try { upstream = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(upstreamBytes)) as Record<string, unknown> }
  catch { return fail() }
  if (!upstream || Array.isArray(upstream) || upstream.name !== source.name || upstream.version !== source.version
    || upstream.license !== source.license) throw new Error('PLUGIN_IMPORT_SOURCE_IDENTITY_MISMATCH')
  const license = files.get(source.licensePath)
  if (!license?.length || digest(license) !== source.licenseSha256) throw new Error('PLUGIN_IMPORT_LICENSE_CHANGED')
  const parsed = parsePluginManifest(recipe.manifest)
  if (!parsed.ok || parsed.value.license !== source.license || parsed.value.modules.some(module => module.activation !== 'message-explicit')) fail()
  if (!Array.isArray(recipe.resources) || !recipe.resources.length || recipe.resources.length > 64) fail()
  const declared = new Set([...parsed.value.skills, ...parsed.value.prompts, ...(parsed.value.styles ?? [])].map(resource => resource.path))
  const output = new Map<string, Uint8Array>()
  for (const resource of recipe.resources) {
    if (!safePath(resource.sourcePath) || !safePath(resource.targetPath) || !HASH.test(resource.sha256)
      || !declared.has(resource.targetPath) || output.has(resource.targetPath)) fail()
    const bytes = files.get(resource.sourcePath)
    if (!bytes || digest(bytes) !== resource.sha256) throw new Error('PLUGIN_IMPORT_RESOURCE_CHANGED')
    output.set(resource.targetPath, Uint8Array.from(bytes))
  }
  if ([...declared].some(path => !output.has(path))) fail()
  const recipeHash = digest(encodedRecipe)
  output.set('plugin.json', Buffer.from(JSON.stringify(parsed.value, null, 2)))
  output.set('LICENSE', Uint8Array.from(license))
  output.set('README.md', Buffer.from(`# ${parsed.value.displayName}\n\n由固定静态配方转换，仅在本轮显式选择模块后注入。未执行上游代码或动态配置。\n`))
  output.set('CHANGELOG.md', Buffer.from(`## ${parsed.value.version}\n\n按配方 ${recipe.id}@${recipe.version} 转换列明的独立资源；未加入上游运行时。\n`))
  output.set('THIRD_PARTY_NOTICES.md', Buffer.from([
    '# 转换来源记录', '',
    '许可正文及其中的作者版权声明保留在 LICENSE。资源正文逐字节保留。',
    '如本包带有签名，它仅为转换方签名，不代表上游作者签署、批准或审计了转换产物。',
    '未列明的代码、安装脚本和动态 patch 未转换、未执行，不代表原插件已兼容。', '',
    '```json', JSON.stringify({ recipe: { id: recipe.id, version: recipe.version, sha256: recipeHash }, source, resources: recipe.resources }, null, 2), '```', '',
  ].join('\n')))
  // SDK仍校验V2资源正文、引用和预算；不为不满足合同的上游正文自动伪造章节。
  const bytes = createPluginPackage(output, signingKey)
  const inspected = inspectPluginPackage(bytes)
  return { bytes, packageHash: inspected.packageHash, recipeHash, signatureVerified: inspected.signatureVerified }
}
