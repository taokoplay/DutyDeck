import { describe, expect, test } from 'bun:test'
import { createModuleReceiptPoller } from './module-receipt-poller'

/** 等待 Promise 的完成与 finally 排程。 */
async function flush(): Promise<void> { await Promise.resolve(); await Promise.resolve(); await Promise.resolve() }

describe('当前可见会话的模块回执轮询', () => {
  test('空回执也继续低频发现新命令，隐藏暂停、恢复立即读取、卸载清理', async () => {
    let visible = true
    let visibilityChanged = (): void => undefined
    let scheduled: (() => void) | undefined
    let calls = 0
    let unsubscribed = false
    const poller = createModuleReceiptPoller({
      load: async () => { calls++ },
      isVisible: () => visible,
      subscribeVisibility: (callback) => { visibilityChanged = callback; return () => { unsubscribed = true } },
      schedule: (callback, delay) => { expect(delay).toBe(3000); scheduled = callback; return () => { scheduled = undefined } },
    })
    await flush()
    expect(calls).toBe(1)
    scheduled?.()
    await flush()
    expect(calls).toBe(2)
    visible = false
    visibilityChanged()
    expect(scheduled).toBeUndefined()
    poller.refresh()
    expect(calls).toBe(2)
    visible = true
    visibilityChanged()
    await flush()
    expect(calls).toBe(3)
    poller.dispose()
    expect(unsubscribed).toBe(true)
    expect(scheduled).toBeUndefined()
  })

  test('慢请求期间不会并发读取，切会话卸载后丢弃迟到结果', async () => {
    let complete!: () => void
    let calls = 0
    let published = false
    let scheduled = false
    const poller = createModuleReceiptPoller({
      load: async (isCurrent) => { calls++; await new Promise<void>((resolve) => { complete = resolve }); published = isCurrent() },
      isVisible: () => true,
      subscribeVisibility: () => () => undefined,
      schedule: () => { scheduled = true; return () => undefined },
    })
    poller.refresh()
    poller.refresh()
    expect(calls).toBe(1)
    poller.dispose()
    complete()
    await flush()
    expect(published).toBe(false)
    expect(scheduled).toBe(false)
  })
})
