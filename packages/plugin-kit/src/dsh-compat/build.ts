import type { KeyObject } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { parsePluginManifestV3 } from '@dutydeck/plugin-sdk'
import { createPluginPackage, hashPluginBytes, inspectPluginPackage } from '../package.js'
import type { DshBuildRecipe } from './recipe.js'
export interface DshBuildGraph { entry: string; modules: ReadonlyMap<string, Uint8Array>; imports: Readonly<Record<string, Readonly<Record<string, string>>>> }
export interface DshBundleOutput { code: Uint8Array; inputs: readonly string[]; imports: readonly string[] }
/** 注入开发侧可信构建器；必须使用图内字节且拒绝未列明解析，不执行源代码。 */
export type DshBundleCompiler = (graph: DshBuildGraph) => Promise<DshBundleOutput>
export interface DshBuiltPackage { bytes: Buffer; recipeHash: string; packageHash: string }
const RUNTIME = '@dsh/runtime'
const ADAPTER = '@dsh/adapter'
const DEFINE = '@dsh/define-tool'
const encode = (text: string): Uint8Array => Buffer.from(text, 'utf8')
function reject(code = 'DSH_BUILD_RECIPE_INVALID'): never { throw new Error(code) }
function safePath(path: string): boolean { return path.length <= 256 && !/[\\\\:\x00-\x1f@]/.test(path) && path.split('/').every(part => part && part !== '.' && part !== '..') }

/** 固定包装器只暴露一个工具，不转交宿主Context，不运行patch，也不公开上游helper/client。 */
function runtimeWrapper(recipe: DshBuildRecipe, toolId: string): string {
  return `import { apply, inject } from ${JSON.stringify(recipe.entry)};
import { createDshRegistrationScope } from ${JSON.stringify(ADAPTER)};
const expected = ${JSON.stringify({ pluginId: recipe.plugin.id, upstreamName: recipe.tool.upstreamName, inputSchema: recipe.tool.inputSchema })};
const canonical = value => Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object' ? Object.fromEntries(Object.entries(value).sort(([a],[b]) => a < b ? -1 : a > b ? 1 : 0).map(([key, child]) => [key, canonical(child)])) : value;
let scope;
export default {
  async activate(host) {
    if (scope || host.plugin.id !== expected.pluginId) throw new Error('DSH_ACTIVATION_INVALID');
    const current = createDshRegistrationScope(expected.pluginId, inject);
    scope = current;
    let open = true;
    let registrations = 0;
    const tools = Object.freeze({ register(definition) {
      if (!open || registrations++ !== 0) throw new Error('DSH_REGISTRATION_UNEXPECTED');
      return current.context.tools.register(definition);
    } });
    try {
      await apply(Object.freeze({ tools }));
      open = false;
      const registered = current.list();
      if (scope !== current || registrations !== 1 || registered.length !== 1 || registered[0].upstreamName !== expected.upstreamName
        || JSON.stringify(canonical(registered[0].inputSchema)) !== JSON.stringify(canonical(expected.inputSchema))) throw new Error('DSH_REGISTRATION_UNEXPECTED');
      host.tools.handle(${JSON.stringify(toolId)}, (input, call) => registered[0].invoke(input, { signal: call.signal, deadline: call.deadline }));
    } catch {
      open = false; current.dispose(); if (scope === current) scope = undefined;
      throw new Error('DSH_ACTIVATION_FAILED');
    }
  },
  deactivate() { const current = scope; scope = undefined; current?.dispose(); }
};\n`
}

/**
 * 只接受开发侧登记的审查配方和已核验归档的字节；不下载、不安装、不import源模块。
 * 编译器属于可信工具链，必须拒绝图外解析并报告真实inputs/imports；本接口不是沙箱。
 * signingKey省略即开发包；提供签名不等于发布者受信任，也不会安装或启用产物。
 */
export async function buildDshToolPackage(recipe: DshBuildRecipe, archiveHash: string, files: ReadonlyMap<string, Uint8Array>, adapter: Uint8Array, compile: DshBundleCompiler, signingKey?: KeyObject): Promise<DshBuiltPackage> {
  const serialized = JSON.stringify(recipe)
  if (Buffer.byteLength(serialized) > 256 * 1024 || recipe.formatVersion !== 1 || !/^[a-f0-9]{64}$/.test(recipe.source.archiveSha256)
    || !/^[a-f0-9]{64}$/.test(recipe.adapter.sha256) || recipe.adapter.license !== 'AGPL-3.0-only'
    || !recipe.source.files['package.json'] || !recipe.source.files.LICENSE || Object.keys(recipe.source.files).length > 64
    || !/^[a-z][a-z0-9_]{0,63}$/.test(recipe.tool.upstreamName)) reject()
  // 快照审查数据，防止await编译期间调用方修改清单/许可/身份。
  recipe = JSON.parse(serialized) as DshBuildRecipe
  if (archiveHash !== recipe.source.archiveSha256) reject('DSH_BUILD_SOURCE_CHANGED')
  if (adapter.byteLength > 1024 * 1024 || hashPluginBytes(adapter) !== recipe.adapter.sha256) reject('DSH_BUILD_ADAPTER_CHANGED')
  const selected = new Map<string, Uint8Array>()
  for (const [path, hash] of Object.entries(recipe.source.files)) {
    if (!safePath(path) || !/^[a-f0-9]{64}$/.test(hash)) reject()
    const bytes = files.get(path)
    if (!bytes || bytes.byteLength > 4 * 1024 * 1024 || hashPluginBytes(bytes) !== hash) reject('DSH_BUILD_SOURCE_CHANGED')
    selected.set(path, new Uint8Array(bytes))
  }
  let metadata: Record<string, unknown>
  try { metadata = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(selected.get('package.json'))) as Record<string, unknown> } catch { return reject('DSH_BUILD_SOURCE_CHANGED') }
  if (!metadata || metadata.name !== recipe.source.name || metadata.version !== recipe.source.version || metadata.license !== recipe.source.license) reject('DSH_BUILD_SOURCE_CHANGED')
  let sourceUrl: URL
  try { sourceUrl = new URL(recipe.source.url) } catch { return reject() }
  if (sourceUrl.origin !== 'https://registry.npmjs.org' || sourceUrl.username || sourceUrl.password || sourceUrl.search || sourceUrl.hash) reject()
  const runtimePaths = Object.keys(recipe.imports)
  if (!runtimePaths.length || runtimePaths.length > 32 || !Object.hasOwn(recipe.imports, recipe.entry)) reject()
  const modules = new Map<string, Uint8Array>()
  const imports: Record<string, Record<string, string>> = {}
  for (const path of runtimePaths) {
    if (!safePath(path) || !path.endsWith('.js') || !selected.has(path)) reject()
    const mapping = recipe.imports[path]!
    if (Object.keys(mapping).length > 32) reject()
    for (const [specifier, target] of Object.entries(mapping)) {
      if (specifier === '@deepseek-ai/dsh-tools') { if (target !== DEFINE) reject() }
      else if (!specifier.startsWith('./') || !Object.hasOwn(recipe.imports, target)) reject()
    }
    modules.set(path, selected.get(path)!)
    imports[path] = { ...mapping }
  }
  const toolId = recipe.tool.upstreamName.replaceAll('_', '-')
  const manifest = {
    formatVersion: 3, apiVersion: '1.0.0', id: recipe.plugin.id, publisherId: recipe.plugin.id.split('.')[0], version: recipe.plugin.version,
    displayName: recipe.plugin.title, description: recipe.plugin.description, license: 'AGPL-3.0-only', profile: 'module-runtime',
    compatibility: { hostApi: '^1.0.0', runtimeProtocol: 2, platforms: ['darwin', 'win32', 'linux'], architectures: ['arm64', 'x64'] },
    runtime: { entry: 'runtime/main.mjs', format: 'module-esm' },
    modules: [{ id: 'tool', displayName: recipe.plugin.title, description: recipe.plugin.description, icon: 'calculator', activation: 'message-explicit', skillRefs: [], promptRefs: [], tools: [toolId], surfaces: [], services: [], artifacts: [] }],
    tools: [{ id: toolId, ownerModuleId: 'tool', title: recipe.plugin.title, description: recipe.plugin.description, inputSchema: recipe.tool.inputSchema,
      annotations: { readOnly: true, destructive: false, idempotent: true, openWorld: false }, approval: 'per-call', timeoutMs: 30000 }],
    surfaces: [], services: [], artifacts: [], prompts: [], settings: [], capabilities: [], dependencies: [], exports: [],
  }
  if (!parsePluginManifestV3(manifest).ok) reject()
  modules.set(ADAPTER, new Uint8Array(adapter)); imports[ADAPTER] = {}
  // defineTool只是身份传递：所有形状、schema、输入输出边界由实际register适配器验证。
  modules.set(DEFINE, encode('export const defineTool = definition => definition;\n')); imports[DEFINE] = {}
  modules.set(RUNTIME, encode(runtimeWrapper(recipe, toolId))); imports[RUNTIME] = { [recipe.entry]: recipe.entry, [ADAPTER]: ADAPTER }
  const built = await compile({ entry: RUNTIME, modules, imports })
  if (!built.code.byteLength || built.code.byteLength > 4 * 1024 * 1024 || built.imports.length || !built.inputs.includes(RUNTIME)
    || built.inputs.some(path => !modules.has(path))) reject('DSH_BUILD_NOT_SELF_CONTAINED')
  const recipeHash = hashPluginBytes(encode(serialized))
  const sourceLicense = new TextDecoder('utf-8', { fatal: true }).decode(selected.get('LICENSE'))
  const output = new Map<string, Uint8Array>([
    ['plugin.json', encode(JSON.stringify(manifest, null, 2))], ['runtime/main.mjs', new Uint8Array(built.code)],
    ['LICENSE', encode(`派生工具限定构建：AGPL-3.0-only（DutyDeck适配器）；上游部分：${recipe.source.license}。\n\n${readFileSync(new URL('../../LICENSE', import.meta.url), 'utf8')}\n\n上游许可原文：\n${sourceLicense}`)],
    ['README.md', encode(`# ${recipe.plugin.title}\n\n${recipe.plugin.description}\n\n这是固定来源工具限定转换，不是原包兼容或上游作者签名。\n${recipe.limitations.map(value => `- ${value}`).join('\n')}\n`)],
    ['CHANGELOG.md', encode(`# 转换记录\n\n## ${recipe.plugin.version}\n\n配方 ${recipe.recipeId}@${recipe.recipeVersion}；适配器 ${recipe.adapter.version}。\n`)],
    ['THIRD_PARTY_NOTICES.md', encode(`# 工具限定转换证据\n\n来源：${recipe.source.name}@${recipe.source.version}\nURL：${recipe.source.url}\n归档SHA256：${archiveHash}\n配方SHA256：${recipeHash}\n\n原依赖闭包仍为unresolved；仅替换本配方声明的接口，排除客户端与原宿主。转换方签名不代表上游作者认可。\n\n固定配方：\n\n\`\`\`json\n${JSON.stringify(recipe, null, 2)}\n\`\`\`\n\n上游许可原文：\n${sourceLicense}`)],
  ])
  const bytes = createPluginPackage(output, signingKey)
  const inspection = inspectPluginPackage(bytes)
  return { bytes, recipeHash, packageHash: inspection.packageHash }
}
