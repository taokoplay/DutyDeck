import { MAX_ATTACHMENT_SIZE } from '@dutydeck/shared'

import { defaultLookup, defaultRequest, resolveAndValidateAddresses, type RemoteImageResponse, type SafeRemoteImageDependencies } from '../public-https-transport'
export type { ResolvedAddress, RemoteImageResponse, SafeRemoteImageDependencies } from '../public-https-transport'

/** 下载完成后允许进入附件保存流程的图片。 */
export interface DownloadedRemoteImage {
  bytes: Buffer
  mediaType: 'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif'
}

const DEFAULT_MAX_REDIRECTS = 3
const SUPPORTED_REMOTE_IMAGE_TYPES = new Set<DownloadedRemoteImage['mediaType']>([
  'image/png',
  'image/jpeg',
  'image/webp',
  'image/gif',
])
const REDIRECT_STATUS_CODES = new Set([301, 302, 303, 307, 308])

/** 安全下载远程图片，并对每次重定向重新执行协议与 DNS 边界校验。 */
export async function downloadSafeRemoteImage(
  rawUrl: string,
  dependencies: SafeRemoteImageDependencies = defaultDependencies,
  signal?: AbortSignal,
): Promise<DownloadedRemoteImage> {
  const maxBytes = dependencies.maxBytes ?? MAX_ATTACHMENT_SIZE
  const maxRedirects = dependencies.maxRedirects ?? DEFAULT_MAX_REDIRECTS
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) throw new Error('远程图片大小限制无效')
  if (!Number.isSafeInteger(maxRedirects) || maxRedirects < 0) throw new Error('远程图片重定向限制无效')

  /** 当前跳 URL 只存在于本地循环，不进入错误日志。 */
  let currentUrl = parseRemoteImageUrl(rawUrl)
  let redirectCount = 0
  while (true) {
    signal?.throwIfAborted()
    assertHttpsUrl(currentUrl)
    /** 任一 DNS 结果不安全时拒绝整组，防止选择公网结果掩盖私网别名。 */
    const addresses = await resolveAndValidateAddresses(currentUrl.hostname, dependencies.lookup)
    signal?.throwIfAborted()
    /** 固定首个已验证地址，transport 不得再次解析域名。 */
    const selected = addresses[0]
    if (!selected) throw new Error('图片下载地址无法解析')
    const response = await dependencies.request({
      url: currentUrl,
      address: selected.address,
      family: selected.family,
      signal,
    })

    if (REDIRECT_STATUS_CODES.has(response.statusCode)) {
      response.cancel?.()
      if (redirectCount >= maxRedirects) throw new Error('远程图片重定向次数过多')
      const location = getHeader(response.headers, 'location')
      if (!location) throw new Error('远程图片重定向响应缺少地址')
      currentUrl = parseRemoteImageUrl(location, currentUrl)
      redirectCount += 1
      continue
    }

    if (response.statusCode < 200 || response.statusCode >= 300) {
      response.cancel?.()
      throw new Error(`远程图片请求失败 (${response.statusCode})`)
    }
    const mediaType = normalizeImageMediaType(getHeader(response.headers, 'content-type'))
    if (!mediaType) {
      response.cancel?.()
      throw new Error('远程响应不是受支持的图片')
    }
    const declaredLength = parseContentLength(getHeader(response.headers, 'content-length'))
    if (declaredLength !== undefined && declaredLength > maxBytes) {
      response.cancel?.()
      throw new Error('远程图片超过大小限制')
    }
    return {
      bytes: await readLimitedBody(response, maxBytes, signal),
      mediaType,
    }
  }
}

/** 解析 URL 时只返回稳定错误，不回显可能含签名参数的原始字符串。 */
function parseRemoteImageUrl(rawUrl: string, baseUrl?: URL): URL {
  try {
    return new URL(rawUrl, baseUrl)
  } catch {
    throw new Error('远程图片地址无效')
  }
}

/** 只允许 HTTPS，避免图片内容或签名经明文链路泄露。 */
function assertHttpsUrl(url: URL): void {
  if (url.protocol !== 'https:') throw new Error('远程图片只允许使用 HTTPS')
  if (url.username || url.password) throw new Error('远程图片地址不允许包含用户凭据')
}

/** 从大小写不敏感响应头中读取单个值。 */
function getHeader(headers: Record<string, string | undefined>, name: string): string | undefined {
  const expected = name.toLowerCase()
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === expected) return value
  }
  return undefined
}

/** 清洗 Content-Type 并收窄到附件服务支持的四类图片。 */
function normalizeImageMediaType(value: string | undefined): DownloadedRemoteImage['mediaType'] | undefined {
  const mediaType = value?.split(';', 1)[0]?.trim().toLowerCase()
  if (!mediaType
    || !SUPPORTED_REMOTE_IMAGE_TYPES.has(mediaType as DownloadedRemoteImage['mediaType'])) return undefined
  return mediaType as DownloadedRemoteImage['mediaType']
}

/** 解析可信的非负 Content-Length；无效值按未知长度处理并依靠流式限制。 */
function parseContentLength(value: string | undefined): number | undefined {
  if (!value || !/^\d+$/.test(value)) return undefined
  const length = Number(value)
  return Number.isSafeInteger(length) ? length : undefined
}

/** 流式读取响应并在累计字节超限的第一时间中止。 */
async function readLimitedBody(
  response: RemoteImageResponse,
  maxBytes: number,
  signal?: AbortSignal,
): Promise<Buffer> {
  /** 分块保存避免在上限内反复复制完整 Buffer。 */
  const chunks: Buffer[] = []
  let totalBytes = 0
  try {
    for await (const chunk of response.body) {
      signal?.throwIfAborted()
      const buffer = Buffer.from(chunk)
      totalBytes += buffer.length
      if (totalBytes > maxBytes) throw new Error('远程图片超过大小限制')
      chunks.push(buffer)
    }
    signal?.throwIfAborted()
    return Buffer.concat(chunks, totalBytes)
  } finally {
    response.cancel?.()
  }
}

const defaultDependencies: SafeRemoteImageDependencies = {
  lookup: defaultLookup,
  request: defaultRequest,
}
