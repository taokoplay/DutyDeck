import { describe, expect, test } from 'bun:test'
import { writeFile } from 'node:fs/promises'
import { ComputerUseService } from './service'

/** 建立不访问真实桌面的测试服务。 */
function fixture(capture?: (args: Record<string, unknown>) => Promise<unknown>) {
  /** 捕获调用，证明宿主注入目标。 */
  const calls: Array<{ tool: string; args: Record<string, unknown> }> = []
  /** 可控假驱动。 */
  const service = new ComputerUseService({ platform: 'darwin', loadConfig: () => ({ enabled: true }), saveConfig: () => {}, driver: {
    check: async () => ({ platform: 'macos', status: 'installed', driverPath: '/fake/cua-driver', version: '0.38.0' }),
    validatePath: async () => {},
    call: async (_path, tool, args) => {
      calls.push({ tool, args })
      if (tool === 'list_windows') return { windows: [{ pid: 12, window_id: 34, title: '测试窗口' }] }
      if (tool === 'get_window_state' && capture) return capture(args)
      if (tool === 'get_window_state' && args.tree_format !== 'elements') return { pid: 12, window_id: 34, tree_markdown: '[1] button' }
      if (tool === 'get_window_state') return { pid: 12, window_id: 34, elements: [{ element_token: 'button-1', role: 'button' }] }
      return { success: true }
    },
  } })
  return { service, calls }
}
/** 测试普通会话上下文。 */
function context(sessionId: string) { return { sessionId, signal: new AbortController().signal, assertActive: () => {}, getPermissionMode: () => 'bypassPermissions' as const } }

describe('电脑控制宿主租约', () => {
  test('Given Windows 已安装兼容 Driver When 发现窗口 Then 允许受控桌面调用', async () => {
    /** Windows 不需要 macOS TCC，但仍必须经过安装检测和租约。 */
    const service = new ComputerUseService({ platform: 'win32', loadConfig: () => ({ enabled: true }), saveConfig: () => {}, driver: {
      check: async () => ({ platform: 'windows', status: 'installed', driverPath: 'C:\\cua-driver.exe', version: '0.38.0' }),
      validatePath: async () => {},
      call: async (_path, tool) => tool === 'list_windows' ? { windows: [{ pid: 12, window_id: 34, title: 'Windows 窗口' }] } : { pid: 12, window_id: 34, elements: [] },
    } })
    await service.checkInstallation()
    const run = service.createRun(context('windows'))
    await expect(run.discover()).resolves.toEqual([{ pid: 12, windowId: '34', title: 'Windows 窗口' }])
    await run.dispose()
  })

  test('Given 两个会话 When 首个观察 Then 另一个不能观察，停止后首个不可复活', async () => {
    const { service } = fixture()
    await service.checkInstallation()
    const first = service.createRun(context('first'))
    const second = service.createRun(context('second'))
    await first.observe({ pid: 12, windowId: '34' })
    await expect(service.checkPermissions()).rejects.toThrow('请先停止操作')
    await expect(second.observe({ pid: 12, windowId: '34' })).rejects.toThrow('占用')
    await first.stop()
    await expect(first.discover()).rejects.toThrow('停止')
    await second.observe({ pid: 12, windowId: '34' })
    await second.dispose()
  })
  test('Given 观察签发 token When 动作执行 Then 绑定目标且旧观察不可重放', async () => {
    const { service, calls } = fixture()
    await service.checkInstallation()
    const run = service.createRun(context('a'))
    const observed = await run.observe({ pid: 12, windowId: '34' })
    await expect(run.action({ observationId: observed.observationId, kind: 'click', elementToken: 'forged' })).rejects.toThrow('token')
    await run.action({ observationId: observed.observationId, kind: 'click', elementToken: 'button-1' })
    expect(calls.find(call => call.tool === 'click')?.args.target).toEqual({ kind: 'window', pid: 12, window_id: 34 })
    await expect(run.action({ observationId: observed.observationId, kind: 'click', elementToken: 'button-1' })).rejects.toThrow('观察')
    await run.dispose()
  })
})

  test('Given 旧停止标识 When 新租约已产生 Then 不会撤销新租约', async () => {
    const { service } = fixture()
    await service.checkInstallation()
    const first = service.createRun(context('first'))
    await first.observe({ pid: 12, windowId: '34' })
    const old = service.getSnapshot().operation!.id
    await first.stop()
    const second = service.createRun(context('second'))
    await second.observe({ pid: 12, windowId: '34' })
    await service.stop(old)
    expect(service.getSnapshot().operation?.sessionId).toBe('second')
    await second.dispose()
  })
  test('Given 动态权限降级 When 已有观察再执行 Then 拒绝驱动动作', async () => {
    const { service, calls } = fixture()
    await service.checkInstallation()
    let mode: 'bypassPermissions' | 'plan' = 'bypassPermissions'
    const run = service.createRun({ ...context('a'), getPermissionMode: () => mode })
    const observed = await run.observe({ pid: 12, windowId: '34' })
    mode = 'plan'
    await expect(run.action({ observationId: observed.observationId, elementToken: 'button-1', kind: 'click' })).rejects.toThrow('计划')
    expect(calls.some(call => call.tool === 'click')).toBe(false)
    await run.dispose()
  })

 test('Given 未退出的观察 When 用户停止 Then 立刻撤权且直到子进程退出才释放租约', async () => {
    let resolveCapture: (value: unknown) => void = () => {}
    let captureStarted: () => void = () => {}
    const started = new Promise<void>(resolve => { captureStarted = resolve })
    const capture = new Promise<unknown>(resolve => { resolveCapture = resolve })
    const service = new ComputerUseService({ platform: 'darwin', loadConfig: () => ({ enabled: true }), saveConfig: () => {}, driver: {
      validatePath: async () => {}, check: async () => ({ platform: 'macos', status: 'installed', driverPath: '/fake/cua-driver' }),
      call: async (_path, tool) => {
        if (tool === 'list_windows') return { windows: [{ pid: 12, window_id: 34, title: '窗口' }] }
        if (tool === 'get_window_state') { captureStarted(); return capture }
        return { success: true }
      },
    } })
    await service.checkInstallation()
    const run = service.createRun(context('first'))
    const next = service.createRun(context('second'))
    const observing = run.observe({ pid: 12, windowId: '34' })
    await started
    const stopped = run.stop()
    expect(service.getSnapshot().operation?.status).toBe('stopping')
    await expect(next.observe({ pid: 12, windowId: '34' })).rejects.toThrow('占用')
    resolveCapture({ pid: 12, window_id: 34, elements: [] })
    await expect(observing).rejects.toThrow('停止')
    await stopped
    expect(service.getSnapshot().operation).toBeNull()
    await expect(run.discover()).rejects.toThrow('停止')
    await next.dispose()
  })

 test('Given Driver写入超限截图 When 发布观察 Then 拒绝并保留可停止的租约', async () => {
    const { service } = fixture(async args => {
      await writeFile(String(args.screenshot_out_file), Buffer.alloc(4 * 1024 * 1024 + 1))
      return { pid: 12, window_id: 34, elements: [], screenshot_frame_valid: true, capture_id: 'capture-1' }
    })
    await service.checkInstallation()
    const run = service.createRun(context('a'))
    await expect(run.observe({ pid: 12, windowId: '34' })).rejects.toThrow('截图')
    expect(service.getSnapshot().operation?.image).toBeUndefined()
    await run.dispose()
    expect(service.getSnapshot().operation).toBeNull()
  })
 test('Given 创建后没有桌面调用 When dispose Then 不启动Driver', async () => {
    const { service, calls } = fixture()
    await service.checkInstallation()
    await service.createRun(context('a')).dispose()
    expect(calls).toHaveLength(0)
  })

 test('Given Driver 已安装 When 用户执行权限预检 Then 分别返回辅助功能和屏幕录制状态', async () => {
    const { service } = fixture()
    await service.checkInstallation()
    const permissions = await service.checkPermissions()
    expect(permissions.permissions).toEqual({
      accessibility: 'unknown',
      screenRecording: 'unknown',
      checkedAt: expect.any(Number),
      message: '当前 Driver 未提供可验证的权限预检',
    })
  })
 test('Given 正在验证新Driver路径 When 新运行试图观察 Then 不得使用旧安装检测', async () => {
    /** 控制路径验证完成时机，覆盖异步切换窗口。 */
    let finishValidation: () => void = () => {}
    /** 模拟文件选择后尚未完成的可执行文件验证。 */
    const validation = new Promise<void>(resolve => { finishValidation = resolve })
    /** 记录是否错误调用旧驱动。 */
    const calls: string[] = []
    /** 使用真实服务状态机与可控驱动。 */
    const service = new ComputerUseService({ platform: 'darwin', loadConfig: () => ({ enabled: true }), saveConfig: () => {}, driver: {
      validatePath: () => validation,
      check: async path => ({ platform: 'macos', status: 'installed', driverPath: path ?? '/old/cua-driver' }),
      call: async (path, tool) => { calls.push(path); return tool === 'list_windows' ? { windows: [{ pid: 12, window_id: 34 }] } : { pid: 12, window_id: 34, elements: [] } },
    } })
    await service.checkInstallation()
    /** 路径切换必须在第一个 await 之前封闭入口。 */
    const changing = service.setDriverPath('/new/cua-driver')
    /** 此运行尚未获取桌面能力。 */
    const run = service.createRun(context('race'))
    await expect(run.observe({ pid: 12, windowId: '34' })).rejects.toThrow('切换')
    expect(calls).toHaveLength(0)
    finishValidation()
    await changing
    expect(service.getSnapshot().installation?.driverPath).toBe('/new/cua-driver')
    await run.dispose()
  })
 test('Given 启用后重启尚未检测 When 首次discover Then 惰性检测并返回窗口', async () => {
    /** fixture 初始 installation 为 null。 */
    const { service, calls } = fixture()
    /** 普通创建不会探测驱动。 */
    const run = service.createRun(context('lazy'))
    expect(service.getSnapshot().installation).toBeNull()
    expect(await run.discover()).toHaveLength(1)
    expect(service.getSnapshot().installation?.status).toBe('installed')
    expect(calls[0]?.tool).toBe('list_windows')
    await run.dispose()
  })
 test('Given 首次检测尚未返回 When 用户停止 Then 迟到检测不能继续发现窗口', async () => {
    /** 模拟仍在运行的版本探测。 */
    let finishCheck: () => void = () => {}
    /** 标记已进入检测过程，避免依赖计时。 */
    let markStarted: () => void = () => {}
    /** 等待服务真实启动检测。 */
    const started = new Promise<void>(resolve => { markStarted = resolve })
    /** 延迟返回安装信息。 */
    const checking = new Promise<void>(resolve => { finishCheck = resolve })
    /** 记录桌面协议调用；应始终为空。 */
    const calls: string[] = []
    /** 使用可控安装检测的真实服务。 */
    const service = new ComputerUseService({ platform: 'darwin', loadConfig: () => ({ enabled: true }), saveConfig: () => {}, driver: {
      validatePath: async () => {},
      check: async () => { markStarted(); await checking; return { platform: 'macos', status: 'installed', driverPath: '/fake/cua-driver' } },
      call: async (_path, tool) => { calls.push(tool); return { windows: [] } },
    } })
    /** 此运行尚未触碰桌面。 */
    const run = service.createRun(context('lazy-stop'))
    /** 启动第一次工具调用并等待版本查询。 */
    const discovery = run.discover()
    await started
    /** 停止必须先撤销授权，再等待探测完成。 */
    const stopping = run.stop()
    finishCheck()
    await expect(discovery).rejects.toThrow('停止')
    await stopping
    expect(calls).toHaveLength(0)
  })
