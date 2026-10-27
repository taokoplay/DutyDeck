import { describe, expect, test } from 'bun:test'
import { NetworkDiagnostics } from './network-diagnostics'

describe('网络诊断脱敏边界', () => {
  test('只存白名单，URL凭据/正文/header/异常文本均不能进入报告', () => {
    /** 每个用例使用独立进程内诊断容器。 */
    const diagnostics = new NetworkDiagnostics(() => 123)
    diagnostics.record({ phase: 'failed', code: 'authentication', status: 401, durationMs: 12,
      headers: { Authorization: 'Bearer secret' }, body: 'private prompt', error: 'token=secret',
      timestamp: 'injected', originId: 'injected', url: 'https://private.test/key' },
    'https://user:password@private.test/secret?api_key=secret')
    /** 报告只能包含主进程产生的字段。 */
    const event = diagnostics.createReport().events[0]!
    expect(Object.keys(event).sort()).toEqual(['code', 'durationMs', 'originId', 'phase', 'status', 'timestamp'])
    expect(event).toMatchObject({ phase: 'failed', code: 'authentication', status: 401, durationMs: 12, timestamp: 123 })
    expect(event.originId).toMatch(/^[a-f0-9]{64}$/)
    expect(JSON.stringify(event)).not.toMatch(/secret|private|password|Bearer|injected/)
  })

  test('同源路径和凭据变化得到相同匿名ID，另一实例盐不同', () => {
    const diagnostics = new NetworkDiagnostics()
    diagnostics.record({ phase: 'completed', code: 'unknown' }, 'https://u:p@example.com/a?token=x')
    diagnostics.record({ phase: 'completed', code: 'unknown' }, 'https://example.com/b')
    const other = new NetworkDiagnostics()
    other.record({ phase: 'completed', code: 'unknown' }, 'https://example.com')
    const events = diagnostics.createReport().events
    expect(events[0]!.originId).toBe(events[1]!.originId)
    expect(events[0]!.originId).not.toBe(other.createReport().events[0]!.originId)
  })

  test('无效phase/code拒绝整条，异常数字和非HTTP来源不会保留', () => {
    const diagnostics = new NetworkDiagnostics()
    for (const input of [null, [], 'secret', {}, { phase: 'failed', code: 'secret' }, { phase: 'secret', code: 'unknown' }]) {
      diagnostics.record(input)
    }
    expect(diagnostics.createReport().events).toHaveLength(0)
    for (const invalid of [-1, Infinity, NaN, 'secret', 86_400_001]) {
      diagnostics.record({ phase: 'failed', code: 'unknown', durationMs: invalid, status: invalid }, 'file:///private/secret')
    }
    for (const event of diagnostics.createReport().events) {
      expect(event.durationMs).toBeUndefined()
      expect(event.status).toBeUndefined()
      expect(event.originId).toBeUndefined()
    }
    for (const status of [99, 600, 200.5]) diagnostics.record({ phase: 'failed', code: 'unknown', status })
    expect(diagnostics.createReport().events.every(event => event.status === undefined)).toBe(true)
  })

  test('最多保留100事件，返回副本不能修改已预览快照', () => {
    const diagnostics = new NetworkDiagnostics(() => 123)
    for (let index = 0; index < 101; index++) diagnostics.record({ phase: 'completed', code: 'unknown', durationMs: index })
    const report = diagnostics.createReport()
    expect(report.events).toHaveLength(100)
    expect(report.events[0]!.durationMs).toBe(1)
    report.events[0]!.code = 'dns'
    report.events.pop()
    diagnostics.record({ phase: 'failed', code: 'timeout' })
    const saved = diagnostics.getReport(report.id)
    expect(saved.events).toHaveLength(100)
    expect(saved.events[0]!.code).toBe('unknown')
    expect(saved.events[99]!.phase).toBe('completed')
    saved.events.length = 0
    expect(diagnostics.getReport(report.id).events).toHaveLength(100)
  })

  test('报告5分钟过期且只保留最近5份，读取不会延长有效期', () => {
    /** 可控时间避免真实等待。 */
    let now = 0
    const diagnostics = new NetworkDiagnostics(() => now)
    const first = diagnostics.createReport()
    now = 299_999
    expect(diagnostics.getReport(first.id).id).toBe(first.id)
    now = 300_000
    expect(() => diagnostics.getReport(first.id)).toThrow('过期')
    const reports = Array.from({ length: 6 }, () => diagnostics.createReport())
    expect(() => diagnostics.getReport(reports[0]!.id)).toThrow()
    expect(diagnostics.getReport(reports[1]!.id).id).toBe(reports[1]!.id)
    expect(() => diagnostics.getReport('unknown')).toThrow()
  })
})

import type { IpcMainInvokeEvent } from 'electron'
import { NETWORK_IPC_CHANNELS } from '@dutydeck/shared'
import type { NetworkDiagnosticsReport } from '@dutydeck/shared'
import { registerNetworkIpc, assertNetworkSender } from './network-ipc'
import { createNetworkPreload } from '../../preload/network-preload'

/** 使用真实 handler 和 preload 跑完整路由，隔离 Electron 窗口与磁盘。 */
function createIpcHarness() {
  /** 捕获已注册处理器，调用时仍会执行真实发送者验证。 */
  const handlers = new Map<string, (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown>()
  /** 测试可切换发送者授权结果，确保未授权请求不产生副作用。 */
  let authorized = true
  /** 记录恢复原因，验证 renderer 不能传入自定义原因或探测地址。 */
  const recoveries: string[] = []
  /** 捕获保存的精确快照，而不是触碰真实用户文件。 */
  const saved: NetworkDiagnosticsReport[] = []
  const diagnostics = new NetworkDiagnostics()
  registerNetworkIpc({ handle: (channel, listener) => { handlers.set(channel, listener) } }, {
    assertSender: () => { if (!authorized) throw new Error('拒绝非主窗口') },
    getStatus: () => ({ epoch: 1 }),
    requestRecovery: async reason => { recoveries.push(reason); return { epoch: 2, reason } },
    diagnostics,
    saveReport: async report => { saved.push(report); return true },
  })
  const api = createNetworkPreload(async (channel, ...args) => {
    /** sender 由上方授权替身判断，不需要启动实际 Electron。 */
    const event = {} as IpcMainInvokeEvent
    return handlers.get(channel)!(event, ...args)
  })
  return { api, diagnostics, recoveries, saved, handlers, deny: () => { authorized = false } }
}

describe('网络诊断四层IPC契约', () => {
  test('预览后新增事件不会改变导出，恢复原因由主进程固定', async () => {
    const harness = createIpcHarness()
    expect(await harness.api.getStatus()).toEqual({ epoch: 1 })
    harness.diagnostics.record({ phase: 'failed', code: 'dns' })
    const preview = await harness.api.previewDiagnostics()
    harness.diagnostics.record({ phase: 'completed', code: 'unknown' })
    expect(await harness.api.exportDiagnostics(preview.id)).toBe(true)
    expect(harness.saved[0]).toEqual(preview)
    await harness.api.reconnect()
    await harness.api.notifyOnline()
    expect(harness.recoveries).toEqual(['manual', 'online'])
  })

  test('无效报告不能弹保存框，所有通道拒绝未授权发送者', async () => {
    const harness = createIpcHarness()
    await expect(harness.api.exportDiagnostics('unknown')).rejects.toThrow()
    expect(harness.saved).toHaveLength(0)
    harness.deny()
    for (const channel of Object.values(NETWORK_IPC_CHANNELS)) {
      expect(() => harness.handlers.get(channel)!({} as IpcMainInvokeEvent)).toThrow('拒绝非主窗口')
    }
    expect(harness.recoveries).toHaveLength(0)
    expect(harness.saved).toHaveLength(0)
  })
})


test('网络发送者必须是当前存活主窗口的主frame', () => {
  /** 结构夹具只实现授权检查需要的窗口和 frame 身份。 */
  const frame = {}
  const contents = { isDestroyed: () => false, mainFrame: frame }
  const owner = { isDestroyed: () => false, webContents: contents }
  const event = { sender: contents, senderFrame: frame }
  expect(() => assertNetworkSender(event, owner)).not.toThrow()
  expect(() => assertNetworkSender(event, null)).toThrow()
  expect(() => assertNetworkSender({ ...event, sender: {} }, owner)).toThrow()
  expect(() => assertNetworkSender({ ...event, senderFrame: {} }, owner)).toThrow()
  expect(() => assertNetworkSender(event, { ...owner, isDestroyed: () => true })).toThrow()
  expect(() => assertNetworkSender(event, { ...owner, webContents: { ...contents, isDestroyed: () => true } })).toThrow()
})
