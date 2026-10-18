import { describe, expect, test } from 'bun:test'
import type { AgentDeferredQueueMessageInput, AgentQueuedMessageStatus, VisualProductionReference } from '@dutydeck/shared'
import type { WebContents } from 'electron'
import { routeAgentSubmitOrEnqueue } from './agent-queue-routing'
import { AgentQueueCoordinator } from './agent-queue-coordinator'
import type { PreparedAgentQueueRun } from './agent-queue-coordinator'

/** 引用在排队过程中固定版本。 */
const reference: VisualProductionReference = { workspaceId: 'w', productionId: 'p', productionRevision: 3, target: { kind: 'shot', shotId: 's' }, title: '镜头', productionTitle: '作品' }
/** 不访问真实会话或窗口的入队输入。 */
const input: AgentDeferredQueueMessageInput = { sessionId: 's', queueMessageId: 'm', userMessage: '', channelId: 'c', visualProductionReferences: [reference] }
describe('影像引用新运行队列边界', () => {
  test('Given 活跃运行 When 带影像引用立即发送 Then 等待新运行而非混入旧图片上下文', async () => {
    let injected = 0
    let queued: AgentDeferredQueueMessageInput | undefined
    const result = await routeAgentSubmitOrEnqueue({ ...input, dispatch: 'now' }, { isActive: () => true, prepareNow: () => { throw new Error('不应准备旧运行') }, injectPrepared: async () => { injected++ }, enqueue: candidate => { queued = candidate }, onStaleActive() {} })
    expect(result.disposition).toBe('queued')
    expect(injected).toBe(0)
    expect(queued?.visualProductionReferences).toEqual([reference])
  })
  test('Given 异步校验等待 When 用户取消队首 Then 不发布started或启动已取消对象', async () => {
    let aborted = false
    const statuses: AgentQueuedMessageStatus[] = []
    let runs = 0
    const coordinator = new AgentQueueCoordinator({
      isActive: () => false,
      getWebContents: () => ({ isDestroyed: () => false }) as unknown as WebContents,
      prepareRun: (_input, signal) => new Promise<PreparedAgentQueueRun>((_resolve, reject) => {
        signal?.addEventListener('abort', () => { aborted = true; reject(new Error('已取消')) }, { once: true })
      }),
      startRun: async () => { runs++ },
      sendStatus: (_window, status) => { statuses.push(status) },
      onPrepareError: () => ({ code: 'VISUAL_REFERENCE_INVALID', message: '过期' }),
    })
    coordinator.enqueue(input)
    coordinator.cancel({ sessionId: 's', messageId: 'm' })
    await new Promise<void>((resolve) => setTimeout(resolve, 0))
    expect(aborted).toBe(true)
    expect(runs).toBe(0)
    expect(statuses.filter(status => status.status === 'started')).toHaveLength(0)
    expect(coordinator.isDispatching('s')).toBe(false)
  })
  for (const action of ['cancel', 'clear'] as const) {
    test(`Given 读取不响应取消 When ${action} 后排入新消息 Then 立即释放槽位且迟到结果不影响新准备`, async () => {
      /** 保存两个异步读取的返回入口，模拟底层暂时无法中断的 I/O。 */
      const pending: Array<{ signal?: AbortSignal; finish(prepared: PreparedAgentQueueRun): void }> = []
      /** 仅记录实际启动，不请求模型。 */
      const runs: string[] = []
      const coordinator = new AgentQueueCoordinator({
        isActive: () => false,
        getWebContents: () => ({ isDestroyed: () => false }) as unknown as WebContents,
        prepareRun: (_input, signal) => new Promise<PreparedAgentQueueRun>(resolve => { pending.push({ signal, finish: resolve }) }),
        startRun: async prepared => { runs.push(prepared.input.queueMessageId) },
        sendStatus() {},
        onPrepareError: () => ({ code: 'VISUAL_REFERENCE_INVALID', message: '过期' }),
      })
      coordinator.enqueue(input)
      if (action === 'cancel') coordinator.cancel({ sessionId: 's', messageId: 'm' })
      else coordinator.clear('s')
      expect(pending[0]?.signal?.aborted).toBe(true)
      expect(coordinator.isDispatching('s')).toBe(false)
      /** 后续消息的准备应立即开始，旧回调不能删除其占用标记。 */
      const next = { ...input, queueMessageId: 'next' }
      coordinator.enqueue(next)
      expect(pending).toHaveLength(2)
      pending[0]!.finish({ input, extensions: {}, references: undefined })
      await Promise.resolve()
      expect(coordinator.isDispatching('s')).toBe(true)
      expect(runs).toEqual([])
      pending[1]!.finish({ input: next, extensions: {}, references: undefined })
      await new Promise<void>(resolve => setTimeout(resolve, 0))
      expect(runs).toEqual(['next'])
      expect(coordinator.isDispatching('s')).toBe(false)
    })
  }
  test('Given 异步校验失败 When 解析结束 Then 返回可恢复失败状态且保留原目标身份', async () => {
    const statuses: AgentQueuedMessageStatus[] = []
    const coordinator = new AgentQueueCoordinator({ isActive: () => false, getWebContents: () => ({ isDestroyed: () => false }) as unknown as WebContents, prepareRun: async () => { throw new Error('过期') }, startRun: async () => { throw new Error('不应启动') }, sendStatus: (_window, status) => { statuses.push(status) }, onPrepareError: () => ({ code: 'VISUAL_REFERENCE_INVALID', message: '影像引用版本已变化' }) })
    coordinator.enqueue(input)
    await Promise.resolve()
    await Promise.resolve()
    expect(statuses[0]).toMatchObject({ status: 'failed', messageId: 'm', error: { code: 'VISUAL_REFERENCE_INVALID' } })
    expect(coordinator.hasPending('s')).toBe(false)
  })
})
