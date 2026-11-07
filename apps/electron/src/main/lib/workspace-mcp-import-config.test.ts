import { describe, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { writeJsonFileAtomic } from './safe-file'
import { readWorkspaceMcpImportConfig, writeWorkspaceMcpImportConfig } from './workspace-mcp-import-config'
describe('Given 静态导入读写现有MCP配置', () => {
  test('When strict 保存遇到固定tmp/bak链接 Then 不覆盖链接目标，安全tmp绕过，危险bak拒绝', () => {
    for (const suffix of ['tmp', 'bak']) {
      const root = mkdtempSync(join(tmpdir(), 'mcp-import-write-')); const path = join(root, 'mcp.json'); const victim = join(root, 'user.txt')
      try {
        const prior = { servers: { user: { type: 'http' as const, enabled: false, url: 'https://example.com', extension: { retained: true }, headers: { 'X-Fixture': 'fixture-only' } } } }
        const next = { servers: { ...prior.servers, added: { type: 'http' as const, enabled: false, url: 'https://fixture.example.com' } } }
        writeFileSync(path, JSON.stringify(prior)); writeFileSync(victim, 'must remain unchanged'); symlinkSync(victim, `${path}.${suffix}`)
        if (suffix === 'bak') {
          expect(() => writeWorkspaceMcpImportConfig(path, next)).toThrow()
          expect(readWorkspaceMcpImportConfig(path)).toEqual(prior)
        } else {
          writeWorkspaceMcpImportConfig(path, next)
          expect(readWorkspaceMcpImportConfig(path)).toEqual(next)
          expect(JSON.parse(readFileSync(`${path}.bak`, 'utf8'))).toEqual(prior)
        }
        expect(readFileSync(victim, 'utf8')).toBe('must remain unchanged')
      } finally { rmSync(root, { recursive: true, force: true }) }
    }
  })
  test('When strict 写入新文件、损坏主文件或超预算数据 Then 只提交合法数据且保留已有字节', () => {
    const root = mkdtempSync(join(tmpdir(), 'mcp-import-write-')); const path = join(root, 'mcp.json')
    try {
      writeWorkspaceMcpImportConfig(path, { servers: {} })
      expect(readWorkspaceMcpImportConfig(path)).toEqual({ servers: {} })
      const large = { servers: { huge: { type: 'http' as const, enabled: false, url: 'https://example.com', extension: 'x'.repeat(1024 * 1024) } } }
      expect(() => writeWorkspaceMcpImportConfig(path, large)).toThrow('PLUGIN_IMPORT_MCP_CONFIG_INVALID')
      expect(readWorkspaceMcpImportConfig(path)).toEqual({ servers: {} })
      writeFileSync(path, '{corrupt')
      expect(() => writeWorkspaceMcpImportConfig(path, { servers: {} })).toThrow('PLUGIN_IMPORT_MCP_CONFIG_INVALID')
      expect(readFileSync(path, 'utf8')).toBe('{corrupt')
    } finally { rmSync(root, { recursive: true, force: true }) }
  })
  test('When 主文件缺失、损坏或危险路径 Then 只允许真正缺失返回空，损坏不从bak恢复且不改原文件', () => {
    const root = mkdtempSync(join(tmpdir(), 'mcp-import-read-')); const path = join(root, 'mcp.json')
    try {
      expect(readWorkspaceMcpImportConfig(path)).toEqual({ servers: {} })
      writeJsonFileAtomic(`${path}.bak`, { servers: { user: { type: 'http', enabled: true, url: 'https://example.com' } } })
      for (const raw of ['{bad', 'null', '[]', '{}', '{"servers":[]}', '{"servers":{"x":null}}', '{"servers":{"__proto__":{}}}', '{"servers":{},"future":true}']) {
        writeFileSync(path, raw)
        expect(() => readWorkspaceMcpImportConfig(path)).toThrow('PLUGIN_IMPORT_MCP_CONFIG_INVALID')
        expect(readFileSync(path, 'utf8')).toBe(raw)
      }
      writeFileSync(path, Buffer.alloc(1024 * 1024 + 1, 32))
      expect(() => readWorkspaceMcpImportConfig(path)).toThrow('PLUGIN_IMPORT_MCP_CONFIG_INVALID')
      rmSync(path); symlinkSync(`${path}.bak`, path)
      expect(() => readWorkspaceMcpImportConfig(path)).toThrow('PLUGIN_IMPORT_MCP_CONFIG_INVALID')
    } finally { rmSync(root, { recursive: true, force: true }) }
  })
  test('When 既有条目包含未知扩展或敏感字段 Then 原样保留，不归一化丢用户数据', () => {
    const root = mkdtempSync(join(tmpdir(), 'mcp-import-read-')); const path = join(root, 'mcp.json')
    try {
      const config = { servers: { docs: { type: 'http' as const, enabled: false, url: 'https://example.com', headers: { 'X-Fixture': 'not-a-real-secret' }, extension: { retained: true } } } }
      writeJsonFileAtomic(path, config)
      expect(readWorkspaceMcpImportConfig(path)).toEqual(config)
    } finally { rmSync(root, { recursive: true, force: true }) }
  })
})
