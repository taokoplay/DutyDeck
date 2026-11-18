import type { AgentStreamEvent } from '@dutydeck/shared'

/** 阶段仅描述运行边界，禁止接收 prompt、delta 正文或工具参数。 */
export type AgentPerformanceStage = 'main_start' | 'adapter_submit' | 'runtime_start' | 'prompt_submit' | 'first_text' | 'renderer_receive' | 'next_paint_opportunity'
/** 每条样本只包含关联身份与同一进程单调时钟的差值。 */
export interface AgentPerformanceSample {
  domain: 'main' | 'runtime' | 'renderer'
  sessionId: string
  /** 仅关联 run，不参与任何耗时相减。 */
  runStartedAt: number
  stage: AgentPerformanceStage
  elapsedMs: number
  segmentMs: number
}
/** 可注入本地时钟和输出器，便于完全离线验证。 */
interface TraceOptions {
  enabled: boolean
  domain: AgentPerformanceSample['domain']
  sessionId: string
  runStartedAt: number
  now?: () => number
  emit?: (sample: AgentPerformanceSample) => void
}
/** 创建单次运行采样器；返回首次阶段标记器，默认关闭时完全不读取时钟。 */
export function createAgentPerformanceTrace(options: TraceOptions): (stage: AgentPerformanceStage) => void {
  if (!options.enabled) return () => undefined
  /** 状态限定在一次运行，重复 delta 不产生额外日志。 */
  const seen = new Set<AgentPerformanceStage>()
  const now = options.now ?? (() => performance.now())
  const emit = options.emit ?? ((sample: AgentPerformanceSample) => console.debug('[Agent Perf]', JSON.stringify(sample)))
  let start: number | undefined
  let previous: number | undefined
  return (stage) => {
    if (seen.has(stage)) return
    seen.add(stage)
    try {
      const current = now()
      start ??= current
      previous ??= current
      emit({ domain: options.domain, sessionId: options.sessionId, runStartedAt: options.runStartedAt, stage, elapsedMs: current - start, segmentMs: current - previous })
      previous = current
    } catch { /* 性能诊断失败不能影响业务运行。 */ }
  }
}

/** renderer 绘制调度作为显式依赖，测试不需要浏览器或真实模型。 */
interface RendererObserverOptions {
  enabled: boolean
  now?: () => number
  emit?: (sample: AgentPerformanceSample) => void
  requestFrame: (callback: () => void) => number
  cancelFrame: (id: number) => void
}
/** 首文本接收与状态应用分开，防止将批处理之前的空帧算作渲染。 */
interface RendererSample {
  mark: (stage: AgentPerformanceStage) => void
  scheduled: boolean
  frame?: number
}
/** 观察合成或真实 IPC 事件；返回接收、应用与卸载入口，不修改事件。 */
export function createRendererPerformanceObserver(options: RendererObserverOptions) {
  /** 有界记录避免长期运行积累；被淘汰样本不补写绘制数据。 */
  const samples = new Map<string, RendererSample>()
  /** 只接受带 run 身份的非空真实文本，thinking/工具/终态快照不冒充首文本。 */
  const identify = (event: AgentStreamEvent): { key: string; runStartedAt: number } | undefined => {
    if (!options.enabled || event.payload.kind !== 'sdk_delta') return undefined
    const delta = event.payload.delta
    if (delta.runStartedAt == null || !delta.deltas.some(part => part.type === 'text_delta' && part.delta.length > 0)) return undefined
    return { key: JSON.stringify([event.sessionId, delta.runGeneration ?? null, delta.runStartedAt]), runStartedAt: delta.runStartedAt }
  }
  return {
    /** 在 IPC 原始到达时记时，正文仅用于判断非空，不写入样本。 */
    receive(event: AgentStreamEvent): void {
      const identity = identify(event)
      if (!identity || samples.has(identity.key)) return
      if (samples.size >= 128) {
        const oldest = samples.entries().next().value
        if (oldest) {
          if (oldest[1].frame !== undefined) options.cancelFrame(oldest[1].frame)
          samples.delete(oldest[0])
        }
      }
      const sample: RendererSample = { mark: createAgentPerformanceTrace({ ...options, domain: 'renderer', sessionId: event.sessionId, runStartedAt: identity.runStartedAt }), scheduled: false }
      samples.set(identity.key, sample)
      sample.mark('renderer_receive')
    },
    /** 在批处理开始应用时安排双帧；第二帧表示前一绘制机会已过去，不承诺可见像素。 */
    applied(event: AgentStreamEvent): void {
      const identity = identify(event)
      const sample = identity ? samples.get(identity.key) : undefined
      if (!sample || sample.scheduled) return
      sample.scheduled = true
      sample.frame = options.requestFrame(() => {
        sample.frame = options.requestFrame(() => {
          sample.frame = undefined
          sample.mark('next_paint_opportunity')
        })
      })
    },
    /** 卸载时取消未完成帧，避免遗留回调及跨挂载样本。 */
    dispose(): void {
      for (const sample of samples.values()) if (sample.frame !== undefined) options.cancelFrame(sample.frame)
      samples.clear()
    },
  }
}
