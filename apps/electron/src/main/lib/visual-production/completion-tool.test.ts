import { describe, expect, test } from 'bun:test'
import { buildVisualProductionAgentTools } from './agent-tools'
import { createVisualDeliveryCheck } from './delivery-check'

describe('影像交付工具边界', () => {
  test('Given 只读权限 When 声明交付 Then 只核验宿主事实且不能伪造写入', async () => {
    const delivery = createVisualDeliveryCheck(['production'])
    const permissions: boolean[] = []
    const options = {
      sessionId: 'session',
      sdk: { defineTool: (definition: unknown) => definition } as Parameters<typeof buildVisualProductionAgentTools>[0]['sdk'],
      assertAccess(write: boolean) { permissions.push(write) },
      execute: (async () => { throw new Error('声明交付不能执行领域写入') }) as Parameters<typeof buildVisualProductionAgentTools>[0]['execute'],
      completeTask: delivery.complete,
    }
    const tool = buildVisualProductionAgentTools(options).find(item => item.name === 'visual_production_complete_task')
    expect(tool).toBeDefined()
    await expect(tool!.execute('call', { outcome: 'written', productionIds: ['production'], reason: '聊天里写好了' }, new AbortController().signal, undefined, {} as never)).rejects.toThrow('正式写入')
    await tool!.execute('call', { outcome: 'read-only', productionIds: ['production'], reason: '仅讨论方案' }, new AbortController().signal, undefined, {} as never)
    expect(permissions).toEqual([false, false])
    expect(delivery.pending()).toBeNull()
    /** 工具不允许模型替换会话归属或跳过严格 schema。 */
    await expect(tool!.execute('call', { outcome: 'blocked', productionIds: [], reason: '受阻', sessionId: 'other' }, new AbortController().signal, undefined, {} as never)).rejects.toThrow('INVALID_INPUT')
  })

  test('Given 已取消运行 When 声明交付 Then 在回调前拒绝', async () => {
    let called = false
    const options = {
      sessionId: 'session', sdk: { defineTool: (definition: unknown) => definition } as Parameters<typeof buildVisualProductionAgentTools>[0]['sdk'], assertAccess() {},
      execute: (async () => { throw new Error('不调用领域服务') }) as Parameters<typeof buildVisualProductionAgentTools>[0]['execute'],
      completeTask() { called = true; return {} },
    }
    const tool = buildVisualProductionAgentTools(options).find(item => item.name === 'visual_production_complete_task')
    expect(tool).toBeDefined()
    const controller = new AbortController()
    controller.abort(new Error('cancelled'))
    await expect(tool!.execute('call', { outcome: 'read-only', productionIds: [], reason: '已停止' }, controller.signal, undefined, {} as never)).rejects.toThrow('cancelled')
    expect(called).toBe(false)
  })
})
