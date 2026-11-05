/** 仅保留无正文的有界诊断，默认关闭；使用单调时钟，不跨进程相减。 */
export interface AgentHistoryPerformanceSample {
  operation: 'full' | 'page' | 'usage'
  durationMs: number
  readMs: number
  projectionMs: number
  ioBytes: number
  parsedRecords: number
  returnedBytes: number
}

export function createHistoryPerformanceCollector(enabled = false) {
  const samples: AgentHistoryPerformanceSample[] = []
  return {
    record(sample: AgentHistoryPerformanceSample): void {
      if (!enabled) return
      const { operation, durationMs, readMs, projectionMs, ioBytes, parsedRecords, returnedBytes } = sample
      if (!['full', 'page', 'usage'].includes(operation)
        || ![durationMs, readMs, projectionMs, ioBytes, parsedRecords, returnedBytes]
          .every((value) => Number.isFinite(value) && value >= 0)) return
      samples.push({ operation, durationMs, readMs, projectionMs, ioBytes, parsedRecords, returnedBytes })
      if (samples.length > 128) samples.shift()
    },
    snapshot(): AgentHistoryPerformanceSample[] { return samples.map((sample) => ({ ...sample })) },
    clear(): void { samples.length = 0 },
    enabled,
  }
}

/** 仅启动环境显式开启；诊断不写文件，也不输出消息、路径或用户身份。 */
export const agentHistoryPerformance = createHistoryPerformanceCollector(process.env.DUTYDECK_HISTORY_PERF === '1')
