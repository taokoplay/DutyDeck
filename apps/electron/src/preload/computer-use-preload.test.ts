import { expect, test } from 'bun:test'
import { createComputerUsePreload } from './computer-use-preload'
import { COMPUTER_USE_IPC_CHANNELS as C } from '@dutydeck/shared'

test('Given 电脑控制桥 When 配置与停止 Then 只调用固定通道并清理订阅', async () => {
  /** 捕获桥接参数，确保没有任意动作入口。 */
  const calls: unknown[][] = []
  /** 模拟 Electron 事件订阅。 */
  const listeners = new Set<(...args: unknown[]) => void>()
  /** 固定接口的测试实例。 */
  const api = createComputerUsePreload({ invoke: async (...args) => { calls.push(args) }, on: (_c, fn) => { listeners.add(fn) }, removeListener: (_c, fn) => { listeners.delete(fn) } })
  await api.setEnabled(true)
  await api.chooseDriver()
  await api.installDriver()
  await api.stop('operation')
  expect(calls).toEqual([[C.SET_ENABLED, true], [C.CHOOSE_DRIVER], [C.INSTALL_DRIVER], [C.STOP, 'operation']])
  /** 用户订阅的解除函数。 */
  const off = api.onChanged(() => {})
  expect(listeners.size).toBe(1)
  off()
  expect(listeners.size).toBe(0)
  expect(Object.keys(api).sort()).toEqual(['checkInstallation', 'checkPermissions', 'chooseDriver', 'getSnapshot', 'installDriver', 'onChanged', 'setEnabled', 'stop'])
})
