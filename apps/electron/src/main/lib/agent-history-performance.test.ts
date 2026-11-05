import { describe, expect, test } from 'bun:test'
import { createHistoryPerformanceCollector, type AgentHistoryPerformanceSample } from './agent-history-performance'

const sample: AgentHistoryPerformanceSample = {
  operation: 'full', durationMs: 3, readMs: 2, projectionMs: 1,
  ioBytes: 128, parsedRecords: 4, returnedBytes: 64,
}

describe('历史性能诊断', () => {
  test('Given 默认关闭 When 记录样本 Then 不保留诊断', () => {
    const collector = createHistoryPerformanceCollector()
    collector.record(sample)
    expect(collector.snapshot()).toEqual([])
  })
  test('Given 启用 When 超过样本预算 Then 只保留最近128条且快照不会改变内部状态', () => {
    const collector = createHistoryPerformanceCollector(true)
    for (let i = 0; i < 200; i++) collector.record({ ...sample, ioBytes: i })
    const snapshot = collector.snapshot()
    expect(snapshot).toHaveLength(128)
    expect(snapshot[0]?.ioBytes).toBe(72)
    snapshot[0]!.ioBytes = -1
    expect(collector.snapshot()[0]?.ioBytes).toBe(72)
    collector.clear()
    expect(collector.snapshot()).toEqual([])
  })
  test('Given 非法或额外字段 When 记录 Then 拒绝非法度量且不留存路径正文', () => {
    const collector = createHistoryPerformanceCollector(true)
    collector.record({ ...sample, durationMs: NaN })
    collector.record({ ...sample, ioBytes: -1 })
    collector.record({ ...sample, path: '/private/test', content: '不留存' } as AgentHistoryPerformanceSample)
    expect(collector.snapshot()).toEqual([sample])
  })
})
