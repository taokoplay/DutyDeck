import { describe, expect, test } from 'bun:test'
import type { McpServerEntry } from '@dutydeck/shared'
import {
  buildWorkspaceMcpEntry,
  hasWorkspaceMcpTransportChanged,
  preserveSensitiveConnectionFields,
  requireWorkspaceMcpServerName,
} from './mcp-configuration-policy'

describe('工作区 MCP 配置策略', () => {
  test('Given 合法名称 When 规范化 Then 去除首尾空白', () => {
    expect(requireWorkspaceMcpServerName('  github-docs  ')).toBe('github-docs')
  })

  test.each(['', '   ', 'automation', 'collaboration', '__proto__', 'constructor', 'prototype'])('Given 空名称、保留名或原型键 %s When 校验 Then 拒绝保存', (name) => {
    expect(() => requireWorkspaceMcpServerName(name)).toThrow()
  })

  test('Given stdio 缺少 command When 构建配置 Then 明确拒绝', () => {
    expect(() => buildWorkspaceMcpEntry({ name: 'local', type: 'stdio' })).toThrow('stdio MCP 需要 command')
  })

  test.each(['http', 'sse'] as const)('Given %s 缺少或包含无效 URL When 构建配置 Then 明确拒绝', (type) => {
    expect(() => buildWorkspaceMcpEntry({ name: 'remote', type })).toThrow(`${type} MCP 需要 url`)
    expect(() => buildWorkspaceMcpEntry({ name: 'remote', type, url: 'not-a-url' })).toThrow('无效的 MCP URL')
    expect(() => buildWorkspaceMcpEntry({ name: 'remote', type, url: 'file:///tmp/mcp.sock' })).toThrow('必须使用 HTTP 或 HTTPS')
  })

  test('Given OAuth 端点不是 HTTPS When 构建配置 Then 拒绝公开元数据', () => {
    expect(() => buildWorkspaceMcpEntry({
      name: 'remote',
      type: 'http',
      url: 'https://mcp.example.com',
      oauth: { authorizationEndpoint: 'http://auth.example.com/authorize' },
    })).toThrow('OAuth authorizationEndpoint 必须使用 HTTPS')
  })

  test('Given OAuth 端点包含 userinfo When 构建配置 Then 拒绝把凭据嵌入公开 URL', () => {
    expect(() => buildWorkspaceMcpEntry({
      name: 'remote',
      type: 'http',
      url: 'https://mcp.example.com',
      oauth: { tokenEndpoint: 'https://user:password@auth.example.com/token' },
    })).toThrow('OAuth tokenEndpoint 不能包含用户名或密码')
  })

  test('Given stdio args 含空串和首尾空格 When 构建配置 Then 保留参数原义', () => {
    expect(buildWorkspaceMcpEntry({
      name: 'local',
      type: 'stdio',
      command: 'runner',
      args: ['', '  spaced  '],
    }).args).toEqual(['', '  spaced  '])
  })

  test('Given 已有远程请求头 When 保持同一目标 Then 保留敏感字段', () => {
    const previous: McpServerEntry = {
      type: 'http',
      url: 'https://same.example.com',
      headers: { Authorization: 'Bearer secret' },
      enabled: true,
    }
    const next = buildWorkspaceMcpEntry({ name: 'remote', type: 'http', url: 'https://same.example.com' })

    expect(preserveSensitiveConnectionFields(previous, next)).toEqual({
      ...next,
      headers: { Authorization: 'Bearer secret' },
    })
  })

  test('Given 已有 stdio 环境变量 When 更新同 transport Then 保留敏感字段', () => {
    const previous: McpServerEntry = {
      type: 'stdio',
      command: 'npx',
      args: ['old'],
      env: { TOKEN: 'secret' },
      enabled: true,
    }
    const next = buildWorkspaceMcpEntry({ name: 'local', type: 'stdio', command: 'bunx', args: ['new'] })

    expect(preserveSensitiveConnectionFields(previous, next)).toEqual({ ...next, env: { TOKEN: 'secret' } })
  })

  test('Given 仅启用状态和敏感字段变化 When 比较连接配置 Then 不要求替换确认', () => {
    const previous: McpServerEntry = {
      type: 'http',
      url: 'https://mcp.example.com',
      headers: { Authorization: 'old' },
      enabled: false,
    }
    const next: McpServerEntry = {
      type: 'http',
      url: 'https://mcp.example.com',
      headers: { Authorization: 'new' },
      enabled: true,
    }

    expect(hasWorkspaceMcpTransportChanged(previous, next)).toBe(false)
  })

  test('Given URL 或 OAuth 元数据变化 When 比较连接配置 Then 要求替换确认', () => {
    const previous: McpServerEntry = { type: 'http', url: 'https://old.example.com', enabled: true }
    const next: McpServerEntry = {
      type: 'http',
      url: 'https://new.example.com',
      oauth: { clientId: 'public-client' },
      enabled: true,
    }

    expect(hasWorkspaceMcpTransportChanged(previous, next)).toBe(true)
  })
})

describe('MCP 工具超时配置边界', () => {
  test.each(['http', 'sse', 'stdio'] as const)('Given %s 长耗时工具 When 构建配置 Then 保留独立工具超时和原启动超时', (type) => {
    const entry = buildWorkspaceMcpEntry({ name: 'libtv', type, command: 'server', url: 'https://example.test/mcp', timeout: 30, toolTimeout: 1200 })
    expect(entry.toolTimeout).toBe(1200)
    expect(entry.timeout).toBe(30)
    expect(hasWorkspaceMcpTransportChanged(entry, { ...entry, toolTimeout: 60 })).toBe(true)
  })
  test.each([0, -1, 1201, Infinity, NaN])('Given 非法工具超时 %s When 构建配置 Then 拒绝保存', (toolTimeout) => {
    expect(() => buildWorkspaceMcpEntry({ name: 'libtv', type: 'http', url: 'https://example.test/mcp', toolTimeout })).toThrow('工具超时')
  })
  test('Given 未配置或有效小数 When 构建配置 Then 保持默认或原值', () => {
    expect(buildWorkspaceMcpEntry({ name: 'libtv', type: 'http', url: 'https://example.test/mcp' }).toolTimeout).toBeUndefined()
    expect(buildWorkspaceMcpEntry({ name: 'libtv', type: 'http', url: 'https://example.test/mcp', toolTimeout: 0.5 }).toolTimeout).toBe(0.5)
  })
})
