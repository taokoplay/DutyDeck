/** 只生成临时合成会话，不导入 session-manager/config-paths 或读取用户数据。 */
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { SDKMessage } from '@dutydeck/shared'
import { readDisplayHistory } from '../src/main/lib/agent-history-reader'
import { createHistoryPerformanceCollector } from '../src/main/lib/agent-history-performance'
import { projectSDKMessageForDisplay } from '../src/main/lib/agent-message-display'
import { readTranscriptPage } from '../src/main/lib/agent-transcript-page'

const args = process.argv.slice(2)
if (!args.includes('--synthetic')) throw new Error('必须显式传入 --synthetic；不接受真实会话路径')
function numberArgument(name: string, fallback: number, max: number): number {
  const index = args.indexOf(name)
  const value = index < 0 ? fallback : Number(args[index + 1])
  if (!Number.isSafeInteger(value) || value < 1 || value > max) throw new Error(`${name} 超出范围`)
  return value
}
const count = numberArgument('--messages', 10000, 100000)
const runs = numberArgument('--runs', 10, 100)
const directory = mkdtempSync(join(tmpdir(), 'dutydeck-history-benchmark-'))
const path = join(directory, 'synthetic.jsonl')
const lines = Array.from({ length: count }, (_, i) => JSON.stringify({
  type: i % 4 === 0 ? 'user' : 'assistant', uuid: `synthetic-${i}`,
  message: { role: i % 4 === 0 ? 'user' : 'assistant', content: [{ type: 'text', text: `合成记录 ${i}\n${'baseline 基准 '.repeat(i % 31 === 0 ? 1000 : 12)}` },
    ...(i % 101 === 0 ? [{ type: 'image', data: 'A'.repeat(16384), mimeType: 'image/png' }] : [])] },
}))
const collector = createHistoryPerformanceCollector(true)
try {
  writeFileSync(path, lines.join('\n') + '\n')
  for (let i = 0; i < runs; i++) await readDisplayHistory(path, (value) => projectSDKMessageForDisplay(value as SDKMessage), collector)
  const samples = collector.snapshot()
  const durations = samples.map((s) => s.durationMs).sort((a, b) => a - b)
  const pages: Array<{ durationMs: number; ioBytes: number; indexBytes: number; returnedBytes: number; records: number }> = []
  for (let i = 0; i < runs; i++) {
    const start = performance.now()
    const page = await readTranscriptPage(path, { sessionId: 'synthetic', mode: 'tail' }, (value) => projectSDKMessageForDisplay(value as SDKMessage))
    pages.push({ durationMs: performance.now() - start, ioBytes: page.ioBytes, indexBytes: page.indexBytes,
      returnedBytes: page.returnedBytes, records: page.entries.length })
  }
  const pageDurations = pages.map((page) => page.durationMs).sort((a, b) => a - b)
  console.log(JSON.stringify({ label: '合成全量与尾页读取（非IPC/DOM；OS缓存未清除；全量先跑）', messages: count, runs,
    full: { firstRunMs: samples[0]?.durationMs, p50Ms: durations[Math.ceil(runs * 0.5) - 1], p95Ms: durations[Math.ceil(runs * 0.95) - 1], samples },
    tail: { firstRunMs: pages[0]?.durationMs, p50Ms: pageDurations[Math.ceil(runs * 0.5) - 1], p95Ms: pageDurations[Math.ceil(runs * 0.95) - 1], samples: pages },
    rssBytes: process.memoryUsage().rss }, null, 2))
} finally { rmSync(directory, { recursive: true, force: true }) }
