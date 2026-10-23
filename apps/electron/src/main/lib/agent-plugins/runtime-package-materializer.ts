import { existsSync, lstatSync, mkdirSync, realpathSync } from 'node:fs'
import { readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { dirname, join, resolve } from 'node:path'
import { isPluginResourcePath } from '@dutydeck/plugin-sdk'
import type { PluginV3Manifest } from '@dutydeck/plugin-sdk'
import { writeNewFile } from '@dutydeck/plugin-kit/filesystem'

/** 已验证 V3 包的展开输入。 */
export interface MaterializeRuntimePluginInput {
  root: string
  manifest: PluginV3Manifest
  packageHash: string
  files: ReadonlyMap<string, Uint8Array>
}

/** 展开后的不可变包目录与提示正文。 */
export interface MaterializedRuntimePlugin {
  packageRoot: string
  prompts: Record<string, string>
}

/** 确保路径不存在符号链接，且每一级父目录都是真实目录。 */
function assertRealDirectory(path: string): void {
  const absolute = resolve(path)
  const stat = lstatSync(absolute)
  if (!stat.isDirectory() || stat.isSymbolicLink() || realpathSync(absolute) !== absolute) {
    throw new Error('PLUGIN_PACKAGE_DIRECTORY_UNSAFE')
  }
}

/**
 * 把已通过签名/资源校验的文件写入不可变版本目录。
 * @param input 隔离根、V3 清单、包 hash 与校验后文件集合。
 * @returns 运行时包根与可在 Session 激活时注入的提示正文。
 */
export function materializeRuntimePluginPackage(input: MaterializeRuntimePluginInput): MaterializedRuntimePlugin {
  if (!/^[a-f0-9]{64}$/.test(input.packageHash)) throw new Error('PLUGIN_PACKAGE_HASH_INVALID')
  const root = realpathSync(resolve(input.root))
  assertRealDirectory(root)
  const packages = join(root, 'packages')
  if (!existsSync(packages)) mkdirSync(packages, { recursive: true, mode: 0o700 })
  assertRealDirectory(packages)
  const pluginDirectory = join(packages, input.manifest.id)
  if (!existsSync(pluginDirectory)) mkdirSync(pluginDirectory, { recursive: true, mode: 0o700 })
  assertRealDirectory(pluginDirectory)
  const versionDirectory = join(pluginDirectory, input.manifest.version)
  if (!existsSync(versionDirectory)) mkdirSync(versionDirectory, { recursive: true, mode: 0o700 })
  assertRealDirectory(versionDirectory)
  const packageRoot = join(versionDirectory, input.packageHash)
  if (existsSync(packageRoot)) {
    assertRealDirectory(packageRoot)
    for (const [path, bytes] of input.files) {
      const file = join(packageRoot, path)
      const stat = lstatSync(file)
      if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('PLUGIN_PACKAGE_MATERIALIZED_MISMATCH')
      const actual = readFileSync(file)
      if (actual.byteLength !== bytes.byteLength
        || createHash('sha256').update(actual).digest('hex') !== createHash('sha256').update(bytes).digest('hex')) {
        throw new Error('PLUGIN_PACKAGE_MATERIALIZED_MISMATCH')
      }
    }
    return { packageRoot, prompts: readPromptCatalog(input) }
  }
  mkdirSync(packageRoot, { mode: 0o700 })
  assertRealDirectory(packageRoot)

  let total = 0
  for (const [path, bytes] of [...input.files].sort(([left], [right]) => left.localeCompare(right))) {
    if (!isPluginResourcePath(path)) throw new Error(`PLUGIN_PACKAGE_PATH_INVALID:${path}`)
    total += bytes.byteLength
    if (total > 200 * 1024 * 1024) throw new Error('PLUGIN_PACKAGE_EXPANSION_LIMIT')
    const destination = join(packageRoot, path)
    const parent = dirname(destination)
    mkdirSync(parent, { recursive: true, mode: 0o700 })
    assertRealDirectory(parent)
    writeNewFile(destination, bytes)
  }

  return { packageRoot, prompts: readPromptCatalog(input) }
}

/** 从同一份已验证字节提取提示正文，供 Session 激活时按需注入。 */
function readPromptCatalog(input: MaterializeRuntimePluginInput): Record<string, string> {
  const prompts: Record<string, string> = {}
  for (const prompt of input.manifest.prompts) {
    const bytes = input.files.get(prompt.path)
    if (!bytes) throw new Error(`PLUGIN_PROMPT_MISSING:${prompt.id}`)
    try {
      prompts[`${input.manifest.id}/prompts/${prompt.id}`] = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
    } catch {
      throw new Error(`PLUGIN_PROMPT_INVALID_UTF8:${prompt.id}`)
    }
  }
  return prompts
}
