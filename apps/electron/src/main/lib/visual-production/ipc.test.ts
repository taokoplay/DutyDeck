import { expect, test } from 'bun:test'
import { registerVisualProductionIpc } from './ipc'
import type { VisualProductionIpcEvent } from './ipc'

test('Given 非授权窗口 When 调用影像 IPC Then 不解析业务能力', async () => {
  let handler: ((event: VisualProductionIpcEvent, input: unknown) => Promise<unknown>) | undefined
  let disposed = false
  const registration = registerVisualProductionIpc({ ipc: { handle(_channel, callback) { handler = callback }, removeHandler() { disposed = true } }, isAuthorizedSender: () => false, createAccess() { throw new Error('不应创建能力') } })
  await expect(handler!({ sender: { id: 2 } }, { method: 'list', input: { sessionId: 'session' } })).rejects.toThrow('非法窗口')
  registration.dispose()
  expect(disposed).toBe(true)
})
