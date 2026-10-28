import { describe, expect, test } from 'bun:test'
import type { ExtensionToolContext } from '@earendil-works/pi-coding-agent'
import type { DutyDeckPermissionMode } from '@dutydeck/shared'
import type { ComputerUseRun } from './service'
import { buildComputerUseTools, isComputerUseRunEligible } from './tools'

/** 创建只记录调用的桌面边界；不接触真实用户桌面。 */
function fixture() {
  /** 底层收到的观察/动作，批准前应保持为空。 */
  const effects: unknown[] = []
  /** 审批等待的参数与一次性决策函数。 */
  const approvals: Array<{ name: string; input: Record<string, unknown>; resolve: (allow: boolean) => void }> = []
  /** 模拟运行中切换权限模式。 */
  let mode: DutyDeckPermissionMode = 'bypassPermissions'
  /** 模拟停止后尚未返回的旧工具调用。 */
  let active = true
  /** 主进程本轮取消信号。 */
  const controller = new AbortController()
  /** 仅替换最末端系统输入，工具校验与审批使用真实实现。 */
  const run: ComputerUseRun = {
    discover: async () => [{ pid: 123, windowId: '7', title: '计算器' }],
    observe: async input => { effects.push(input); return { observationId: 'obs-1', text: '计算器 42', image: { data: 'cG5n', mimeType: 'image/png' } } },
    action: async input => { effects.push(input); return { effect: 'unverifiable' } },
    stop: async () => { effects.push('stop') },
    dispose: async () => {},
  }
  /** 使用与生产相同的工具 builder，只把原生确认 UI 替换为可决策队列。 */
  const tools = buildComputerUseTools({
    run,
    signal: controller.signal,
    assertActive: () => { if (!active) throw new Error('运行已停止') },
    getPermissionMode: () => mode,
    approve: (name, input) => new Promise<boolean>(resolve => approvals.push({ name, input, resolve })),
  })
  return { tools, effects, approvals, controller, setMode: (value: DutyDeckPermissionMode) => { mode = value }, stop: () => { active = false } }
}

/** 通过实际 Pi ToolDefinition 执行入口触发调用。 */
function execute(setup: ReturnType<typeof fixture>, name: string, input: Record<string, unknown>) {
  /** 测试中不使用 Pi 上下文，运行身份已由 builder 固化。 */
  const context = {} as ExtensionToolContext
  return setup.tools.find(tool => tool.name === name)!.execute('call-1', input, setup.controller.signal, undefined, context)
}

describe('Computer Use 运行来源与权限', () => {
  test.each([['darwin', true], ['win32', true], ['linux', false]] as const)('Given %s 平台的普通用户运行 When 注册桌面工具 Then 可用状态为 %s', (platform, expected) => {
    expect(isComputerUseRunEligible({ platform, ordinary: true, toolMode: 'standard' })).toBe(expected)
    expect(isComputerUseRunEligible({ platform, ordinary: true, toolMode: 'standard', triggeredBy: 'automation' })).toBe(false)
  })

  test('Given 普通用户会话 When 注册工具 Then 仅此来源拥有桌面专用工具', () => {
    expect(isComputerUseRunEligible({ platform: 'darwin', ordinary: true, toolMode: 'standard' })).toBe(true)
    for (const triggeredBy of ['automation', 'delegation', 'external'] as const) {
      expect(isComputerUseRunEligible({ platform: 'darwin', ordinary: true, toolMode: 'standard', triggeredBy })).toBe(false)
    }
    expect(isComputerUseRunEligible({ platform: 'darwin', ordinary: false, toolMode: 'standard' })).toBe(false)
    expect(isComputerUseRunEligible({ platform: 'darwin', ordinary: true, toolMode: 'server-ops-read' })).toBe(false)
    expect(isComputerUseRunEligible({ platform: 'darwin', ordinary: true, toolMode: 'standard', restricted: true })).toBe(false)
    expect(isComputerUseRunEligible({ platform: 'darwin', ordinary: true, toolMode: 'standard', recovery: true })).toBe(false)
  })

  test.each(['ComputerUseObserve', 'ComputerUseAction'])('Given bypass 模式 When 调用 %s Then 仍等待单次批准', async name => {
    const setup = fixture()
    const input = name === 'ComputerUseObserve' ? { pid: 123, windowId: '7' }
      : { kind: 'type', observationId: 'obs-1', elementToken: 'snapshot:1', text: '42' }
    const pending = execute(setup, name, input)
    expect(setup.effects).toEqual([])
    expect(setup.approvals).toHaveLength(1)
    setup.approvals[0]!.resolve(true)
    const result = await pending
    expect(setup.effects).toEqual([input])
    if (name === 'ComputerUseObserve') expect(result.content.some(block => block.type === 'image')).toBe(true)
    else expect(result.content).toMatchObject([{ type: 'text', text: expect.stringContaining('不代表业务已完成') }])
  })

  test.each(['denied', 'plan', 'stale', 'abort'] as const)('Given 等待审批 When %s Then 无系统副作用', async decision => {
    const setup = fixture()
    const pending = execute(setup, 'ComputerUseAction', { kind: 'click', observationId: 'obs-1', elementToken: 'snapshot:1' })
    if (decision === 'plan') setup.setMode('plan')
    if (decision === 'stale') setup.stop()
    if (decision === 'abort') setup.controller.abort()
    setup.approvals[0]!.resolve(decision !== 'denied')
    await expect(pending).rejects.toThrow()
    expect(setup.effects).toEqual([])
  })

  test('Given 计划模式 When 观察屏幕 Then 不申请批准也不采集', async () => {
    const setup = fixture()
    setup.setMode('plan')
    await expect(execute(setup, 'ComputerUseObserve', { pid: 123, windowId: '7' })).rejects.toThrow('计划模式')
    expect(setup.approvals).toEqual([])
    expect(setup.effects).toEqual([])
  })

  test.each([
    { kind: 'script', script: 'doAnything()' },
    { kind: 'click', observationId: 'obs-1', elementToken: 'snapshot:1', target: { kind: 'desktop' } },
    { kind: 'type', observationId: 'obs-1', elementToken: 'snapshot:1', text: 'x'.repeat(4001) },
    { kind: 'key', observationId: 'obs-1', elementToken: 'snapshot:1', key: 'cmd+enter' },
    { kind: 'scroll', observationId: 'obs-1', elementToken: 'snapshot:1', direction: 'down', amount: 1000000 },
  ])('Given 非法或扩权参数 When 请求动作 Then 在审批与执行前拒绝', async input => {
    const setup = fixture()
    await expect(execute(setup, 'ComputerUseAction', input)).rejects.toThrow()
    expect(setup.approvals).toEqual([])
    expect(setup.effects).toEqual([])
  })

  test('Given 本轮需要停止 When 处于计划模式 Then 无需审批立即停止自己的控制', async () => {
    const setup = fixture()
    setup.setMode('plan')
    await execute(setup, 'ComputerUseStop', {})
    expect(setup.approvals).toEqual([])
    expect(setup.effects).toEqual(['stop'])
  })
})
