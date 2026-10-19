import { createHash, createPublicKey, sign, verify } from 'node:crypto'
import type { KeyObject } from 'node:crypto'
import { parsePluginManifest, validatePluginResources } from '@dutydeck/plugin-sdk'
import type { PluginPackageManifest, ValidatedPluginResources } from '@dutydeck/plugin-sdk'
import { createPluginArchive, readPluginArchive } from './archive.js'

/** 发布者证明只确认签名，是否信任由宿主或独立信任库决定。 */
export interface PluginSigner { keyId: string; publicKey: string }
/** 已验证数学完整性的安装候选，不能据此跳过用户来源信任。 */
export interface InspectedPluginPackage {
  manifest: PluginPackageManifest
  files: Map<string, Uint8Array>
  resources: ValidatedPluginResources
  packageHash: string
  signatureVerified: boolean
  signer?: PluginSigner
}
/** 完整性列表中的一个载荷。 */
interface IntegrityFile { path: string; bytes: number; sha256: string }
/** 包工具实际允许交付的根文件。 */
const ROOT_FILES = new Set(['plugin.json', 'README.md', 'LICENSE', 'CHANGELOG.md', 'THIRD_PARTY_NOTICES.md'])
/** 可携带资源的目录及静态扩展；可执行入口不属于本版协议。 */
const RESOURCE_FILE = /^(skills|prompts|styles|resources|assets)\/.*\.(md|txt|json|png|jpg|jpeg|webp|gif|svg)$/i

/** 返回 SHA-256 十六进制摘要；只描述字节一致性。 */
export function hashPluginBytes(bytes: Uint8Array): string { return createHash('sha256').update(bytes).digest('hex') }

/** 严格 JSON 读取保留文件位置，不把解析失败当缺省值。 */
function readJson(files: ReadonlyMap<string, Uint8Array>, path: string): unknown {
  const bytes = files.get(path)
  if (!bytes || bytes.byteLength > 1024 * 1024) throw new Error(`PLUGIN_JSON_INVALID:${path}`)
  try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) as unknown }
  catch { throw new Error(`PLUGIN_JSON_INVALID:${path}`) }
}

/** 校验纯清单与正文，复用公开 SDK 的唯一合同。 */
function validatePayload(files: ReadonlyMap<string, Uint8Array>): { manifest: PluginPackageManifest; resources: ValidatedPluginResources } {
  for (const path of ROOT_FILES) if (!files.get(path)?.byteLength) throw new Error(`PLUGIN_REQUIRED_FILE_MISSING:${path}`)
  const parsed = parsePluginManifest(readJson(files, 'plugin.json'))
  if (!parsed.ok) throw new Error(parsed.issues.map(issue => `${issue.file}:${issue.field}:${issue.message}`).join('\n'))
  const resources = validatePluginResources(parsed.value, files)
  if (!resources.ok) throw new Error(resources.issues.map(issue => `${issue.file}:${issue.field}:${issue.message}`).join('\n'))
  return { manifest: parsed.value, resources: resources.value }
}

/**
 * 从作者源文件生成可验证插件包；不执行脚本，不收录工具配置/密钥/测试。
 * @param source 源文件集合。
 * @param signingKey 可选作者 Ed25519 私钥；未提供时仅生成开发包。
 * @returns 确定性安装包字节。
 */
export function createPluginPackage(source: ReadonlyMap<string, Uint8Array>, signingKey?: KeyObject): Buffer {
  /** 按明确载荷白名单收录，额外开发文件不能进入最终包。 */
  const files = new Map([...source].filter(([path]) => ROOT_FILES.has(path) || RESOURCE_FILE.test(path)))
  validatePayload(files)
  const entries: IntegrityFile[] = [...files].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
    .map(([path, bytes]) => ({ path, bytes: bytes.byteLength, sha256: hashPluginBytes(bytes) }))
  const integrity = Buffer.from(`${JSON.stringify({ formatVersion: 1, files: entries })}\n`)
  files.set('integrity.json', integrity)
  if (signingKey) {
    if (signingKey.type !== 'private' || signingKey.asymmetricKeyType !== 'ed25519') throw new Error('PLUGIN_SIGNER_UNSUPPORTED')
    const publicKey = createPublicKey(signingKey).export({ type: 'spki', format: 'der' })
    files.set('signature.json', Buffer.from(`${JSON.stringify({ algorithm: 'Ed25519', keyId: hashPluginBytes(publicKey), publicKey: publicKey.toString('base64'), signature: sign(null, integrity, signingKey).toString('base64') })}\n`))
  }
  return createPluginArchive(files)
}

/**
 * 校验 ZIP、完整性、签名和资源；结果没有信任/授权副作用。
 * @param bytes 不可信包字节。
 * @returns 待宿主建立信任的精确候选。
 */
export function inspectPluginPackage(bytes: Uint8Array): InspectedPluginPackage {
  const files = readPluginArchive(bytes)
  const raw = readJson(files, 'integrity.json')
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('PLUGIN_INTEGRITY_INVALID')
  const integrity = raw as Record<string, unknown>
  if (Object.keys(integrity).sort().join() !== 'files,formatVersion' || integrity.formatVersion !== 1 || !Array.isArray(integrity.files)) throw new Error('PLUGIN_INTEGRITY_INVALID')
  const listed = new Set<string>()
  for (const value of integrity.files) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('PLUGIN_INTEGRITY_INVALID')
    const entry = value as Record<string, unknown>
    if (Object.keys(entry).sort().join() !== 'bytes,path,sha256' || typeof entry.path !== 'string' || listed.has(entry.path)
      || (!ROOT_FILES.has(entry.path) && !RESOURCE_FILE.test(entry.path))) throw new Error('PLUGIN_INTEGRITY_INVALID')
    const payload = files.get(entry.path)
    if (!payload || payload.byteLength !== entry.bytes || hashPluginBytes(payload) !== entry.sha256) throw new Error(`PLUGIN_INTEGRITY_MISMATCH:${entry.path}`)
    listed.add(entry.path)
  }
  for (const path of files.keys()) if (!listed.has(path) && path !== 'integrity.json' && path !== 'signature.json') throw new Error(`PLUGIN_UNLISTED_FILE:${path}`)
  /** 公开密钥自报只证明数学一致性，指纹供上层限定信任使用。 */
  let signer: PluginSigner | undefined
  if (files.has('signature.json')) {
    const rawSignature = readJson(files, 'signature.json')
    if (!rawSignature || typeof rawSignature !== 'object' || Array.isArray(rawSignature)) throw new Error('PLUGIN_SIGNATURE_INVALID')
    const signature = rawSignature as Record<string, unknown>
    if (Object.keys(signature).sort().join() !== 'algorithm,keyId,publicKey,signature' || signature.algorithm !== 'Ed25519'
      || typeof signature.keyId !== 'string' || typeof signature.publicKey !== 'string' || typeof signature.signature !== 'string') throw new Error('PLUGIN_SIGNATURE_INVALID')
    const publicBytes = Buffer.from(signature.publicKey, 'base64')
    const signatureBytes = Buffer.from(signature.signature, 'base64')
    if (publicBytes.toString('base64') !== signature.publicKey || signatureBytes.toString('base64') !== signature.signature
      || hashPluginBytes(publicBytes) !== signature.keyId || signatureBytes.byteLength !== 64) throw new Error('PLUGIN_SIGNATURE_INVALID')
    const key = createPublicKey({ key: publicBytes, type: 'spki', format: 'der' })
    if (key.asymmetricKeyType !== 'ed25519' || !verify(null, files.get('integrity.json')!, key, signatureBytes)) throw new Error('PLUGIN_SIGNATURE_INVALID')
    signer = { keyId: signature.keyId, publicKey: signature.publicKey }
  }
  const payload = validatePayload(files)
  return { ...payload, files, packageHash: hashPluginBytes(bytes), signatureVerified: Boolean(signer), ...(signer ? { signer } : {}) }
}
