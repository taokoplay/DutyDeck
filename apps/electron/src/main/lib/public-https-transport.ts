import { lookup as lookupDns } from 'node:dns/promises'
import { request as requestHttps } from 'node:https'
import { BlockList, isIP } from 'node:net'

/** DNS 返回并由请求层固定使用的 IP 地址。 */
export interface ResolvedAddress {
  address: string
  family: 4 | 6
}

/** 安全下载循环使用的最小 HTTP 响应。 */
export interface RemoteImageResponse {
  statusCode: number
  headers: Record<string, string | undefined>
  body: AsyncIterable<Uint8Array>
  /** 允许生产 transport 立即释放未消费或异常响应。 */
  cancel?: () => void
}

/** 可注入的 DNS 与 HTTPS transport，测试不访问真实网络。 */
export interface SafeRemoteImageDependencies {
  lookup: (hostname: string) => Promise<ResolvedAddress[]>
  request: (input: {
    url: URL
    address: string
    family: 4 | 6
    signal?: AbortSignal
    accept?: string
  }) => Promise<RemoteImageResponse>
  maxBytes?: number
  maxRedirects?: number
}

interface BlockedAddressLists { ipv4: BlockList; ipv6: BlockList }
const blockedAddresses = createBlockedAddressList()

/** 解析全部地址并确保每个结果都属于可路由公网。 */
export async function resolveAndValidateAddresses(
  hostname: string,
  lookup: SafeRemoteImageDependencies['lookup'],
): Promise<ResolvedAddress[]> {
  const normalizedHostname = stripIpv6Brackets(hostname)
  const literalFamily = isIP(normalizedHostname)
  /** IP 字面量无需 DNS，但仍进入相同的公网分类校验。 */
  const addresses: ResolvedAddress[] = literalFamily === 4 || literalFamily === 6
    ? [{ address: normalizedHostname, family: literalFamily }]
    : await lookup(normalizedHostname)
  if (addresses.length === 0) throw new Error('图片下载地址无法解析')
  for (const resolved of addresses) {
    if (isIP(resolved.address) !== resolved.family || isBlockedAddress(resolved)) {
      throw new Error('图片下载地址不允许访问本地或私有网络')
    }
  }
  return addresses
}

/** 判断地址是否命中本地、私网、保留、组播或文档用途网段。 */
function isBlockedAddress(resolved: ResolvedAddress): boolean {
  return resolved.family === 4
    ? blockedAddresses.ipv4.check(resolved.address, 'ipv4')
    : blockedAddresses.ipv6.check(resolved.address, 'ipv6')
}

/** 创建覆盖 IPv4/IPv6 非公网地址的只读黑名单。 */
function createBlockedAddressList(): BlockedAddressLists {
  const ipv4 = new BlockList()
  const ipv6 = new BlockList()
  for (const [address, prefix] of [
    ['0.0.0.0', 8],
    ['10.0.0.0', 8],
    ['100.64.0.0', 10],
    ['127.0.0.0', 8],
    ['169.254.0.0', 16],
    ['172.16.0.0', 12],
    ['192.0.0.0', 24],
    ['192.0.2.0', 24],
    ['192.168.0.0', 16],
    ['198.18.0.0', 15],
    ['198.51.100.0', 24],
    ['203.0.113.0', 24],
    ['224.0.0.0', 4],
    ['240.0.0.0', 4],
  ] as const) ipv4.addSubnet(address, prefix, 'ipv4')
  for (const [address, prefix] of [
    ['::', 128],
    ['::1', 128],
    ['::', 96],
    ['::ffff:0:0', 96],
    ['64:ff9b::', 96],
    ['64:ff9b:1::', 48],
    ['2002::', 16],
    ['2001::', 32],
    ['100::', 64],
    ['2001:2::', 48],
    ['2001:db8::', 32],
    ['fc00::', 7],
    ['fe80::', 10],
    ['fec0::', 10],
    ['ff00::', 8],
  ] as const) ipv6.addSubnet(address, prefix, 'ipv6')
  return { ipv4, ipv6 }
}

/** 去除 URL.hostname 在 IPv6 字面量上可能保留的方括号。 */
function stripIpv6Brackets(hostname: string): string {
  return hostname.startsWith('[') && hostname.endsWith(']') ? hostname.slice(1, -1) : hostname
}

/** 生产 DNS 实现返回全部 A/AAAA，调用方会拒绝其中任一非公网地址。 */
export async function defaultLookup(hostname: string): Promise<ResolvedAddress[]> {
  const results = await lookupDns(hostname, { all: true, verbatim: true })
  return results.flatMap((result) => (
    result.family === 4 || result.family === 6
      ? [{ address: result.address, family: result.family }]
      : []
  ))
}

/** 生产 HTTPS transport 直接连接已验证 IP，同时保留原 Host 和 TLS servername。 */
export function defaultRequest(
  input: Parameters<SafeRemoteImageDependencies['request']>[0],
): Promise<RemoteImageResponse> {
  return new Promise((resolve, reject) => {
    const originalHostname = stripIpv6Brackets(input.url.hostname)
    const request = requestHttps({
      protocol: 'https:',
      hostname: input.address,
      family: input.family,
      port: input.url.port || undefined,
      path: `${input.url.pathname}${input.url.search}`,
      method: 'GET',
      servername: isIP(originalHostname) === 0 ? originalHostname : undefined,
      headers: {
        Accept: input.accept ?? 'image/png,image/jpeg,image/webp,image/gif',
        Host: input.url.host,
        Connection: 'close',
      },
      signal: input.signal,
    }, (response) => {
      resolve({
        statusCode: response.statusCode ?? 0,
        headers: {
          'content-type': firstHeaderValue(response.headers['content-type']),
          'content-length': firstHeaderValue(response.headers['content-length']),
          'content-encoding': firstHeaderValue(response.headers['content-encoding']),
          location: firstHeaderValue(response.headers.location),
        },
        body: response,
        cancel: () => { response.destroy() },
      })
    })
    request.on('error', reject)
    request.end()
  })
}

/** 把 Node 多值响应头收窄为安全下载只使用的首个字符串。 */
function firstHeaderValue(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value
}
