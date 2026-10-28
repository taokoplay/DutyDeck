import { expect, test } from 'bun:test'
import { createLibTvMcpEntry, isLibTvMcpEntry, LIBTV_MCP_URL } from './libtv'

test('Given LibTV 官方插件 When 创建连接 Then 使用远程 OAuth 与二十分钟工具时限而无需 CLI 或密钥', () => {
  const entry = createLibTvMcpEntry()
  expect(entry).toMatchObject({ type: 'http', url: LIBTV_MCP_URL, enabled: false, toolTimeout: 1200 })
  expect(entry.oauth).toMatchObject({ provider: 'libtv', registrationEndpoint: 'https://mcp.liblib.tv/register' })
  expect(entry.oauth?.scopes).toContain('libtv:task:write')
  expect(entry.oauth?.scopes).toContain('libtv:export:write')
  expect(entry.command).toBeUndefined()
  expect(entry.headers).toBeUndefined()
  expect(entry.oauth?.clientId).toBeUndefined()
})

test('Given 多个工作区 When 修改一个预设 Then 其他工作区的授权范围不受影响', () => {
  const first = createLibTvMcpEntry()
  first.oauth?.scopes?.push('unexpected')
  expect(createLibTvMcpEntry().oauth?.scopes).not.toContain('unexpected')
})

test('Given 同名连接被改为其他目标 When 判断官方连接 Then 拒绝伪装与凭据覆盖', () => {
  const entry = createLibTvMcpEntry()
  expect(isLibTvMcpEntry(entry)).toBe(true)
  expect(isLibTvMcpEntry(undefined)).toBe(false)
  expect(isLibTvMcpEntry({ ...entry, url: 'https://mcp.liblib.tv.evil/mcp' })).toBe(false)
  expect(isLibTvMcpEntry({ ...entry, type: 'sse' })).toBe(false)
  expect(isLibTvMcpEntry({ ...entry, headers: { Authorization: 'override' } })).toBe(false)
})
