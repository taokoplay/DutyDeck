import { expect, test } from 'bun:test'
import { access, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import type { ComputerUsePermissions } from '@dutydeck/shared'
import { LocalComputerUseDriver } from './driver'
import { ComputerUseService } from './service'

/** 可实际读取的 1 像素 PNG，用于区分协议身份和图像文件问题。 */
const fixturePng = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAADElEQVQImWP4//8/AAX+Av5Y8msOAAAAAElFTkSuQmCC', 'base64')

/** 注入协议响应，预检流程仍使用真实 Driver 实现且不接触桌面。 */
class PermissionDriver extends LocalComputerUseDriver {
  constructor(private respond: (tool: string, args: Record<string, unknown>) => Promise<unknown>) { super() }
  override call(_path: string, tool: string, args: Record<string, unknown>): Promise<unknown> { return this.respond(tool, args) }
}

test('Given 只有窗口列表 When 权限预检 Then 不冒充辅助功能已授权', async () => {
  /** 无控件和图像证据的假协议。 */
  const driver = new PermissionDriver(async tool => tool === 'list_windows' ? { windows: [] } : {})
  expect((await driver.checkPermissions('/fake/cua-driver')).accessibility).toBe('unknown')
})

test('Given 有控件及有效截图 When 权限预检 Then 通过且清理临时图像，不返回桌面正文', async () => {
  /** 验证返回后临时目录已移除。 */
  let directory = ''
  /** 验证实际请求结构化控件而非仅凭窗口列表判定。 */
  const driver = new PermissionDriver(async (tool, args) => {
    if (tool === 'list_windows') return { windows: [{ pid: 12, window_id: 34 }] }
    expect(args.include_accessibility_tree).toBe(true)
    expect(args.tree_format).toBe('elements')
    directory = dirname(String(args.screenshot_out_file))
    await writeFile(String(args.screenshot_out_file), fixturePng)
    return { pid: 12, window_id: 34, elements: [{ element_token: 'private-control', title: '私密正文' }], screenshot_frame_valid: true, capture_id: 'capture-1' }
  })
  /** 只保留权限摘要。 */
  const result = await driver.checkPermissions('/fake/cua-driver')
  expect(result.accessibility).toBe('granted')
  expect(result.screenRecording).toBe('granted')
  expect(JSON.stringify(result)).not.toContain('私密正文')
  await expect(access(directory)).rejects.toThrow()
})

test.each(['missing', 'invalid', 'truncated', 'wrong-window', 'empty-capture'])('Given 截图证据 %s When 权限预检 Then 不报告屏幕录制通过', async kind => {
  /** 模拟缺失文件、无效文件、窗口错位及空捕获标识。 */
  const driver = new PermissionDriver(async (tool, args) => {
    if (tool === 'list_windows') return { windows: [{ pid: 12, window_id: 34 }] }
    if (kind !== 'missing') await writeFile(String(args.screenshot_out_file), kind === 'invalid' ? Buffer.from('not-png') : kind === 'truncated' ? fixturePng.subarray(0, 24) : fixturePng)
    return { pid: 12, window_id: kind === 'wrong-window' ? 99 : 34, elements: [], screenshot_frame_valid: true, capture_id: kind === 'empty-capture' ? '' : 'capture-1' }
  })
  expect((await driver.checkPermissions('/fake/cua-driver')).screenRecording).not.toBe('granted')
})

test('Given 窗口读取失败 When 权限预检 Then 返回可处理说明且不泄露错误载荷', async () => {
  /** 模拟拒绝访问及包含私密内容的底层异常。 */
  const driver = new PermissionDriver(async () => { throw new Error('私密窗口') })
  /** 用户仅看到固定说明。 */
  const result = await driver.checkPermissions('/fake/cua-driver')
  expect(result.accessibility).toBe('needs_attention')
  expect(JSON.stringify(result)).not.toContain('私密窗口')
})

test('Given 旧路径权限预检尚未返回 When 更换 Driver Then 丢弃迟到结果', async () => {
  /** 延迟旧路径的预检结果。 */
  let finish: (value: Omit<ComputerUsePermissions, 'checkedAt'>) => void = () => {}
  /** 外部进程可控完成点。 */
  const pending = new Promise<Omit<ComputerUsePermissions, 'checkedAt'>>(resolve => { finish = resolve })
  /** 保留真实服务路径切换状态机。 */
  const service = new ComputerUseService({ platform: 'darwin', loadConfig: () => ({ enabled: true }), saveConfig: () => {}, driver: {
    validatePath: async () => {},
    check: async path => ({ platform: 'macos', status: 'installed', driverPath: path ?? '/old/cua-driver' }),
    call: async () => ({}),
    checkPermissions: () => pending,
  } })
  await service.checkInstallation()
  /** 开始旧请求后切换至新驱动。 */
  const checking = service.checkPermissions()
  await service.setDriverPath('/new/cua-driver')
  finish({ accessibility: 'granted', screenRecording: 'granted' })
  await checking
  expect(service.getSnapshot().permissions).toBeUndefined()
  expect(service.getSnapshot().installation?.driverPath).toBe('/new/cua-driver')
})

test('Given 已有权限结果 When 重新检测安装 Then 旧权限状态失效', async () => {
  /** 每次安装检测成功，但仍应要求重新获取能力证据。 */
  const service = new ComputerUseService({ platform: 'darwin', loadConfig: () => ({ enabled: true }), saveConfig: () => {}, driver: {
    validatePath: async () => {},
    check: async () => ({ platform: 'macos', status: 'installed', driverPath: '/fake/cua-driver' }),
    call: async () => ({}),
    checkPermissions: async () => ({ accessibility: 'granted', screenRecording: 'granted' }),
  } })
  await service.checkPermissions()
  expect(service.getSnapshot().permissions?.accessibility).toBe('granted')
  await service.checkInstallation()
  expect(service.getSnapshot().permissions).toBeUndefined()
})

test('Given 首次安装检测等待 When 切换路径开始 Then 不再调用旧 Driver 预检', async () => {
  /** 分别控制安装查询和路径验证，复现两次 await 之间的切换。 */
  let finishCheck: () => void = () => {}
  let finishValidation: () => void = () => {}
  const checked = new Promise<void>(resolve => { finishCheck = resolve })
  const validated = new Promise<void>(resolve => { finishValidation = resolve })
  /** 统计实际桌面预检，过期请求不应执行。 */
  let probes = 0
  const service = new ComputerUseService({ platform: 'darwin', loadConfig: () => ({ enabled: true }), saveConfig: () => {}, driver: {
    validatePath: () => validated,
    check: async path => { await checked; return { platform: 'macos', status: 'installed', driverPath: path ?? '/old/cua-driver' } },
    call: async () => ({}),
    checkPermissions: async () => { probes += 1; return { accessibility: 'granted', screenRecording: 'granted' } },
  } })
  const checking = service.checkPermissions()
  const changing = service.setDriverPath('/new/cua-driver')
  finishCheck()
  await checking
  expect(probes).toBe(0)
  finishValidation()
  await changing
})

test('Given 权限预检尚未结束 When 并发预检或 Agent 观察 Then 拒绝交错；切换 Driver 取消旧预检', async () => {
  /** 延迟权限响应以验证互斥与取消信号。 */
  let finish: () => void = () => {}
  const pending = new Promise<void>(resolve => { finish = resolve })
  let signal: AbortSignal | undefined
  const service = new ComputerUseService({ platform: 'darwin', loadConfig: () => ({ enabled: true }), saveConfig: () => {}, driver: {
    validatePath: async () => {},
    check: async path => ({ platform: 'macos', status: 'installed', driverPath: path ?? '/old/cua-driver' }),
    call: async () => ({ windows: [{ pid: 12, window_id: 34 }] }),
    checkPermissions: async (_path, cancellation) => { signal = cancellation; await pending; return { accessibility: 'granted', screenRecording: 'granted' } },
  } })
  await service.checkInstallation()
  const checking = service.checkPermissions()
  await expect(service.checkPermissions()).rejects.toThrow('权限预检')
  const run = service.createRun({ sessionId: 'test', signal: new AbortController().signal, assertActive: () => {}, getPermissionMode: () => 'bypassPermissions' })
  await expect(run.observe({ pid: 12, windowId: '34' })).rejects.toThrow('权限预检')
  await service.setDriverPath('/new/cua-driver')
  expect(signal?.aborted).toBe(true)
  finish()
  await checking
  expect(service.getSnapshot().permissions).toBeUndefined()
  await run.dispose()
})
