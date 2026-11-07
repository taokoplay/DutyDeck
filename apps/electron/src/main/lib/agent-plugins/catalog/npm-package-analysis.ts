import { createHash, timingSafeEqual } from 'node:crypto'
import { gunzipSync } from 'node:zlib'
import type { PluginPackageEvidence } from '@dutydeck/shared'

const MAX_ARCHIVE = 16 * 1024 * 1024
const MAX_UNPACKED = 32 * 1024 * 1024
const MAX_FILE = 4 * 1024 * 1024
const decoder = new TextDecoder('utf-8', { fatal: true })
const NAME = /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/
const VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/
function reject(code = 'PLUGIN_PACKAGE_ARCHIVE_UNSUPPORTED'): never { throw new Error(code) }
function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return reject('PLUGIN_PACKAGE_METADATA_INVALID')
  return value as Record<string, unknown>
}
function json(bytes: Buffer): Record<string, unknown> {
  if (bytes.length > 1024 * 1024) return reject('PLUGIN_PACKAGE_METADATA_TOO_LARGE')
  try { return record(JSON.parse(decoder.decode(bytes))) } catch { return reject('PLUGIN_PACKAGE_METADATA_INVALID') }
}
function field(bytes: Buffer): string {
  const nul = bytes.indexOf(0)
  if (nul !== -1 && bytes.subarray(nul).some(value => value !== 0)) return reject()
  try { return decoder.decode(nul === -1 ? bytes : bytes.subarray(0, nul)) } catch { return reject() }
}
function octal(bytes: Buffer): number {
  const value = bytes.toString('ascii').replace(/[\0 ]+$/g, '').trim()
  if (!/^[0-7]+$/.test(value)) return reject()
  const parsed = Number.parseInt(value, 8)
  if (!Number.isSafeInteger(parsed)) return reject()
  return parsed
}

/** 仅支持有界普通USTAR文件/目录。PAX/GNU扩展、链接、设备一律拒绝；从不写磁盘。 */
export function readNpmTarball(bytes: Buffer): ReadonlyMap<string, Buffer> {
  if (bytes.length > MAX_ARCHIVE) return reject('PLUGIN_PACKAGE_TOO_LARGE')
  let tar: Buffer
  try { tar = gunzipSync(bytes, { maxOutputLength: MAX_UNPACKED }) } catch { return reject('PLUGIN_PACKAGE_ARCHIVE_INVALID') }
  if (tar.length % 512 !== 0) return reject()
  const files = new Map<string, Buffer>(); const paths = new Set<string>()
  let offset = 0; let ended = false
  while (offset + 512 <= tar.length) {
    const header = tar.subarray(offset, offset + 512)
    if (header.every(value => value === 0)) {
      if (offset + 1024 > tar.length || tar.subarray(offset).some(value => value !== 0)) return reject()
      ended = true; break
    }
    if (paths.size >= 2000) return reject('PLUGIN_PACKAGE_TOO_MANY_FILES')
    const checksum = octal(header.subarray(148, 156))
    const actual = header.reduce((total, value, index) => total + (index >= 148 && index < 156 ? 32 : value), 0)
    if (checksum !== actual || field(header.subarray(257, 263)).trim() !== 'ustar') return reject()
    const prefix = field(header.subarray(345, 500))
    let path = [prefix, field(header.subarray(0, 100))].filter(Boolean).join('/')
    const type = header[156]
    if (![0, 48, 53].includes(type ?? -1) || field(header.subarray(157, 257))) return reject()
    if (type === 53 && path.endsWith('/')) path = path.slice(0, -1)
    if (path.length > 1024 || /[\\\x00-\x1f\x7f:]/.test(path) || !path.startsWith('package/') && path !== 'package') return reject()
    const parts = path.split('/')
    if (parts.some(part => !part || part === '.' || part === '..') || paths.has(path)) return reject()
    if (path === 'package' && type !== 53) return reject()
    paths.add(path)
    const size = octal(header.subarray(124, 136))
    if (size > MAX_FILE || type === 53 && size !== 0) return reject('PLUGIN_PACKAGE_FILE_TOO_LARGE')
    const end = offset + 512 + size
    const padded = offset + 512 + Math.ceil(size / 512) * 512
    if (padded > tar.length || tar.subarray(end, padded).some(value => value !== 0)) return reject()
    if (type !== 53) files.set(path.slice('package/'.length), tar.subarray(offset + 512, end))
    offset = padded
  }
  if (!ended) return reject()
  return files
}

function declarations(value: unknown): Record<string, string> {
  if (value === undefined) return {}
  const source = record(value)
  if (Object.keys(source).length > 256) return reject('PLUGIN_PACKAGE_DEPENDENCIES_TOO_LARGE')
  return Object.fromEntries(Object.entries(source).map(([key, spec]) => {
    if (key.length > 214 || !NAME.test(key) || typeof spec !== 'string' || spec.length > 512 || /[\x00-\x1f]/.test(spec)) return reject('PLUGIN_PACKAGE_METADATA_INVALID')
    return [key, spec]
  }))
}
/** npm支持boolean与包名数组；两种拼写均校验，空数组不代表存在运行依赖。 */
function hasBundledDependencies(value: unknown): boolean {
  if (value === undefined || value === false) return false
  if (value === true) return true
  if (!Array.isArray(value) || value.length > 256 || value.some(name => typeof name !== 'string' || name.length > 214 || !NAME.test(name))) return reject('PLUGIN_PACKAGE_METADATA_INVALID')
  return value.length > 0
}
function integrity(bytes: Buffer, dist: Record<string, unknown>): PluginPackageEvidence['integrity'] {
  let algorithm: 'sha512' | 'sha1' | null = null
  let expected: Buffer | undefined
  let source: string | null = null
  if (dist.integrity !== undefined) {
    if (typeof dist.integrity !== 'string' || dist.integrity.length > 1024) return reject('PLUGIN_PACKAGE_INTEGRITY_INVALID')
    const match = /^sha512-([A-Za-z0-9+/]{86}==)$/.exec(dist.integrity)
    if (!match) return reject('PLUGIN_PACKAGE_INTEGRITY_UNSUPPORTED')
    algorithm = 'sha512'; expected = Buffer.from(match[1]!, 'base64'); source = dist.integrity
  } else if (dist.shasum !== undefined) {
    if (typeof dist.shasum !== 'string' || !/^[a-f0-9]{40}$/.test(dist.shasum)) return reject('PLUGIN_PACKAGE_INTEGRITY_INVALID')
    algorithm = 'sha1'; expected = Buffer.from(dist.shasum, 'hex'); source = dist.shasum
  }
  if (!algorithm || !expected) return { status: 'missing', algorithm: null, source: null }
  const actual = createHash(algorithm).update(bytes).digest()
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) return reject('PLUGIN_PACKAGE_INTEGRITY_MISMATCH')
  return { status: 'matched', algorithm, source }
}

/** 公共npm固定版本路线；索引不得提供任意包下载地址或版本范围。 */
export async function analyzeNpmPackage(
  name: string, version: string, download: (url: string, kind: 'json' | 'tarball') => Promise<Buffer>,
): Promise<PluginPackageEvidence> {
  if (name.length > 214 || !NAME.test(name) || version.length > 128 || !VERSION.test(version)) return reject('PLUGIN_PACKAGE_IDENTITY_INVALID')
  const registryUrl = `https://registry.npmjs.org/${encodeURIComponent(name)}/${encodeURIComponent(version)}`
  const metadata = json(await download(registryUrl, 'json'))
  if (metadata.name !== name || metadata.version !== version) return reject('PLUGIN_PACKAGE_IDENTITY_MISMATCH')
  const dist = record(metadata.dist)
  if (typeof dist.tarball !== 'string' || dist.tarball.length > 2048) return reject('PLUGIN_PACKAGE_URL_INVALID')
  let target: URL
  try { target = new URL(dist.tarball) } catch { return reject('PLUGIN_PACKAGE_URL_INVALID') }
  if (target.origin !== 'https://registry.npmjs.org' || target.username || target.password || target.search || target.hash) return reject('PLUGIN_PACKAGE_URL_INVALID')
  const bytes = await download(target.href, 'tarball')
  if (bytes.length > MAX_ARCHIVE) return reject('PLUGIN_PACKAGE_TOO_LARGE')
  const integrityEvidence = integrity(bytes, dist)
  const files = readNpmTarball(bytes)
  const manifest = files.get('package.json')
  if (!manifest) return reject('PLUGIN_PACKAGE_MANIFEST_MISSING')
  const pkg = json(manifest)
  if (pkg.name !== name || pkg.version !== version) return reject('PLUGIN_PACKAGE_IDENTITY_MISMATCH')
  const dependencyDeclarations = Object.fromEntries(['dependencies', 'optionalDependencies', 'peerDependencies', 'devDependencies'].map(key => [key, declarations(pkg[key])]))
  const dependencies = { ...dependencyDeclarations.dependencies, ...dependencyDeclarations.optionalDependencies, ...dependencyDeclarations.peerDependencies }
  const bundled = hasBundledDependencies(pkg.bundledDependencies)
  const bundledAlias = hasBundledDependencies(pkg.bundleDependencies)
  const unresolved = Object.keys(dependencies).length > 0 || bundled || bundledAlias
  const license = typeof pkg.license === 'string' && pkg.license.length <= 512 && !/[\x00-\x1f]/.test(pkg.license) ? pkg.license : null
  const paths = [...files.keys()]
  const blockers: string[] = []
  if (integrityEvidence.status === 'missing') blockers.push('INTEGRITY_MISSING')
  if (!license) blockers.push('LICENSE_UNKNOWN')
  if (unresolved) blockers.push('DEPENDENCY_CLOSURE_UNRESOLVED')
  const scripts = pkg.scripts === undefined ? {} : record(pkg.scripts)
  if (['preinstall', 'install', 'postinstall', 'prepare'].some(key => Object.hasOwn(scripts, key))) blockers.push('INSTALL_SCRIPTS')
  if (paths.some(path => /(?:^|\/)(?:binding\.gyp|node_modules)(?:\/|$)|\.(?:node|dll|dylib|so|exe)$/i.test(path))) blockers.push('NATIVE_OR_BUNDLED_RUNTIME')
  const patches = paths.filter(path => /(?:^|\/)cordis\.patch\.ya?ml$/i.test(path))
  for (const path of patches) {
    let patch: string
    try { patch = decoder.decode(files.get(path)!) } catch { return reject('PLUGIN_PACKAGE_PATCH_INVALID') }
    if (/!!js\b|!<[^>]+>|!!(?:js\/)?(?:function|regexp)/i.test(patch)) blockers.push('DYNAMIC_PATCH')
  }
  const reasons = [
    '此结果来自精确版本的包字节与package.json；只在内存静态读取，没有安装、求值或运行入口。',
    '许可证字段和依赖是上游声明，完整性匹配只证明与该registry元数据一致，不代表安全审计或作者签名。',
    unresolved ? '运行/可选/peer依赖闭包尚未解析或核验，禁止按此结果启用或转换。' : '未声明运行依赖，不等于源码没有动态依赖；仍需固定配方与代码审查。',
    '目前不提供自动可转换/已验证判定；Cordis服务、动态schema、UI与运行循环语义须由固定配方逐项核对。',
  ]
  return {
    name, version, registryUrl, tarballUrl: target.href, analyzedAt: new Date().toISOString(),
    packageHash: createHash('sha256').update(bytes).digest('hex'), integrity: integrityEvidence, license,
    licenseFiles: paths.filter(path => /(?:^|\/)(?:license|licence|copying)(?:\.[^/]*)?$/i.test(path)).slice(0, 64),
    dependencies, dependencyDeclarations, dependencyClosure: unresolved ? 'unresolved' : 'none',
    fileCount: files.size, unpackedBytes: [...files.values()].reduce((total, value) => total + value.length, 0),
    contentCandidates: paths.filter(path => /(?:^|\/)(?:SKILL\.md|prompts\/[^/]+\.md)$/i.test(path)).slice(0, 64),
    blockers: [...new Set(blockers)], status: blockers.length ? 'unsupported' : 'unassessed', reasons,
  }
}
