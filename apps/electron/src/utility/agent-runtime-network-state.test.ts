import { expect, test } from 'bun:test'
import { createQueryNetworkState } from './agent-runtime-network-state'

test('query 网络状态仅接纳同身份的递增代次，取消后不复活', () => {
  const state = createQueryNetworkState({ bootId: 'boot', queryId: 'query', sessionId: 'session' }, { epoch: 0, proxyUrl: 'http://initial' })
  const notices: number[] = []
  state.subscribe((notice) => notices.push(notice.epoch))
  expect(state.accept({ bootId: 'old', queryId: 'query', sessionId: 'session' }, { epoch: 1 })).toBe(false)
  expect(state.accept({ bootId: 'boot', queryId: 'other', sessionId: 'session' }, { epoch: 1 })).toBe(false)
  expect(state.accept({ bootId: 'boot', queryId: 'query', sessionId: 'other' }, { epoch: 1 })).toBe(false)
  expect(state.accept({ bootId: 'boot', queryId: 'query', sessionId: 'session' }, { epoch: 1, proxyUrl: 'http://new' })).toBe(true)
  expect(state.accept({ bootId: 'boot', queryId: 'query', sessionId: 'session' }, { epoch: 1 })).toBe(false)
  expect(state.getSnapshot()?.proxyUrl).toBe('http://new')
  state.dispose()
  expect(state.accept({ bootId: 'boot', queryId: 'query', sessionId: 'session' }, { epoch: 2 })).toBe(false)
  expect(notices).toEqual([1])
})

test('拒绝损坏epoch并隔离监听器异常', () => {
  const identity = { bootId: 'b', queryId: 'q', sessionId: 's' }
  const state = createQueryNetworkState(identity, { epoch: 0 })
  const notices: number[] = []
  state.subscribe(() => { throw new Error('listener') })
  state.subscribe((notice) => notices.push(notice.epoch))
  expect(state.accept(identity, { epoch: NaN })).toBe(false)
  expect(state.accept(identity, { epoch: -1 })).toBe(false)
  expect(state.accept(identity, { epoch: 1.5 })).toBe(false)
  expect(state.accept(identity, { epoch: 2 })).toBe(true)
  expect(notices).toEqual([2])
})

test('快照保留合法恢复原因和时间，拒绝未声明字段', () => {
  const identity = { bootId: 'b', queryId: 'q', sessionId: 's' }
  const state = createQueryNetworkState(identity)
  state.accept(identity, { epoch: 0, reason: 'resume', lastChangedAt: 123, secret: 'discard' })
  expect(state.getSnapshot()).toMatchObject({ epoch: 0, reason: 'resume', lastChangedAt: 123 })
  expect(state.getSnapshot()).not.toHaveProperty('secret')
})
