import { expect, test } from 'bun:test'
import type { ComputerUseDriver } from './driver'
import { ComputerUseService } from './service'

/** 可控安装任务；只测试宿主状态机，不安装真实组件。 */
function fixture() {
  /** 安装次数与延迟完成点，用于验证重复点击互斥。 */
  let installs = 0
  let finish!: () => void
  let fail!: (error: Error) => void
  let compatible = false
  /** 仍走真实路径选择和版本确认的模拟驱动。 */
  const driver: ComputerUseDriver = {
    validatePath: async () => {},
    check: async path => ({ platform: 'macos', status: compatible ? 'installed' : 'needs_attention', version: compatible ? '0.38.0' : '0.17.0', driverPath: path ?? '/official/cua-driver' }),
    call: async () => ({ windows: [] }),
  }
  /** 服务注入的安装边界保留异步进度。 */
  const service = new ComputerUseService({ platform: 'darwin', driver, loadConfig: () => ({ enabled: true, driverPath: '/custom/cua-driver' }), saveConfig: () => {},
    installDriver: async progress => {
      installs += 1
      progress('installing')
      await new Promise<void>((resolve, reject) => { finish = resolve; fail = reject })
    },
  })
  return { service, installs: () => installs, finish: () => { compatible = true; finish() }, finishOld: () => finish(), fail: () => fail(new Error('下载失败，请检查网络或代理后重试')) }
}

test('Given 用户点击更新 When 安装成功 Then 发布进度并验证标准安装位置，不自动启用系统权限', async () => {
  const host = fixture()
  await host.service.checkInstallation()
  const pending = host.service.installDriver()
  await Promise.resolve()
  expect(host.service.getSnapshot().driverSetup?.status).toBe('installing')
  await expect(host.service.installDriver()).rejects.toThrow('安装正在进行')
  await expect(host.service.setDriverPath('/other/cua-driver')).rejects.toThrow('安装正在进行')
  await expect(host.service.checkPermissions()).rejects.toThrow('安装正在进行')
  const run = host.service.createRun({ sessionId: 'during-install', signal: new AbortController().signal, assertActive: () => {}, getPermissionMode: () => 'bypassPermissions' })
  await expect(run.discover()).rejects.toThrow('安装正在进行')
  await run.dispose()
  host.finish()
  const snapshot = await pending
  expect(host.installs()).toBe(1)
  expect(snapshot.driverSetup?.status).toBe('succeeded')
  expect(snapshot.installation?.version).toBe('0.38.0')
  expect(snapshot.config.driverPath).toBe('/official/cua-driver')
  expect(snapshot.permissions).toBeUndefined()
})

test('Given 下载失败 When 安装结束 Then 保留旧配置并允许用户重试', async () => {
  const host = fixture()
  const pending = host.service.installDriver()
  await Promise.resolve()
  host.fail()
  expect((await pending).driverSetup?.status).toBe('failed')
  expect(host.service.getSnapshot().config.driverPath).toBe('/custom/cua-driver')
  const retry = host.service.installDriver()
  await Promise.resolve()
  host.finish()
  expect((await retry).driverSetup?.status).toBe('succeeded')
  expect(host.installs()).toBe(2)
})

test('Given 安装器退出成功但版本仍过旧 When 核验 Then 不宣称更新成功', async () => {
  const host = fixture()
  const pending = host.service.installDriver()
  await Promise.resolve()
  host.finishOld()
  expect((await pending).driverSetup?.status).toBe('failed')
})

test('Given Linux When 点击安装 Then 不启动安装器', async () => {
  /** 平台不支持时不能启动下载或改变配置。 */
  let called = false
  const service = new ComputerUseService({ platform: 'linux', loadConfig: () => ({ enabled: false }), saveConfig: () => {}, installDriver: async () => { called = true } })
  await expect(service.installDriver()).rejects.toThrow('当前仅支持')
  expect(called).toBe(false)
})

test('Given 旧 Driver 观察尚未退出 When 开始安装 Then 等待撤权和清理后才替换组件', async () => {
  /** 假驱动故意延迟退出，验证安装与桌面输入不并行。 */
  let releaseCapture!: () => void
  let captureStarted!: () => void
  let installed = false
  const started = new Promise<void>(resolve => { captureStarted = resolve })
  const capture = new Promise<void>(resolve => { releaseCapture = resolve })
  const service = new ComputerUseService({ platform: 'darwin', loadConfig: () => ({ enabled: true }), saveConfig: () => {}, installDriver: async () => { installed = true }, driver: {
    validatePath: async () => {},
    check: async () => ({ platform: 'macos', status: 'installed', driverPath: '/official/cua-driver', version: '0.38.0' }),
    call: async (_path, tool) => {
      if (tool === 'list_windows') return { windows: [{ pid: 12, window_id: 34, title: '窗口' }] }
      if (tool === 'get_window_state') { captureStarted(); await capture; return { pid: 12, window_id: 34, elements: [] } }
      return { success: true }
    },
  } })
  const run = service.createRun({ sessionId: 'previous', signal: new AbortController().signal, assertActive: () => {}, getPermissionMode: () => 'bypassPermissions' })
  /** 观察失败在创建时即绑定拒绝处理，避免测试产生未处理异常。 */
  const observing = run.observe({ pid: 12, windowId: '34' }).catch(error => error)
  await started
  const installing = service.installDriver()
  await Promise.resolve()
  expect(installed).toBe(false)
  expect(service.getSnapshot().operation?.status).toBe('stopping')
  releaseCapture()
  expect(await observing).toBeInstanceOf(Error)
  expect((await installing).driverSetup?.status).toBe('succeeded')
  expect(service.getSnapshot().operation).toBeNull()
  await expect(run.discover()).rejects.toThrow('停止')
})

test('Given 安装任务未退出 When 应用退出 Then 取消并等待任务清理，禁止新的安装', async () => {
  /** 显式控制取消后的清理完成时点。 */
  let finish!: () => void
  let cancelled = false
  let exited = false
  const service = new ComputerUseService({ platform: 'darwin', loadConfig: () => ({ enabled: false }), saveConfig: () => {}, installDriver: async (_progress, signal) => {
    signal.addEventListener('abort', () => { cancelled = true }, { once: true })
    await new Promise<void>(resolve => { finish = resolve })
    signal.throwIfAborted()
  } })
  const installing = service.installDriver()
  await Promise.resolve()
  const shutdown = service.shutdown().then(() => { exited = true })
  expect(cancelled).toBe(true)
  expect(exited).toBe(false)
  finish()
  await shutdown
  expect((await installing).driverSetup?.status).toBe('failed')
  await expect(service.installDriver()).rejects.toThrow('正在退出')
})

test('Given 安装进入版本核验 When 应用退出后才返回兼容版本 Then 不保存新路径或报告成功', async () => {
  /** 延迟版本响应以重现退出与安装成功竞争。 */
  let release!: () => void
  let checking!: () => void
  let saves = 0
  const started = new Promise<void>(resolve => { checking = resolve })
  const response = new Promise<void>(resolve => { release = resolve })
  const service = new ComputerUseService({ platform: 'darwin', loadConfig: () => ({ enabled: false }), saveConfig: () => { saves += 1 }, installDriver: async () => {}, driver: {
    validatePath: async () => {},
    check: async () => { checking(); await response; return { platform: 'macos', status: 'installed', driverPath: '/official/cua-driver', version: '0.38.0' } },
    call: async () => ({}),
  } })
  const installing = service.installDriver()
  await started
  const shutdown = service.shutdown()
  release()
  await shutdown
  expect((await installing).driverSetup?.status).toBe('failed')
  expect(saves).toBe(0)
  expect(service.getSnapshot().config.driverPath).toBeUndefined()
})
