import { createReadStream } from 'node:fs'
import { createInterface } from 'node:readline'
import type { SDKMessage } from '@dutydeck/shared'
import { agentHistoryPerformance, type createHistoryPerformanceCollector } from './agent-history-performance'

/** 全量兼容路径与隔离基准共用读取器；分页读取不会调用此函数。 */
export async function readDisplayHistory(
  filePath: string,
  project: (message: unknown) => SDKMessage,
  diagnostics: ReturnType<typeof createHistoryPerformanceCollector> = agentHistoryPerformance,
): Promise<SDKMessage[]> {
  const start = diagnostics.enabled ? performance.now() : 0
  let projectionMs = 0
  let parsedRecords = 0
  const input = createReadStream(filePath, { encoding: 'utf8' })
  const lines = createInterface({ input, crlfDelay: Infinity })
  const messages: SDKMessage[] = []
  try {
    for await (const line of lines) {
      if (!line.trim()) continue
      const projectStart = diagnostics.enabled ? performance.now() : 0
      try {
        messages.push(project(JSON.parse(line)))
        parsedRecords++
      } catch {
        // 损坏行仍按旧展示合同跳过；不把原文写入诊断。
      } finally {
        if (diagnostics.enabled) projectionMs += performance.now() - projectStart
      }
    }
    if (diagnostics.enabled) {
      const durationMs = performance.now() - start
      diagnostics.record({ operation: 'full', durationMs, readMs: Math.max(0, durationMs - projectionMs),
        projectionMs, parsedRecords, ioBytes: input.bytesRead,
        returnedBytes: Buffer.byteLength(JSON.stringify(messages)) })
    }
    return messages
  } finally {
    lines.close()
    input.destroy()
  }
}
