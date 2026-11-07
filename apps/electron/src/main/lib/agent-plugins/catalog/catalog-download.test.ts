import { describe, expect, test } from 'bun:test'
import { downloadCatalog, downloadPackageResource, type CatalogDownloadOptions } from './catalog-download'
import type { RemoteImageResponse } from '../../public-https-transport'
function response(statusCode: number, headers: Record<string, string>, bytes = '{}'): RemoteImageResponse {
  return { statusCode, headers, body: (async function* () { yield Buffer.from(bytes) })() }
}
const base: CatalogDownloadOptions = { lookup: async () => [{ address: '93.184.216.34', family: 4 }], request: async () => response(200, { 'content-type': 'application/json' }) }

describe('Given 目录网络字节边界', () => {
  test('When 公网重定向 Then 每跳重解析并固定公网地址', async () => {
    const addresses: string[] = []
    const bytes = await downloadCatalog('https://catalog.example/index.json', { ...base, request: async input => {
      addresses.push(input.address)
      return addresses.length === 1 ? response(302, { location: 'https://cdn.example/index.json' }) : response(200, { 'content-type': 'application/json' }, '{"format":1}')
    } })
    expect(bytes.toString()).toBe('{"format":1}')
    expect(addresses).toEqual(['93.184.216.34', '93.184.216.34'])
  })
  test('When 本地协议、认证URL、私网、HTTPS降级 Then 请求前拒绝', async () => {
    let calls = 0
    const options = { ...base, request: async () => { calls++; return response(200, {}) } }
    for (const url of ['file:///etc/passwd', 'http://catalog.example', 'https://u:p@catalog.example']) await expect(downloadCatalog(url, options)).rejects.toThrow()
    await expect(downloadCatalog('https://catalog.example', { ...options, lookup: async () => [{ address: '127.0.0.1', family: 4 }] })).rejects.toThrow()
    expect(calls).toBe(0)
    await expect(downloadCatalog('https://catalog.example', { ...base, request: async () => response(302, { location: 'http://catalog.example' }) })).rejects.toThrow()
  })
  test('When IPv6转换地址可路由至内网 Then 在transport前拒绝', async () => {
    let requested = false
    for (const address of ['64:ff9b::7f00:1', '2002:7f00:1::', '2001::7f00:1']) {
      await expect(downloadCatalog(`https://[${address}]/index.json`, { ...base, request: async () => { requested = true; return response(200, { 'content-type': 'application/json' }) } })).rejects.toThrow('不允许访问本地或私有网络')
    }
    expect(requested).toBe(false)
  })
  test('When site-local字面量、DNS或重定向 Then 不允许进入非公网transport', async () => {
    let calls = 0
    const request: NonNullable<CatalogDownloadOptions['request']> = async () => { calls++; return response(200, { 'content-type': 'application/json' }) }
    for (const address of ['fec0::1', 'fedf:1234::1', 'feff::1']) {
      await expect(downloadCatalog(`https://[${address}]/index.json`, { ...base, request })).rejects.toThrow('不允许访问本地或私有网络')
      await expect(downloadCatalog('https://catalog.example', { ...base, request, lookup: async () => [{ address, family: 6 }] })).rejects.toThrow('不允许访问本地或私有网络')
    }
    expect(calls).toBe(0)
    await expect(downloadCatalog('https://catalog.example', { ...base,
      lookup: async host => host === 'catalog.example' ? [{ address: '93.184.216.34', family: 4 }] : [{ address: 'fec0::1', family: 6 }],
      request: async () => { calls++; return response(302, { location: 'https://inside.example/index.json' }) },
    })).rejects.toThrow('不允许访问本地或私有网络')
    expect(calls).toBe(1)
  })
  test('When 字节超限、HTML、压缩、重定向循环 Then 有界拒绝', async () => {
    for (const options of [
      { maxBytes: 1 },
      { request: async () => response(200, { 'content-type': 'text/html' }) },
      { request: async () => response(200, { 'content-type': 'application/json', 'content-encoding': 'gzip' }) },
      { request: async () => response(302, { location: 'https://catalog.example' }) },
    ]) await expect(downloadCatalog('https://catalog.example', { ...base, ...options })).rejects.toThrow()
  })
  test('When 读取npm包 Then 支持二进制MIME但拒绝跨源重定向、私网DNS和超限', async () => {
    const url = 'https://registry.npmjs.org/demo/-/demo.tgz'
    expect((await downloadPackageResource(url, 'tarball', { ...base, request: async () => response(200, { 'content-type': 'application/octet-stream' }, 'bytes') })).toString()).toBe('bytes')
    let calls = 0
    await expect(downloadPackageResource(url, 'tarball', { ...base, request: async () => { calls++; return response(302, { location: 'https://other.example/x.tgz' }) } })).rejects.toThrow('PLUGIN_PACKAGE_URL_INVALID')
    expect(calls).toBe(1)
    await expect(downloadPackageResource(url, 'tarball', { ...base, lookup: async () => [{ address: '127.0.0.1', family: 4 }] })).rejects.toThrow('不允许访问本地或私有网络')
    await expect(downloadPackageResource(url, 'tarball', { ...base, maxBytes: 3, request: async () => response(200, { 'content-type': 'application/gzip' }, 'bytes') })).rejects.toThrow('PLUGIN_CATALOG_TOO_LARGE')
    await expect(downloadPackageResource(url, 'json', { ...base, request: async () => response(200, { 'content-type': 'application/json', 'content-length': String(1024 * 1024 + 1) }) })).rejects.toThrow('PLUGIN_CATALOG_TOO_LARGE')
  })
  test('When DNS永不返回或响应停止 Then 总时限拒绝，不无限等待', async () => {
    await expect(downloadCatalog('https://catalog.example', { ...base, timeoutMs: 10, lookup: async () => new Promise(() => undefined) })).rejects.toThrow('PLUGIN_CATALOG_TIMEOUT')
    await expect(downloadCatalog('https://catalog.example', { ...base, timeoutMs: 10, request: async () => ({ statusCode: 200, headers: { 'content-type': 'application/json' }, body: (async function* () { await new Promise(() => undefined); yield Buffer.alloc(0) })() }) })).rejects.toThrow('PLUGIN_CATALOG_TIMEOUT')
  })
})
