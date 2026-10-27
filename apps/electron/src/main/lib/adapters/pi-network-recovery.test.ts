import { describe, expect, test } from 'bun:test'
import type { StreamFn } from '@earendil-works/pi-agent-core'
import type { AssistantMessage, Model, Api } from '@earendil-works/pi-ai'
import { normalizeContext } from '@earendil-works/pi-ai'
import { isRetryableAssistantError } from '@earendil-works/pi-ai/compat'
import { createAssistantMessageEventStream } from '@earendil-works/pi-ai/utils/event-stream'
import type { NetworkRecoveryNotice } from '@dutydeck/shared'
import { createRecoveringPiStream, type PiNetworkRecoverySource } from './pi-network-recovery'
import { getPiRequestProxyDispatcher } from './pi-request-proxy'

/** 离线模型夹具，无真实请求或凭据。 */
const model = { id: 'fixture', api: 'openai-responses', provider: 'openai' } as Model<Api>
/** 经 Pi 规范化的空上下文，用于调用要求 TranscriptContext 的流接口。 */
const emptyContext = normalizeContext({ messages: [] })
/** 最小合法模型终态。 */
function message(): AssistantMessage {
  return { role: 'assistant', content: [], api: model.api, provider: model.provider, model: model.id,
    stopReason: 'stop', timestamp: Date.now(), usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } }
}
/** 可观察的网络代次源，用于断言终态后退订。 */
function source(): PiNetworkRecoverySource & { change(): void; size(): number } {
  /** 当前通知与活跃订阅集合。 */
  let current: NetworkRecoveryNotice = { epoch: 1 }
  const listeners = new Set<(notice: NetworkRecoveryNotice) => void>()
  return { getSnapshot: () => current, subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener) },
    change() { current = { epoch: current.epoch + 1, proxyUrl: 'http://127.0.0.1:7897' }; for (const listener of listeners) listener(current) },
    size: () => listeners.size }
}

describe('provider-only network recovery', () => {
  test('Given unchanged network When provider is silent Then it remains active until user cancellation', async () => {
    const network = source()
    const root = new AbortController()
    const wrapped = createRecoveringPiStream(() => createAssistantMessageEventStream(), { source: network, stallTimeoutMs: 10 })
    const output = await wrapped(model, emptyContext, { signal: root.signal })
    await Bun.sleep(25)
    expect(network.size()).toBe(1)
    root.abort()
    expect((await output.result()).stopReason).toBe('aborted')
    expect(network.size()).toBe(0)
  })

  test('Given changed network and hung provider When grace expires Then emits one retryable error and releases subscriptions', async () => {
    const network = source()
    const inner = createAssistantMessageEventStream()
    const wrapped = createRecoveringPiStream(() => inner, { source: network, stallTimeoutMs: 10 })
    const output = await wrapped(model, emptyContext)
    network.change()
    const result = await output.result()
    expect(result.stopReason).toBe('error')
    expect(isRetryableAssistantError(result)).toBe(true)
    expect(network.size()).toBe(0)
    inner.push({ type: 'done', reason: 'stop', message: message() })
    const events = []
    for await (const event of output) events.push(event.type)
    expect(events).toEqual(['error'])
  })

  test('Given network changed When provider completes before grace Then success wins and late changes do nothing', async () => {
    const network = source()
    const inner = createAssistantMessageEventStream()
    const wrapped = createRecoveringPiStream(() => inner, { source: network, stallTimeoutMs: 10 })
    const output = await wrapped(model, emptyContext)
    network.change()
    inner.push({ type: 'done', reason: 'stop', message: message() })
    expect((await output.result()).stopReason).toBe('stop')
    network.change()
    await Bun.sleep(15)
    expect(network.size()).toBe(0)
  })

  test('Given network changed When user aborts before grace Then cancellation never becomes a retry', async () => {
    const network = source()
    const root = new AbortController()
    const wrapped = createRecoveringPiStream(() => new Promise(() => {}), { source: network, stallTimeoutMs: 10 })
    const output = await wrapped(model, emptyContext, { signal: root.signal })
    network.change()
    root.abort()
    const result = await output.result()
    expect(result.stopReason).toBe('aborted')
    expect(isRetryableAssistantError(result)).toBe(false)
    expect(network.size()).toBe(0)
  })

  test('Given native retry When proxy changes Then each provider invocation obtains the latest snapshot and transport', async () => {
    const network = source()
    const seen: Array<string | undefined> = []
    const provider: StreamFn = (_model, _context, options) => {
      seen.push(options?.transport)
      const stream = createAssistantMessageEventStream()
      stream.push({ type: 'done', reason: 'stop', message: message() })
      return stream
    }
    const wrapped = createRecoveringPiStream(provider, { source: network,
      requestOptions: (notice) => ({ transport: notice?.proxyUrl ? 'sse' : 'auto' }) })
    await (await wrapped(model, emptyContext)).result()
    network.change()
    await (await wrapped(model, emptyContext)).result()
    expect(seen).toEqual(['auto', 'sse'])
  })

  test('Given changed network When provider progresses Then later long reasoning is not subject to the old grace period', async () => {
    const network = source()
    const inner = createAssistantMessageEventStream()
    const wrapped = createRecoveringPiStream(() => inner, { source: network, stallTimeoutMs: 100 })
    const output = await wrapped(model, emptyContext)
    network.change()
    inner.push({ type: 'start', partial: message() })
    await Bun.sleep(150)
    inner.push({ type: 'done', reason: 'stop', message: message() })
    expect((await output.result()).stopReason).toBe('stop')
  })

  test('Given lazy provider When its factory awaits Then its fetch scope remains isolated from product tools', async () => {
    let insideScope = false
    const wrapped = createRecoveringPiStream(async () => {
      await Bun.sleep(1)
      insideScope = getPiRequestProxyDispatcher() !== undefined
      const inner = createAssistantMessageEventStream()
      inner.push({ type: 'done', reason: 'stop', message: message() })
      return inner
    }, { requestOptions: () => ({ direct: true }) })
    const output = await wrapped(model, emptyContext)
    expect(getPiRequestProxyDispatcher()).toBeUndefined()
    await output.result()
    expect(insideScope).toBe(true)
    expect(getPiRequestProxyDispatcher()).toBeUndefined()
  })

  test('Given already aborted request When wrapping provider Then no provider is started', async () => {
    const root = new AbortController()
    root.abort()
    let calls = 0
    const wrapped = createRecoveringPiStream(() => { calls++; return createAssistantMessageEventStream() }, {})
    expect((await (await wrapped(model, emptyContext, { signal: root.signal })).result()).stopReason).toBe('aborted')
    expect(calls).toBe(0)
  })
})
