import { createHash } from 'node:crypto'

export interface DshDependencyDisposition {
  group: 'dependencies' | 'optionalDependencies' | 'peerDependencies'
  name: string
  specifier: string
  treatment: 'limited-tool-adapter' | 'registration-lifecycle' | 'excluded-client'
  reason: string
}
export interface DshToolClosureRecipe {
  name: string; version: string; packageHash: string; license: string; entry: string
  files: Record<string, string>
  runtimeFiles: readonly string[]
  dependencies: readonly DshDependencyDisposition[]
}
interface DshClosureResult { scope: 'tool-only-conversion'; originalDependencyClosure: 'unresolved'; runtimeFiles: string[] }
const GROUPS = ['dependencies', 'optionalDependencies', 'peerDependencies'] as const
function object(value: unknown): value is Record<string, unknown> { return Boolean(value && typeof value === 'object' && !Array.isArray(value)) }
function fail(code: string): never { throw new Error(code) }
function safePath(path: string): boolean { return path.length <= 256 && !/[\\\\:\x00-\x1f]/.test(path) && path.split('/').every(part => part && part !== '.' && part !== '..') }

/**
 * 只校验宿主静态登记配方的证据，不从renderer接收配方，不解析/执行JS来猜依赖。
 * 已审查的可达文件清单必须逐字节匹配；原包未选择的client/运行时依赖仍不标兼容。
 * 调用方须先完成归档完整性核验，这里的packageHash是该实际归档hash。
 */
export function verifyDshToolClosure(recipe: DshToolClosureRecipe, packageHash: string, files: ReadonlyMap<string, Uint8Array>): DshClosureResult {
  if (!/^[a-f0-9]{64}$/.test(recipe.packageHash) || Object.keys(recipe.files).length > 64 || !recipe.files['package.json'] || !recipe.files.LICENSE
    || recipe.runtimeFiles.length < 1 || recipe.runtimeFiles.length > 32 || new Set(recipe.runtimeFiles).size !== recipe.runtimeFiles.length
    || !recipe.runtimeFiles.includes(recipe.entry) || recipe.dependencies.length > 128
    || recipe.runtimeFiles.some(path => !safePath(path) || !path.endsWith('.js') || !recipe.files[path])) fail('DSH_CLOSURE_RECIPE_INVALID')
  if (packageHash !== recipe.packageHash) fail('DSH_CLOSURE_SOURCE_CHANGED')
  for (const [path, expected] of Object.entries(recipe.files)) {
    if (!safePath(path) || !/^[a-f0-9]{64}$/.test(expected)) fail('DSH_CLOSURE_RECIPE_INVALID')
    const bytes = files.get(path)
    if (!bytes || bytes.byteLength > 4 * 1024 * 1024 || createHash('sha256').update(bytes).digest('hex') !== expected) fail('DSH_CLOSURE_SOURCE_CHANGED')
  }
  if ([...files.keys()].some(path => /(^|\/)node_modules\/|(^|\/)binding\.gyp$|\.(node|dll|dylib|so)$/i.test(path))) fail('DSH_CLOSURE_UNSUPPORTED')
  let manifest: unknown
  try { manifest = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(files.get('package.json')!)) } catch { fail('DSH_CLOSURE_SOURCE_CHANGED') }
  if (!object(manifest) || manifest.name !== recipe.name || manifest.version !== recipe.version || manifest.license !== recipe.license) fail('DSH_CLOSURE_SOURCE_CHANGED')
  for (const key of ['bundledDependencies', 'bundleDependencies']) {
    const value = manifest[key]
    if (value !== undefined && value !== false && !(Array.isArray(value) && value.length === 0)) fail('DSH_CLOSURE_UNSUPPORTED')
  }
  if (manifest.scripts !== undefined && (!object(manifest.scripts) || ['preinstall', 'install', 'postinstall', 'prepare'].some(key => Object.hasOwn(manifest.scripts as object, key)))) fail('DSH_CLOSURE_UNSUPPORTED')
  const dispositions = new Map<string, DshDependencyDisposition>()
  for (const item of recipe.dependencies) {
    const key = `${item.group}:${item.name}`
    if (!GROUPS.includes(item.group) || !item.reason || !item.specifier || dispositions.has(key)
      || !['limited-tool-adapter', 'registration-lifecycle', 'excluded-client'].includes(item.treatment)) fail('DSH_CLOSURE_RECIPE_INVALID')
    dispositions.set(key, item)
  }
  for (const group of GROUPS) {
    const declarations = manifest[group] === undefined ? {} : manifest[group]
    if (!object(declarations) || Object.keys(declarations).length > 128) fail('DSH_CLOSURE_UNRESOLVED')
    for (const [name, specifier] of Object.entries(declarations)) {
      const key = `${group}:${name}`
      if (typeof specifier !== 'string' || dispositions.get(key)?.specifier !== specifier) fail('DSH_CLOSURE_UNRESOLVED')
      dispositions.delete(key)
    }
  }
  if (dispositions.size) fail('DSH_CLOSURE_UNRESOLVED')
  return { scope: 'tool-only-conversion', originalDependencyClosure: 'unresolved', runtimeFiles: [...recipe.runtimeFiles] }
}
