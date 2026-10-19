import { describe, expect, test } from 'bun:test'
import type { AgentSubmitOrEnqueueInput } from '@dutydeck/shared'
import {
  createAgentQueueNowInput,
  prepareAgentCanvasMessageForSend,
} from './agent-canvas-message-preparation'
import { routeAgentSubmitOrEnqueue } from './agent-queue-routing'

/** 构造立即发送输入。 */
function createInput(): AgentSubmitOrEnqueueInput {
  return {
    sessionId: 'session-1', queueMessageId: 'message-1', userMessage: '继续',
    channelId: 'channel-1', dispatch: 'now',
  }
}

describe('Agent queue-now Canvas 引用路由', () => {
  test('Given 活跃会话的普通无引用消息 When 经 service queue-now 转换并注入 Then 保持字段缺失且 resolver 零调用', async () => {
    let resolverCalls = 0
    let injected = 0

    const result = await routeAgentSubmitOrEnqueue(createInput(), {
      isActive: () => true,
      prepareNow: (candidate) => prepareAgentCanvasMessageForSend(
        createAgentQueueNowInput(candidate),
        {},
        { resolveForSend: () => { resolverCalls += 1; throw new Error('不应调用') } },
      ),
      injectPrepared: async () => { injected += 1 },
      enqueue: () => { throw new Error('不应排队') },
      onStaleActive: () => undefined,
    })

    expect(result).toEqual({ disposition: 'injected' })
    expect(resolverCalls).toBe(0)
    expect(injected).toBe(1)
  })

  test('Given queue-now 显式携带 undefined 引用 When 经 service 转换 Then 保留畸形字段并稳定拒绝', async () => {
    let resolverCalls = 0
    let injected = 0
    const malformedInput = { ...createInput(), canvasNodeReferences: undefined }

    await expect(routeAgentSubmitOrEnqueue(malformedInput, {
      isActive: () => true,
      prepareNow: (candidate) => prepareAgentCanvasMessageForSend(
        createAgentQueueNowInput(candidate),
        {},
        { resolveForSend: () => { resolverCalls += 1; throw new Error('不应调用') } },
      ),
      injectPrepared: async () => { injected += 1 },
      enqueue: () => { throw new Error('不应排队') },
      onStaleActive: () => undefined,
    })).rejects.toMatchObject({ code: 'CANVAS_REFERENCE_INVALID' })

    expect(resolverCalls).toBe(0)
    expect(injected).toBe(0)
  })

  test('Given resolver 抛出与 stale-active 文案相同的错误 When 路由 Then 仍拒绝且不入 deferred', async () => {
    let enqueued = 0
    let prepareCalls = 0
    const error = Object.assign(new Error('当前会话没有正在运行的 Agent'), { code: 'CANVAS_REFERENCE_INVALID' })

    await expect(routeAgentSubmitOrEnqueue(createInput(), {
      isActive: () => true,
      prepareNow: () => { prepareCalls += 1; throw error },
      injectPrepared: async () => undefined,
      enqueue: () => { enqueued += 1 },
      onStaleActive: () => undefined,
    })).rejects.toBe(error)
    expect(prepareCalls).toBe(1)
    expect(enqueued).toBe(0)
  })

  test('Given Pi 注入返回 stale-active When 路由 Then 才降级 deferred', async () => {
    let enqueued = 0
    let prepareCalls = 0
    const result = await routeAgentSubmitOrEnqueue(createInput(), {
      isActive: () => true,
      prepareNow: () => { prepareCalls += 1; return { prepared: true } },
      injectPrepared: async () => { throw new Error('当前会话没有正在运行的 Agent') },
      enqueue: () => { enqueued += 1 },
      onStaleActive: () => undefined,
    })

    expect(result).toEqual({ disposition: 'queued' })
    expect(prepareCalls).toBe(1)
    expect(enqueued).toBe(1)
  })
})

/** 模块变更必须冻结在新运行中，不影响当前运行已解析的能力。 */
test('Given 显式模块 queue-now When 当前运行活跃 Then 零注入并转入下一轮', async () => {
  let enqueued = 0
  const result = await routeAgentSubmitOrEnqueue({ ...createInput(), moduleIds: ['canvas'] }, {
    isActive: () => true,
    prepareNow: () => { throw new Error('不应准备当前运行') },
    injectPrepared: async () => { throw new Error('不应注入当前运行') },
    enqueue: (input) => { expect(input.moduleIds).toEqual(['canvas']); enqueued += 1 },
    onStaleActive: () => undefined,
  })
  expect(result.disposition).toBe('queued')
  expect(enqueued).toBe(1)
})

/** 解析正文后才识别模块时，运行时拒绝会交回队列而非丢弃正文。 */
test('Given 注入阶段识别模块变更 When 返回新运行错误 Then 正文仍被排队一次', async () => {
  let enqueued = 0
  const input = { ...createInput(), userMessage: '/module:canvas 创建节点' }
  const result = await routeAgentSubmitOrEnqueue(input, {
    isActive: () => true, prepareNow: () => input,
    injectPrepared: async () => { throw new Error('AGENT_MODULE_REQUIRES_NEW_RUN') },
    enqueue: (candidate) => { expect(candidate.userMessage).toBe(input.userMessage); enqueued += 1 },
    onStaleActive: () => undefined,
  })
  expect(result.disposition).toBe('queued')
  expect(enqueued).toBe(1)
})
