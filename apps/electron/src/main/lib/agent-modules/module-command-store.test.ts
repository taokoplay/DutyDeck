import { describe, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AgentModuleCommand } from '@dutydeck/shared'
import { AgentModuleCommandStore } from './module-command-store'

function command(overrides: Partial<AgentModuleCommand> = {}): AgentModuleCommand {
  return {
    commandId: 'command-1', sessionId: 'session-1', moduleId: 'canvas', capabilityId: 'canvas.create_node',
    baseRevision: 1, invocationMode: 'invoke', deliveryMode: 'enqueue', requestSummary: '创建节点', input: { title: 'A' },
    idempotencyKey: 'request-1', status: 'queued', createdAt: 10, updatedAt: 10, ...overrides,
  }
}

describe('Agent 模块命令持久化 outbox', () => {
  test('重启后 queued 命令仍可读取，重复 upsert 只保留一个命令', () => {
    const root = mkdtempSync(join(tmpdir(), 'dutydeck-module-command-'))
    const resolvePath = (sessionId: string): string => join(root, `${sessionId}.json`)
    const firstStore = new AgentModuleCommandStore({ resolvePath })
    firstStore.upsert(command())

    const reopened = new AgentModuleCommandStore({ resolvePath })
    reopened.upsert(command({ updatedAt: 20 }))
    expect(reopened.list('session-1')).toHaveLength(1)
    expect(reopened.list('session-1')[0]?.updatedAt).toBe(20)
    expect(JSON.parse(readFileSync(resolvePath('session-1'), 'utf8')).version).toBe(1)
  })

  test('损坏快照阻断读写且保留原始证据', () => {
    const root = mkdtempSync(join(tmpdir(), 'dutydeck-module-command-corrupt-'))
    const resolvePath = (sessionId: string): string => join(root, `${sessionId}.json`)
    const path = resolvePath('session-1')
    writeFileSync(path, '{broken')
    const store = new AgentModuleCommandStore({ resolvePath })
    expect(() => store.list('session-1')).toThrow('AGENT_MODULE_COMMAND_STORE_REQUIRES_REVIEW')
    expect(() => store.upsert(command())).toThrow('AGENT_MODULE_COMMAND_STORE_REQUIRES_REVIEW')
    expect(store.inspect('session-1').writable).toBe(false)
    expect(readFileSync(path, 'utf8')).toBe('{broken')
  })
  test('未来版本、跨 Session 和重复幂等键快照只诊断不覆盖', () => {
    const root = mkdtempSync(join(tmpdir(), 'dutydeck-module-command-identity-'))
    const resolvePath = (sessionId: string): string => join(root, `${sessionId}.json`)
    const store = new AgentModuleCommandStore({ resolvePath })
    for (const snapshot of [
      { version: 2, commands: [command()] },
      { version: 1, commands: [command({ sessionId: 'foreign' })] },
      { version: 1, commands: [command(), command({ commandId: 'duplicate' })] },
    ]) {
      const original = JSON.stringify(snapshot)
      writeFileSync(resolvePath('session-1'), original)
      expect(store.inspect('session-1').writable).toBe(false)
      expect(() => store.replace('session-1', [])).toThrow('AGENT_MODULE_COMMAND_STORE_REQUIRES_REVIEW')
      expect(readFileSync(resolvePath('session-1'), 'utf8')).toBe(original)
    }
  })

})
