import { describe, expect, test } from 'bun:test'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AgentModuleManifest, AgentSessionModulePolicy } from '@dutydeck/shared'
import { AgentModuleCommandBus } from './module-command-bus'
import { AgentModuleCommandStore } from './module-command-store'

const moduleManifest: AgentModuleManifest = {
  id: 'canvas', version: '1.0.0', apiVersion: 1, displayName: '画布', description: '画布', icon: 'layout',
  scope: 'project', contributions: ['tool'], skillRefs: [], promptRefs: [], toolRefs: ['canvas.create_node'], artifactTypes: [], surfaceIds: ['canvas'], requiredPermissions: [],
}
const policy: AgentSessionModulePolicy = { mode: 'pinned', enabledModuleIds: ['canvas'], disabledModuleIds: [], pinnedModuleIds: ['canvas'], revision: 3, updatedAt: 10 }

function createBus(): AgentModuleCommandBus {
  const root = mkdtempSync(join(tmpdir(), 'dutydeck-module-command-bus-'))
  return new AgentModuleCommandBus({
    getModule: id => id === 'canvas' ? moduleManifest : undefined,
    getPolicy: () => policy,
    now: () => 100,
    store: new AgentModuleCommandStore({ resolvePath: (sessionId) => join(root, `${sessionId}.json`) }),
  })
}

describe('Agent 模块命令总线', () => {
  test('重启后从持久化 outbox 恢复 queued 命令并允许带 Session 身份推进状态', () => {
    const root = mkdtempSync(join(tmpdir(), 'dutydeck-module-command-reopen-'))
    const store = new AgentModuleCommandStore({ resolvePath: (sessionId) => join(root, `${sessionId}.json`) })
    const first = new AgentModuleCommandBus({ getModule: id => id === 'canvas' ? moduleManifest : undefined, getPolicy: () => policy, now: () => 100, store })
    const command = first.submit({ sessionId: 'session-a', moduleId: 'canvas', capabilityId: 'canvas.create_node', baseRevision: 3, invocationMode: 'invoke', requestSummary: '创建节点', input: {}, idempotencyKey: 'restart-1' })
    const reopened = new AgentModuleCommandBus({ getModule: id => id === 'canvas' ? moduleManifest : undefined, getPolicy: () => policy, now: () => 200, store })
    expect(reopened.markRunning(command.commandId, 'session-a').status).toBe('running')
    expect(reopened.markApplied(command.commandId, 'session-a').status).toBe('applied')
  })

  test('提交、运行、完成形成单向状态机', () => {
    const bus = createBus()
    const command = bus.submit({ sessionId: 'session-a', moduleId: 'canvas', capabilityId: 'canvas.create_node', baseRevision: 3, invocationMode: 'invoke', deliveryMode: 'enqueue', requestSummary: '创建节点', input: { title: 'A' }, idempotencyKey: 'run-1' })
    expect(command.status).toBe('queued')
    expect(bus.markRunning(command.commandId).status).toBe('running')
    expect(bus.markApplied(command.commandId).status).toBe('applied')
    expect(() => bus.cancel(command.commandId)).toThrow('AGENT_MODULE_COMMAND_TERMINAL')
  })

  test('重复幂等键返回同一命令且不会重复入队', () => {
    const bus = createBus()
    const input = { sessionId: 'session-a', moduleId: 'canvas', capabilityId: 'canvas.create_node', baseRevision: 3, invocationMode: 'invoke' as const, requestSummary: '创建节点', input: {}, idempotencyKey: 'same' }
    const first = bus.submit(input)
    const second = bus.submit(input)
    expect(second.commandId).toBe(first.commandId)
    expect(bus.list('session-a')).toHaveLength(1)
  })

  test('版本过期、禁用和跨会话查询都会被拒绝或隔离', () => {
    const bus = createBus()
    expect(() => bus.submit({ sessionId: 'session-a', moduleId: 'canvas', capabilityId: 'canvas.create_node', baseRevision: 2, invocationMode: 'invoke', requestSummary: 'x', input: {}, idempotencyKey: 'stale' })).toThrow('AGENT_MODULE_POLICY_REVISION_CONFLICT')
    expect(() => bus.submit({ sessionId: 'session-a', moduleId: 'missing', capabilityId: 'x', baseRevision: 3, invocationMode: 'invoke', requestSummary: 'x', input: {}, idempotencyKey: 'missing' })).toThrow('AGENT_MODULE_NOT_FOUND')
    expect(bus.list('session-b')).toEqual([])
  })
})
