import { afterAll, beforeEach, describe, expect, mock, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createLibTvMcpEntry, LIBTV_MCP_URL } from '@dutydeck/shared'

/** 测试独占的加密凭据文件目录。 */
const testRoot = mkdtempSync(join(tmpdir(), 'proma-mcp-oauth-'))
/** 测试独占的加密凭据文件。 */
const credentialPath = join(testRoot, 'mcp-oauth.json')
/** 测试用浏览器授权回调；仅访问测试创建的回环端口。 */
let openAuthorization: (url: string) => Promise<void> = async () => undefined

mock.module('electron', () => ({
  safeStorage: {
    isEncryptionAvailable: () => true,
    encryptString: (value: string) => Buffer.from(value, 'utf8'),
    decryptString: (value: Buffer) => value.toString('utf8'),
  },
  shell: { openExternal: (url: string) => openAuthorization(url) },
}))

mock.module('./config-paths', () => ({
  getMcpOAuthCredentialsPath: () => credentialPath,
}))

mock.module('./oauth-proxy-scope', () => ({
  runWithOAuthProxyScope: async <T>(action: () => Promise<T>): Promise<T> => action(),
}))

const {
  exchangeAuthorizationCode,
  getMcpOAuthHeaders,
  matchesMcpOAuthClientSecretBinding,
  saveMcpOAuthClientSecret,
  startMcpOAuth,
} = await import('./mcp-oauth-service')

/** 每个用例恢复原始 fetch，避免污染其他测试。 */
const originalFetch = globalThis.fetch

beforeEach(() => {
  globalThis.fetch = originalFetch
  rmSync(credentialPath, { force: true })
  openAuthorization = async () => undefined
})

afterAll(() => {
  globalThis.fetch = originalFetch
  rmSync(testRoot, { recursive: true, force: true })
})

test('Given LibTV 官方 OAuth 元数据 When 用户完成浏览器授权 Then DCR、PKCE 与资源绑定贯通且只持久化密文', async () => {
  /** 仅记录公开协议序列，不记录生成的 verifier、授权码或 token。 */
  const operations: string[] = []
  const entry = createLibTvMcpEntry()
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = String(input)
    if (url === 'https://mcp.liblib.tv/.well-known/oauth-protected-resource/mcp') {
      operations.push('resource')
      return Response.json({ authorization_servers: ['https://mcp.liblib.tv/'], scopes_supported: [] })
    }
    if (url === 'https://mcp.liblib.tv/.well-known/oauth-authorization-server') {
      operations.push('discovery')
      return Response.json({ authorization_endpoint: 'https://mcp.liblib.tv/authorize', token_endpoint: 'https://mcp.liblib.tv/token', registration_endpoint: 'https://mcp.liblib.tv/register' })
    }
    if (url === 'https://mcp.liblib.tv/register') {
      operations.push('register')
      const registration = JSON.parse(String(init?.body)) as { token_endpoint_auth_method: string; redirect_uris: string[] }
      expect(registration.token_endpoint_auth_method).toBe('none')
      expect(registration.redirect_uris[0]).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/callback$/)
      return Response.json({ client_id: 'test-libtv-public-client' })
    }
    if (url === 'https://mcp.liblib.tv/token') {
      operations.push('token')
      const body = new URLSearchParams(String(init?.body))
      expect(body.get('resource')).toBe(LIBTV_MCP_URL)
      expect(body.get('code_verifier')?.length).toBeGreaterThan(40)
      expect(body.get('client_secret')).toBeNull()
      return Response.json({ access_token: 'test-libtv-access', refresh_token: 'test-libtv-refresh', expires_in: 3600 })
    }
    throw new Error('测试外网络请求已拒绝')
  }) as typeof fetch
  openAuthorization = async (url) => {
    operations.push('browser')
    const authorization = new URL(url)
    expect(authorization.origin).toBe('https://mcp.liblib.tv')
    expect(authorization.searchParams.get('scope')).toBe(entry.oauth?.scopes?.join(' ') ?? null)
    expect(authorization.searchParams.get('code_challenge_method')).toBe('S256')
    const callback = new URL(authorization.searchParams.get('redirect_uri')!)
    callback.searchParams.set('state', authorization.searchParams.get('state')!)
    callback.searchParams.set('code', 'test-authorization-code')
    await originalFetch(callback)
  }
  const result = await startMcpOAuth({ workspaceSlug: 'libtv-test', serverName: 'libtv', provider: 'libtv', serverUrl: LIBTV_MCP_URL, oauth: entry.oauth })
  expect(result.serverName).toBe('libtv')
  expect(operations).toEqual(['resource', 'discovery', 'register', 'browser', 'token'])
  expect(readFileSync(credentialPath, 'utf8')).not.toContain('test-libtv-access')
  expect(await getMcpOAuthHeaders('libtv-test', 'libtv', LIBTV_MCP_URL)).toEqual({ Authorization: 'Bearer test-libtv-access' })
  expect(await getMcpOAuthHeaders('other-workspace', 'libtv', LIBTV_MCP_URL)).toBeUndefined()
  expect(await getMcpOAuthHeaders('libtv-test', 'libtv', 'https://other.example/mcp')).toBeUndefined()
})

describe('MCP OAuth Client Secret', () => {
  test('Given 已保存 secret When clientId 或 tokenEndpoint 变化 Then 拒绝复用旧绑定', () => {
    const stored = {
      serverUrl: 'https://mcp.example.com/',
      clientId: 'client-a',
      tokenEndpoint: 'https://auth.example.com/token',
    }

    expect(matchesMcpOAuthClientSecretBinding(stored, {
      serverUrl: 'https://mcp.example.com',
      clientId: 'client-b',
      tokenEndpoint: 'https://auth.example.com/token',
    })).toBe(false)
    expect(matchesMcpOAuthClientSecretBinding(stored, {
      serverUrl: 'https://mcp.example.com',
      clientId: 'client-a',
      tokenEndpoint: 'https://other.example.com/token',
    })).toBe(false)
  })

  test('Given 用户输入 client secret When 保存 Then 仅写入加密凭据文件且规范化 URL', () => {
    saveMcpOAuthClientSecret({
      workspaceSlug: 'project-a',
      serverName: 'docs',
      serverUrl: 'https://mcp.example.com',
      clientId: 'public-client',
      tokenEndpoint: 'https://auth.example.com/token',
      clientSecret: '  secret-value  ',
    })

    const file = JSON.parse(readFileSync(credentialPath, 'utf8')) as { credentials: Record<string, string> }
    const credential = JSON.parse(Buffer.from(file.credentials['project-a:docs']!, 'base64').toString('utf8'))
    expect(credential).toEqual({
      kind: 'oauth-client-secret',
      serverUrl: 'https://mcp.example.com/',
      clientId: 'public-client',
      tokenEndpoint: 'https://auth.example.com/token',
      clientSecret: 'secret-value',
    })
  })

  test('Given 仅保存 client secret When 解析请求头 Then 不把 secret 当作 bearer token', async () => {
    saveMcpOAuthClientSecret({
      workspaceSlug: 'project-a',
      serverName: 'docs',
      serverUrl: 'https://mcp.example.com',
      clientId: 'public-client',
      tokenEndpoint: 'https://auth.example.com/token',
      clientSecret: 'secret-value',
    })

    await expect(getMcpOAuthHeaders('project-a', 'docs', 'https://mcp.example.com')).resolves.toBeUndefined()
  })

  test('Given OAuth 提供方要求 client secret When 交换授权码 Then secret 仅进入 token 请求体', async () => {
    let requestBody = ''
    globalThis.fetch = mock(async (_input: string | URL | Request, init?: RequestInit) => {
      requestBody = String(init?.body ?? '')
      return new Response(JSON.stringify({ access_token: 'access-token' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    }) as unknown as typeof fetch

    await exchangeAuthorizationCode({
      tokenEndpoint: 'https://auth.example.com/token',
      clientId: 'public-client',
      clientSecret: 'secret-value',
      redirectUri: 'http://127.0.0.1/callback',
      code: 'code',
      verifier: 'verifier',
    })

    expect(new URLSearchParams(requestBody).get('client_secret')).toBe('secret-value')
  })
})
