import { defaultLookup, defaultRequest, resolveAndValidateAddresses, type RemoteImageResponse, type SafeRemoteImageDependencies } from '../../public-https-transport'
export interface CatalogDownloadOptions extends Partial<SafeRemoteImageDependencies> { timeoutMs?: number }
export const CATALOG_MAX_BYTES = 32 * 1024 * 1024

/** 来源标识规范化；认证信息、非HTTPS和非标准端口不进入缓存标识。 */
export function catalogUrl(raw: string): string {
  if (raw.length > 2048) throw new Error('PLUGIN_CATALOG_URL_INVALID')
  let url: URL
  try { url = new URL(raw) } catch { throw new Error('PLUGIN_CATALOG_URL_INVALID') }
  if (url.protocol !== 'https:' || url.username || url.password || url.port) throw new Error('PLUGIN_CATALOG_URL_INVALID')
  url.hash = ''
  return url.href
}
function header(response: RemoteImageResponse, name: string): string | undefined {
  const value = Object.entries(response.headers).find(([key]) => key.toLowerCase() === name)?.[1]
  return Array.isArray(value) ? value[0] : value
}

/** 复用固定公网地址transport；总时限覆盖DNS、重定向和慢速body，未启动外部代码。 */
export function downloadCatalog(raw: string, options: CatalogDownloadOptions = {}): Promise<Buffer> {
  return download(raw, options, 'catalog')
}

/** 包分析仅访问公开npm registry；同样逐跳校验DNS/IP，拒绝其它registry重定向。 */
export function downloadPackageResource(raw: string, kind: 'json' | 'tarball', options: CatalogDownloadOptions = {}): Promise<Buffer> {
  return download(raw, { ...options, maxBytes: Math.min(options.maxBytes ?? Infinity, kind === 'json' ? 1024 * 1024 : 16 * 1024 * 1024) }, kind)
}
async function download(raw: string, options: CatalogDownloadOptions, kind: 'catalog' | 'json' | 'tarball'): Promise<Buffer> {
  const checkedUrl = (value: string): URL => {
    const url = new URL(catalogUrl(value))
    if (kind !== 'catalog' && url.origin !== 'https://registry.npmjs.org') throw new Error('PLUGIN_PACKAGE_URL_INVALID')
    return url
  }
  const controller = new AbortController()
  const timeout = Math.min(30_000, Math.max(1, options.timeoutMs ?? 20_000))
  const maxBytes = Math.min(CATALOG_MAX_BYTES, Math.max(1, options.maxBytes ?? CATALOG_MAX_BYTES))
  const maxRedirects = Math.min(3, Math.max(0, options.maxRedirects ?? 3))
  let timer: ReturnType<typeof setTimeout>
  const expired = new Promise<never>((_resolve, reject) => { timer = setTimeout(() => { controller.abort(); reject(new Error('PLUGIN_CATALOG_TIMEOUT')) }, timeout) })
  const work = async (): Promise<Buffer> => {
    let url = checkedUrl(raw)
    for (let hop = 0; hop <= maxRedirects; hop++) {
      if (controller.signal.aborted) throw new Error('PLUGIN_CATALOG_TIMEOUT')
      const addresses = await resolveAndValidateAddresses(url.hostname, options.lookup ?? defaultLookup)
      if (controller.signal.aborted) throw new Error('PLUGIN_CATALOG_TIMEOUT')
      const response = await (options.request ?? defaultRequest)({ url, ...addresses[0]!, signal: controller.signal, accept: kind === 'tarball' ? 'application/octet-stream, application/gzip' : 'application/json' })
      if ([301, 302, 303, 307, 308].includes(response.statusCode)) {
        response.cancel?.()
        const location = header(response, 'location')
        if (!location || hop === maxRedirects) throw new Error('PLUGIN_CATALOG_REDIRECT_LIMIT')
        url = checkedUrl(new URL(location, url).href)
        continue
      }
      try {
        if (response.statusCode !== 200) throw new Error('PLUGIN_CATALOG_HTTP_ERROR')
        const mime = kind === 'tarball' ? /^application\/(?:octet-stream|gzip|x-gzip)(?:;|$)/i : /^application\/(?:json|[a-z0-9.-]+\+json)(?:;|$)/i
        if (!mime.test(header(response, 'content-type') ?? '')) throw new Error('PLUGIN_CATALOG_CONTENT_TYPE')
        if (header(response, 'content-encoding') && header(response, 'content-encoding') !== 'identity') throw new Error('PLUGIN_CATALOG_ENCODING')
        if (Number(header(response, 'content-length')) > maxBytes) throw new Error('PLUGIN_CATALOG_TOO_LARGE')
        const chunks: Buffer[] = []
        let size = 0
        for await (const chunk of response.body) {
          if (controller.signal.aborted) throw new Error('PLUGIN_CATALOG_TIMEOUT')
          size += chunk.byteLength
          if (size > maxBytes) throw new Error('PLUGIN_CATALOG_TOO_LARGE')
          chunks.push(Buffer.from(chunk))
        }
        return Buffer.concat(chunks)
      } finally { response.cancel?.() }
    }
    throw new Error('PLUGIN_CATALOG_REDIRECT_LIMIT')
  }
  try { return await Promise.race([work(), expired]) }
  finally { clearTimeout(timer!); controller.abort() }
}
