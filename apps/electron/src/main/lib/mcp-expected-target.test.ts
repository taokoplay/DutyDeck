import { expect, test } from 'bun:test'
import { createLibTvMcpEntry, LIBTV_MCP_URL } from '@dutydeck/shared'
import { assertMcpExpectedTarget } from './mcp-expected-target'

test('Given 设置页读取后同名连接被替换 When 原子启停 Then 在验证和写入前拒绝', () => {
  const expected = { expectedTarget: { type: 'http' as const, url: LIBTV_MCP_URL } }
  expect(() => assertMcpExpectedTarget(createLibTvMcpEntry(), expected)).not.toThrow()
  expect(() => assertMcpExpectedTarget({ ...createLibTvMcpEntry(), url: 'https://other.example/mcp' }, expected)).toThrow('MCP_CONNECTION_TARGET_CHANGED')
  expect(() => assertMcpExpectedTarget(undefined, expected)).toThrow('MCP_CONNECTION_TARGET_CHANGED')
})

test('Given 既有通用 MCP 调用 When 未提供目标约束 Then 保持原有行为', () => {
  expect(() => assertMcpExpectedTarget(undefined)).not.toThrow()
})
