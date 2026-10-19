import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AgentModuleCommandInput, AgentModuleManifest } from '@dutydeck/shared'
import { AgentModuleCommandBus } from './module-command-bus'
import { AgentModuleCommandStore } from './module-command-store'
import { AgentModuleCommandDispatcher } from './module-command-dispatcher'

/** 每项测试的临时数据根，结束后删除。 */
const roots: string[] = []
afterEach(() => roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true })))
/** 完整声明的测试模块。 */
const manifest: AgentModuleManifest = {
  id: 'canvas', version: '1.0.0', apiVersion: 1, displayName: '画布', description: '画布', icon: 'layout',
  scope: 'project', contributions: ['tool'], skillRefs: [], promptRefs: [], toolRefs: ['canvas.create_node'], artifactTypes: [], surfaceIds: [], requiredPermissions: [],
}
/** 每次工厂创建独立 outbox；reopen 保留同一磁盘事实。 */
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'module-dispatch-'))
  roots.push(root)
  const store = new AgentModuleCommandStore({ resolvePath: (sessionId) => join(root, `${sessionId}.json`) })
  const reopen = () => new AgentModuleCommandBus({ store, getModule: () => manifest, getPolicy: () => ({ mode: 'auto', revision: 0, updatedAt: 0, enabledModuleIds: [], disabledModuleIds: [], pinnedModuleIds: [] }) })
  const bus = reopen()
  const input: AgentModuleCommandInput = { sessionId: 's1', moduleId: 'canvas', capabilityId: 'canvas.create_node', baseRevision: 0, invocationMode: 'invoke', deliveryMode: 'enqueue', requestSummary: '创建节点', input: {}, idempotencyKey: 'once' }
  return { bus, reopen, input }
}

describe('模块命令真实派发协调', () => {
  test('Given 首次请求 When 重叠提交及重启重复 Then 只派发一次并返回同一回执', async () => {
    const { bus, reopen, input } = fixture()
    const dispatcher = new AgentModuleCommandDispatcher({ bus, cancelQueued: () => false })
    let calls = 0
    const dispatch = async () => { calls += 1; await Promise.resolve() }
    const [first, second] = await Promise.all([dispatcher.submit(input, dispatch), dispatcher.submit(input, dispatch)])
    const restarted = await new AgentModuleCommandDispatcher({ bus: reopen(), cancelQueued: () => false }).submit(input, dispatch)
    expect(calls).toBe(1)
    expect(second.commandId).toBe(first.commandId)
    expect(restarted.commandId).toBe(first.commandId)
  })

  test('Given 排队命令 When 精确撤销真实队列 Then 才提交 canceled', async () => {
    const { bus, input } = fixture()
    const queue = new Set<string>()
    const dispatcher = new AgentModuleCommandDispatcher({ bus, cancelQueued: (_sessionId, commandId) => queue.delete(commandId) })
    const command = await dispatcher.submit(input, async (item) => { queue.add(item.commandId) })
    queue.add('other-command')
    expect(dispatcher.cancel(command).status).toBe('canceled')
    expect([...queue]).toEqual(['other-command'])
    expect(dispatcher.cancel(command).status).toBe('canceled')
  })

  test('Given 队列已取出或命令运行中 When 取消 Then 明确未确认且不伪造状态', async () => {
    const { bus, input } = fixture()
    const dispatcher = new AgentModuleCommandDispatcher({ bus, cancelQueued: () => false })
    const command = await dispatcher.submit(input, async () => {})
    expect(() => dispatcher.cancel(command)).toThrow('AGENT_MODULE_COMMAND_CANCEL_UNCONFIRMED')
    expect(bus.list(input.sessionId)[0]?.status).toBe('queued')
    bus.markRunning(command.commandId, input.sessionId)
    expect(() => dispatcher.cancel(command)).toThrow('AGENT_MODULE_COMMAND_CANCEL_UNCONFIRMED')
    expect(bus.list(input.sessionId)[0]?.status).toBe('running')
  })

  test('Given 运行终态早于异常 When 派发失败 Then 保留终态且错误不回显秘密', async () => {
    const { bus, input } = fixture()
    const dispatcher = new AgentModuleCommandDispatcher({ bus, cancelQueued: () => false })
    await expect(dispatcher.submit(input, async (command) => {
      bus.markRunning(command.commandId, input.sessionId)
      bus.markApplied(command.commandId, input.sessionId)
      throw new Error('secret-token')
    })).rejects.toThrow('AGENT_MODULE_COMMAND_DISPATCH_FAILED')
    expect(bus.list(input.sessionId)[0]?.status).toBe('applied')
  })

  test('Given 派发拒绝 When 重试同一键 Then 稳定错误回执且不重复派发', async () => {
    const { bus, input } = fixture()
    const dispatcher = new AgentModuleCommandDispatcher({ bus, cancelQueued: () => false })
    await expect(dispatcher.submit(input, async () => { throw new Error('secret-token') })).rejects.toThrow('AGENT_MODULE_COMMAND_DISPATCH_FAILED')
    const result = await dispatcher.submit(input, async () => { throw new Error('不应执行') })
    expect(result.errorCode).toBe('AGENT_MODULE_COMMAND_DISPATCH_FAILED')
  })

  test('Given 同一幂等键跨会话 When 提交和跨会话取消 Then 两条命令独立且拒绝错误身份', async () => {
    // 两个会话共享总线，但幂等键只在各自 outbox 内生效。
    const { bus, input } = fixture()
    const dispatcher = new AgentModuleCommandDispatcher({ bus, cancelQueued: () => true })
    const first = await dispatcher.submit(input, async () => {})
    const second = await dispatcher.submit({ ...input, sessionId: 's2' }, async () => {})
    expect(second.commandId).not.toBe(first.commandId)
    expect(() => dispatcher.cancel({ sessionId: 's2', commandId: first.commandId })).toThrow('AGENT_MODULE_COMMAND_NOT_FOUND')
    expect(bus.list('s1')[0]?.status).toBe('queued')
    expect(bus.list('s2')[0]?.status).toBe('queued')
  })

  test('Given 队列取消同步触发运行时丢弃回调 When 撤销 Then 复用 canceled 终态', async () => {
    // 模拟生产 coordinator.cancel 同步 notifyDiscard，状态可能早于 dispatcher 返回落盘。
    const { bus, input } = fixture()
    const dispatcher = new AgentModuleCommandDispatcher({ bus, cancelQueued: (sessionId, commandId) => {
      bus.markCanceled(commandId, sessionId)
      return true
    } })
    const command = await dispatcher.submit(input, async () => {})
    expect(dispatcher.cancel(command).status).toBe('canceled')
  })

  test('Given 失败终态 When 迟到完成回调到达 Then 不覆盖已保存失败', async () => {
    // 失败与完成竞争时以首个已提交终态为准。
    const { bus, input } = fixture()
    const dispatcher = new AgentModuleCommandDispatcher({ bus, cancelQueued: () => false })
    const command = await dispatcher.submit(input, async (item) => {
      bus.markRunning(item.commandId, item.sessionId)
      bus.markFailed(item.commandId, 'AGENT_MODULE_COMMAND_FAILED', item.sessionId)
    })
    expect(() => bus.markApplied(command.commandId, command.sessionId)).toThrow('AGENT_MODULE_COMMAND_TERMINAL')
    expect(bus.list(command.sessionId)[0]?.status).toBe('failed')
  })
})
