import { expect, test } from 'bun:test'
import type { IpcMain, IpcMainInvokeEvent } from 'electron'
import { COMPUTER_USE_IPC_CHANNELS as C } from '@dutydeck/shared'
import type { ComputerUseSnapshot } from '@dutydeck/shared'
import { registerComputerUseIpc } from './ipc'

/** 构造隔离 IPC 宿主，捕获真实 handler 与事件路由。 */
function fixture() {
  /** 注册到宿主的处理器和调用计数。 */
  const handlers = new Map<string, (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown>()
  const sent: unknown[] = []
  const calls: unknown[] = []
  const snapshot: ComputerUseSnapshot = { config: { enabled: false }, installation: null, operation: null }
  const owner = { isDestroyed: () => false, webContents: { isDestroyed: () => false, mainFrame: {}, send: (...args: unknown[]) => { sent.push(args) } } }
  let current: typeof owner | null = owner
  let listener!: (value: ComputerUseSnapshot) => void
  let choose: () => Promise<string | null> = async () => null
  /** 每种变更独立记账，便于证明拒绝发生在副作用之前。 */
  const service = { getSnapshot: () => snapshot, checkInstallation: async () => { calls.push('check'); return snapshot }, installDriver: async () => { calls.push('install'); return snapshot }, checkPermissions: async () => { calls.push('permissions'); return snapshot }, setEnabled: async (enabled: boolean) => { calls.push(enabled); return snapshot }, setDriverPath: async (path: string) => { calls.push(path); return snapshot }, stop: async (id: string) => { calls.push(id); return snapshot }, subscribe: (fn: typeof listener) => { listener = fn; return () => {} } }
  registerComputerUseIpc({ handle: (channel, handler) => { handlers.set(channel, handler) } } as Pick<IpcMain, 'handle'>, service, () => current, () => choose())
  /** 默认调用来自当前主窗口主 frame。 */
  const event = { sender: owner.webContents, senderFrame: owner.webContents.mainFrame } as unknown as IpcMainInvokeEvent
  return { calls, sent, snapshot, event, owner, changeOwner: () => { current = null }, choose: (fn: typeof choose) => { choose = fn }, emit: () => listener(snapshot), invoke: (channel: string, source = event, ...args: unknown[]) => handlers.get(channel)!(source, ...args) }
}

test('Given 非主 frame When 访问任意电脑控制接口 Then 无读取或变更权限', async () => {
  /** 每个可调用通道均采用同一身份门禁。 */
  const host = fixture()
  for (const channel of [C.GET_SNAPSHOT, C.CHECK_INSTALLATION, C.INSTALL_DRIVER, C.CHECK_PERMISSIONS, C.SET_ENABLED, C.STOP, C.CHOOSE_DRIVER]) {
    await expect(Promise.resolve().then(() => host.invoke(channel, { ...host.event, senderFrame: {} } as IpcMainInvokeEvent, true))).rejects.toThrow('仅允许主窗口')
  }
  expect(host.calls).toEqual([])
})

test('Given 主窗口 When 参数有效或非法 Then 固定动作执行且畸形参数拒绝', async () => {
  const host = fixture()
  await host.invoke(C.SET_ENABLED, host.event, true)
  await host.invoke(C.STOP, host.event, 'current-operation')
  await host.invoke(C.INSTALL_DRIVER)
  expect(host.calls).toEqual([true, 'current-operation', 'install'])
  expect(() => host.invoke(C.SET_ENABLED, host.event, 'true')).toThrow('状态无效')
  expect(() => host.invoke(C.STOP, host.event, '')).toThrow('标识无效')
})

test('Given 选择器取消或窗口被替换 When 选择完成 Then 保留旧配置或拒绝迟到写入', async () => {
  const host = fixture()
  expect(await host.invoke(C.CHOOSE_DRIVER)).toEqual(host.snapshot)
  expect(host.calls).toEqual([])
  host.choose(async () => { host.changeOwner(); return '/driver' })
  await expect(host.invoke(C.CHOOSE_DRIVER) as Promise<unknown>).rejects.toThrow('仅允许主窗口')
  expect(host.calls).toEqual([])
})

test('Given 状态含观察画面 When 推送 Then 仅发送当前主窗口且关闭后不发送', () => {
  const host = fixture()
  host.emit()
  expect(host.sent).toEqual([[C.CHANGED, host.snapshot]])
  host.changeOwner()
  host.emit()
  expect(host.sent).toHaveLength(1)
})
