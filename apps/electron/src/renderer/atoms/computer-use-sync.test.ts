import { expect, test } from 'bun:test'
import type { ComputerUseApi, ComputerUseSnapshot } from '@dutydeck/shared'
import { connectComputerUse } from './computer-use-sync'

test('Given 初次读取未完成 When 收到新状态 Then 迟到读取不覆盖事件且卸载清理', async () => {
  /** 手动控制旧快照完成时间。 */
  let resolve!: (value: ComputerUseSnapshot) => void
  /** 模拟宿主状态变化。 */
  let listener!: (value: ComputerUseSnapshot) => void
  /** 记录页面收到的状态及清理。 */
  const received: ComputerUseSnapshot[] = []
  let removed = false
  /** 初始关闭与新的启用状态。 */
  const old = { config: { enabled: false }, installation: null, operation: null }
  const fresh = { ...old, config: { enabled: true } }
  /** 可控的只读服务。 */
  const api = { getSnapshot: () => new Promise<ComputerUseSnapshot>(r => { resolve = r }), onChanged: (fn: typeof listener) => { listener = fn; return () => { removed = true } } } as ComputerUseApi
  /** 单次挂载连接。 */
  const connection = connectComputerUse(api, value => received.push(value), () => {})
  listener(fresh)
  resolve(old)
  await Promise.resolve()
  expect(received).toEqual([fresh])
  connection.dispose()
  listener(old)
  expect(received).toEqual([fresh])
  expect(removed).toBe(true)
})

test('Given 当前操作 When 停止失败 Then 保持快照并呈现错误；卸载后忽略迟到结果', async () => {
  /** 模拟当前状态与错误反馈。 */
  const current: ComputerUseSnapshot = { config: { enabled: true }, installation: null, operation: { id: 'op', sessionId: 's', pid: 1, windowId: '2', title: 'App', startedAt: 1, status: 'active' } }
  const received: ComputerUseSnapshot[] = []
  const errors: Array<string | null> = []
  const api = { getSnapshot: async () => current, onChanged: () => () => {} } as unknown as ComputerUseApi
  const connection = connectComputerUse(api, value => received.push(value), error => errors.push(error))
  await Promise.resolve()
  await connection.run(async () => { throw new Error('停止失败') })
  expect(received).toEqual([current])
  expect(errors.at(-1)).toBe('停止失败')
  let resolve!: (value: ComputerUseSnapshot) => void
  const pending = connection.run(() => new Promise<ComputerUseSnapshot>(r => { resolve = r }))
  connection.dispose()
  resolve({ ...current, operation: null })
  await pending
  expect(received).toEqual([current])
})
