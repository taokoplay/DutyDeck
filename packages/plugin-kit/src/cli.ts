#!/usr/bin/env node
import { createPrivateKey, generateKeyPairSync } from 'node:crypto'
import { statSync, realpathSync } from 'node:fs'
import { join } from 'node:path'
import { createModuleRuntimePluginFiles, createStandardPluginFiles } from './scaffold.js'
import { buildModuleRuntimePlugin } from './build.js'
import { createPluginPackage, hashPluginBytes, inspectPluginPackage } from './package.js'
import { collectPluginSource, createNewDirectory, readBoundedFile, writeNewFile, writeScaffold } from './filesystem.js'

/** 明确参数白名单，防止拼错发布参数时默默生成开发包。 */
interface Arguments { positional: string[]; options: Map<string, string | true> }
/** 解析命令尾部参数；重复、未知和缺值参数都失败。 */
function parseArguments(values: string[], allowed: ReadonlySet<string>): Arguments {
  const positional: string[] = []
  const options = new Map<string, string | true>()
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index]!
    if (!value.startsWith('--')) { positional.push(value); continue }
    if (!allowed.has(value) || options.has(value)) throw new Error(`PLUGIN_CLI_OPTION_INVALID:${value}`)
    if (value === '--release' || value === '--development') options.set(value, true)
    else {
      const next = values[++index]
      if (!next || next.startsWith('--')) throw new Error(`PLUGIN_CLI_OPTION_VALUE_REQUIRED:${value}`)
      options.set(value, next)
    }
  }
  return { positional, options }
}
/** 读取必填字符串选项，缺失立即报错。 */
function required(options: Arguments['options'], name: string): string {
  const value = options.get(name)
  if (typeof value !== 'string') throw new Error(`PLUGIN_CLI_OPTION_REQUIRED:${name}`)
  return value
}
/** 独立 CLI 入口；仅输出包摘要/指纹，不输出私钥或执行作者脚本。 */
function main(values: string[]): void {
  const command = values.shift()
  const publisher = command === 'publisher' ? values.shift() : undefined
  const allowed = command === 'init' ? ['--id', '--name', '--profile'] : command === 'pack' ? ['--out', '--release', '--config-dir']
    : command === 'verify' ? ['--development', '--trusted-key'] : command === 'publisher' ? ['--config-dir'] : []
  const { positional, options } = parseArguments(values, new Set(allowed))
  if (command === 'publisher' && publisher === 'init' && positional.length === 0) {
    const root = createNewDirectory(required(options, '--config-dir'))
    const pair = generateKeyPairSync('ed25519')
    writeNewFile(join(root, 'publisher-key.pem'), Buffer.from(pair.privateKey.export({ type: 'pkcs8', format: 'pem' })))
    const keyId = hashPluginBytes(pair.publicKey.export({ type: 'spki', format: 'der' }))
    process.stdout.write(`${JSON.stringify({ keyId })}\n`)
    return
  }
  if (positional.length !== 1) throw new Error('用法: dutydeck-plugin init DIR --id publisher.plugin [--profile module-runtime] | build DIR | validate DIR | test DIR | pack DIR --out FILE [--release --config-dir DIR] | verify FILE --development/--trusted-key HASH | publisher init --config-dir DIR')
  const target = positional[0]!
  if (command === 'init') {
    const id = required(options, '--id')
    const name = typeof options.get('--name') === 'string' ? options.get('--name') as string : id
    const profile = options.get('--profile')
    if (profile !== undefined && profile !== 'content' && profile !== 'module-runtime') {
      throw new Error('PLUGIN_PROFILE_UNSUPPORTED')
    }
    writeScaffold(target, profile === 'module-runtime'
      ? createModuleRuntimePluginFiles(id, name)
      : createStandardPluginFiles(id, name))
    process.stdout.write(profile === 'module-runtime' ? 'V3 module-runtime 插件脚手架已创建。\n' : '标准插件脚手架已创建。\n')
  } else if (command === 'build') {
    const result = buildModuleRuntimePlugin(target)
    process.stdout.write(`${JSON.stringify({ runtimeFiles: result.runtimeFiles, surfaceFiles: result.surfaceFiles })}\n`)
  } else if (command === 'validate' || command === 'test' || command === 'pack') {
    const source = collectPluginSource(target)
    let key: ReturnType<typeof createPrivateKey> | undefined
    if (options.has('--release')) {
      const path = join(realpathSync(required(options, '--config-dir')), 'publisher-key.pem')
      if (process.platform !== 'win32' && (statSync(path).mode & 0o077) !== 0) throw new Error('PLUGIN_SIGNER_PERMISSIONS_INVALID')
      key = createPrivateKey(readBoundedFile(path, 16 * 1024))
    } else if (options.has('--config-dir')) throw new Error('PLUGIN_RELEASE_FLAG_REQUIRED')
    const bytes = createPluginPackage(source, key)
    const inspected = inspectPluginPackage(bytes)
    if (command === 'pack') writeNewFile(required(options, '--out'), bytes)
    process.stdout.write(`${JSON.stringify({ id: inspected.manifest.id, version: inspected.manifest.version, mode: key ? 'release' : 'development', packageHash: inspected.packageHash, keyId: inspected.signer?.keyId, checks: 'manifest,resources,archive,integrity' })}\n`)
  } else if (command === 'verify') {
    if (options.has('--development') && options.has('--trusted-key')) throw new Error('PLUGIN_VERIFY_MODE_CONFLICT')
    const inspected = inspectPluginPackage(readBoundedFile(target, 50 * 1024 * 1024))
    if (!options.has('--development') && (!inspected.signer || inspected.signer.keyId !== required(options, '--trusted-key'))) throw new Error('PLUGIN_SIGNER_NOT_TRUSTED')
    process.stdout.write(`${JSON.stringify({ id: inspected.manifest.id, packageHash: inspected.packageHash, signatureVerified: inspected.signatureVerified, trusted: !options.has('--development'), keyId: inspected.signer?.keyId })}\n`)
  } else throw new Error('PLUGIN_CLI_COMMAND_UNKNOWN')
}
try { main(process.argv.slice(2)) }
catch (error) { process.stderr.write(`${error instanceof Error ? error.message : 'PLUGIN_CLI_FAILED'}\n`); process.exitCode = 1 }
