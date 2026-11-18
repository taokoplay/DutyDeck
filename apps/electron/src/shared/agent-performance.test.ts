import { describe, expect, test } from 'bun:test'
import { createAgentPerformanceTrace, createRendererPerformanceObserver, type AgentPerformanceSample } from './agent-performance'
import type { AgentStreamEvent } from '@dutydeck/shared'

describe('无正文的 Agent 分段采样', () => {
  test('Given 默认关闭 When 标记阶段 Then 不读时钟不输出', () => {
    /** 关闭时任何读取或输出都使测试失败。 */
    const trace = createAgentPerformanceTrace({ enabled: false, domain: 'main', sessionId: 's', runStartedAt: 9, now: () => { throw Error('clock') }, emit: () => { throw Error('emit') } })
    trace('main_start')
    trace('first_text')
  })
  test('Given 本地时钟 When submit 和首文本重复到达 Then 仅首次计时且不减跨进程时间', () => {
    /** 极大身份时间只用于关联，绝不参与耗时。 */
    let clock = 10
    const samples: AgentPerformanceSample[] = []
    const trace = createAgentPerformanceTrace({ enabled: true, domain: 'main', sessionId: 's', runStartedAt: 9999999999, now: () => clock, emit: sample => samples.push(sample) })
    trace('main_start')
    clock = 30
    trace('adapter_submit')
    clock = 45
    trace('first_text')
    trace('first_text')
    expect(samples.map(sample => sample.elapsedMs)).toEqual([0, 20, 35])
    expect(samples.map(sample => sample.segmentMs)).toEqual([0, 20, 15])
    expect(Object.keys(samples[0]!).sort()).toEqual(['domain', 'elapsedMs', 'runStartedAt', 'segmentMs', 'sessionId', 'stage'])
  })
  test('Given 输出器故障 When 采样 Then 不影响运行', () => {
    const trace = createAgentPerformanceTrace({ enabled: true, domain: 'runtime', sessionId: 's', runStartedAt: 1, emit: () => { throw Error('日志故障') } })
    expect(() => trace('prompt_submit')).not.toThrow()
  })
  test('Given thinking/空文本/真实文本 When 接收并更新 Then 只记录真实首文本和更新后的绘制机会', () => {
    /** 手动帧队列模拟 renderer，不需要真实窗口或模型。 */
    const frames = new Map<number, () => void>()
    let frameId = 0
    let clock = 100
    const samples: AgentPerformanceSample[] = []
    const observer = createRendererPerformanceObserver({ enabled: true, now: () => clock, emit: sample => samples.push(sample), requestFrame: callback => { frames.set(++frameId, callback); return frameId }, cancelFrame: id => { frames.delete(id) } })
    /** 工厂只生成合成事件；正文不得进入采样输出。 */
    const event = (type: 'text_delta' | 'thinking_delta', delta: string): AgentStreamEvent => ({ sessionId: 's', payload: { kind: 'sdk_delta', delta: { uuid: 'u', runStartedAt: 9999999, runGeneration: 2, deltas: [{ type, delta, contentIndex: 0 }] } } })
    observer.receive(event('thinking_delta', 'secret-thinking'))
    observer.receive(event('text_delta', ''))
    expect(samples).toHaveLength(0)
    observer.receive(event('text_delta', 'secret-text'))
    observer.receive(event('text_delta', 'second'))
    expect(samples).toHaveLength(1)
    expect(frames.size).toBe(0)
    clock = 110
    observer.applied(event('text_delta', 'secret-text'))
    frames.get(1)!()
    clock = 125
    frames.get(2)!()
    expect(samples.map(sample => [sample.stage, sample.elapsedMs])).toEqual([['renderer_receive', 0], ['next_paint_opportunity', 25]])
    expect(JSON.stringify(samples)).not.toContain('secret')
    observer.dispose()
  })
})

test('Given 两轮与挂起帧 When 卸载 Then 分轮采样并取消所有帧', () => {
  /** 同会话不同 generation 不能共享首文本标记。 */
  const samples: AgentPerformanceSample[] = []
  const pending = new Map<number, () => void>()
  let id = 0
  const observer = createRendererPerformanceObserver({ enabled: true, emit: sample => samples.push(sample), requestFrame: callback => { pending.set(++id, callback); return id }, cancelFrame: frame => { pending.delete(frame) } })
  for (const generation of [1, 2]) {
    const event: AgentStreamEvent = { sessionId: 's', payload: { kind: 'sdk_delta', delta: { uuid: 'u', runStartedAt: generation, runGeneration: generation, deltas: [{ type: 'text_delta', delta: '合成', contentIndex: 0 }] } } }
    observer.receive(event)
    observer.applied(event)
  }
  expect(samples.map(sample => sample.runStartedAt)).toEqual([1, 2])
  expect(pending.size).toBe(2)
  observer.dispose()
  expect(pending.size).toBe(0)
})

test('Given 默认关闭的 renderer When 收到文本并应用 Then 零时钟零帧零输出', () => {
  /** 所有副作用都设为抛错，以验证关闭态没有性能工作。 */
  const forbidden = (): never => { throw Error('关闭态副作用') }
  const observer = createRendererPerformanceObserver({ enabled: false, now: forbidden, emit: forbidden, requestFrame: forbidden, cancelFrame: forbidden })
  const event: AgentStreamEvent = { sessionId: 's', payload: { kind: 'sdk_delta', delta: { uuid: 'u', runStartedAt: 1, deltas: [{ type: 'text_delta', delta: '合成', contentIndex: 0 }] } } }
  expect(() => { observer.receive(event); observer.applied(event); observer.dispose() }).not.toThrow()
})
