import { expect, test } from 'bun:test'
import { createStore } from 'jotai'
import type { ComputerUseApi, ComputerUseSnapshot } from '@dutydeck/shared'
import { computerUseStateAtom } from './computer-use'

test('Given 安装检测仍等待 When 用户停止当前操作 Then 立即调用宿主且按操作身份去重', async () => {
  /** 保持检测和停止均未返回，覆盖并发状态。 */
  let finishCheck!: (snapshot: ComputerUseSnapshot) => void
  let finishStop!: (snapshot: ComputerUseSnapshot) => void
  /** 宿主真实活动租约与调用记录。 */
  const snapshot: ComputerUseSnapshot = { config: { enabled: true }, installation: null, operation: { id: 'active-op', sessionId: 's', pid: 1, windowId: '2', title: 'Window', startedAt: 1, status: 'active' } }
  const calls: string[] = []
  const api = {
    getSnapshot: async () => snapshot,
    onChanged: () => () => {},
    checkInstallation: () => new Promise<ComputerUseSnapshot>(resolve => { finishCheck = resolve }),
    stop: (id: string) => { calls.push(id); return new Promise<ComputerUseSnapshot>(resolve => { finishStop = resolve }) },
  } as unknown as ComputerUseApi
  /** 保存全局，结束后还原以免影响其他测试。 */
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'window')
  Object.defineProperty(globalThis, 'window', { configurable: true, value: { electronAPI: { computerUse: api } } })
  const store = createStore()
  const unsubscribe = store.sub(computerUseStateAtom, () => {})
  try {
    await Promise.resolve()
    const check = store.get(computerUseStateAtom).request!(api => api.checkInstallation())
    expect(store.get(computerUseStateAtom).busy).toBe(true)
    const stop = store.get(computerUseStateAtom).stop?.('active-op')
    expect(calls).toEqual(['active-op'])
    await store.get(computerUseStateAtom).stop?.('active-op')
    expect(calls).toEqual(['active-op'])
    expect(store.get(computerUseStateAtom).stoppingOperationId).toBe('active-op')
    finishStop({ ...snapshot, operation: null })
    await stop
    expect(store.get(computerUseStateAtom).snapshot?.operation).toBeNull()
    expect(store.get(computerUseStateAtom).busy).toBe(true)
    finishCheck(snapshot)
    await check
    expect(store.get(computerUseStateAtom).snapshot?.operation).toBeNull()
  } finally {
    unsubscribe()
    if (descriptor) Object.defineProperty(globalThis, 'window', descriptor)
    else Reflect.deleteProperty(globalThis, 'window')
  }
})
