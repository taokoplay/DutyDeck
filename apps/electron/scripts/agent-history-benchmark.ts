/** 只生成临时合成会话，不导入 session-manager/config-paths 或读取用户数据。 */
import { closeSync, mkdtempSync, openSync, writeSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AgentTranscriptPage, AgentTranscriptPageRequest, SDKMessage } from '@dutydeck/shared'
import { readDisplayHistory } from '../src/main/lib/agent-history-reader'
import { createHistoryPerformanceCollector } from '../src/main/lib/agent-history-performance'
import { projectSDKMessageForDisplay } from '../src/main/lib/agent-message-display'
import { invalidateTranscriptIndex } from '../src/main/lib/agent-transcript-index'
import { readTranscriptPage } from '../src/main/lib/agent-transcript-page'

/** 每次读取仅保留数值指标，不保留页面正文。 */
interface PageSample {
  durationMs: number
  ioBytes: number
  indexBytes: number
  returnedBytes: number
  records: number
}
/** 命令行参数只控制合成数据规模与重复次数。 */
const args = process.argv.slice(2)
if (!args.includes('--synthetic')) throw new Error('必须显式传入 --synthetic；不接受真实会话路径')
/** 读取有界正整数参数；非法输入在创建临时目录前失败。 */
function numberArgument(name: string, fallback: number, max: number): number {
  const index = args.indexOf(name)
  const value = index < 0 ? fallback : Number(args[index + 1])
  if (!Number.isSafeInteger(value) || value < 1 || value > max) throw new Error(`${name} 超出范围`)
  return value
}
/** 默认保留旧 full/tail 次数；冷序列单独默认使用 20 个新文件。 */
const count = numberArgument('--messages', 10000, 100000)
const runs = numberArgument('--runs', 10, 100)
const sequenceRuns = numberArgument('--sequence-runs', 20, 100)

/** 分块生成与旧版相同的 JSONL fixture，返回字节数；内存只保留约 1 MiB 写缓冲。 */
function writeSyntheticTranscript(path: string): number {
  const descriptor = openSync(path, 'wx')
  let chunk = ''
  let chunkBytes = 0
  let totalBytes = 0
  /** 写完当前块，兼容短写；返回后释放字符串缓冲。 */
  function flush(): void {
    const bytes = Buffer.from(chunk)
    let offset = 0
    while (offset < bytes.length) {
      const written = writeSync(descriptor, bytes, offset, bytes.length - offset)
      if (written === 0) throw new Error('合成记录写入无进展')
      offset += written
    }
    totalBytes += bytes.length
    chunk = ''
    chunkBytes = 0
  }
  try {
    for (let i = 0; i < count; i++) {
      const line = JSON.stringify({
        type: i % 4 === 0 ? 'user' : 'assistant', uuid: `synthetic-${i}`,
        message: { role: i % 4 === 0 ? 'user' : 'assistant', content: [{ type: 'text', text: `合成记录 ${i}\n${'baseline 基准 '.repeat(i % 31 === 0 ? 1000 : 12)}` },
          ...(i % 101 === 0 ? [{ type: 'image', data: 'A'.repeat(16384), mimeType: 'image/png' }] : [])] },
      }) + '\n'
      chunk += line
      chunkBytes += Buffer.byteLength(line)
      if (chunkBytes >= 1024 * 1024) flush()
    }
    if (chunkBytes > 0) flush()
    return totalBytes
  } finally { closeSync(descriptor) }
}
/** 返回最近秩百分位；只排序数字副本，不改变样本顺序。 */
function percentiles(values: number[]): { p50: number; p95: number } {
  const sorted = [...values].sort((a, b) => a - b)
  return { p50: sorted[Math.ceil(sorted.length * 0.5) - 1]!, p95: sorted[Math.ceil(sorted.length * 0.95) - 1]! }
}
/** 汇总分步耗时和读取量；samples 保留每轮原始指标以便复核。 */
function summarizePages(samples: PageSample[]) {
  const duration = percentiles(samples.map((sample) => sample.durationMs))
  return { firstRunMs: samples[0]?.durationMs, p50Ms: duration.p50, p95Ms: duration.p95,
    indexBytes: percentiles(samples.map((sample) => sample.indexBytes)),
    ioBytes: percentiles(samples.map((sample) => sample.ioBytes)), samples }
}
/** 对指定请求计时，返回页面供下一步取游标；仅数值指标加入长期样本。 */
async function measurePage(path: string, request: AgentTranscriptPageRequest, samples: PageSample[]): Promise<AgentTranscriptPage> {
  const start = performance.now()
  const page = await readTranscriptPage(path, request, (value) => projectSDKMessageForDisplay(value as SDKMessage))
  const durationMs = performance.now() - start
  if (page.status === 'resetRequired' || page.indexRequired) throw new Error('合成序列未能读取有效页面，拒绝输出误导性基准')
  samples.push({ durationMs, ioBytes: page.ioBytes, indexBytes: page.indexBytes,
    returnedBytes: page.returnedBytes, records: page.entries.length })
  return page
}
/** 清理本轮内存索引、派生磁盘索引与正文，保证后续轮次使用全新文件。 */
function removeTranscript(path: string): void {
  try { invalidateTranscriptIndex(path) }
  finally {
    rmSync(`${path}.display-index`, { recursive: true, force: true })
    rmSync(path, { force: true })
  }
}
/** 临时根目录只有一份在测正文；异常时也统一回收。 */
const directory = mkdtempSync(join(tmpdir(), 'dutydeck-history-benchmark-'))
const path = join(directory, 'synthetic.jsonl')
const collector = createHistoryPerformanceCollector(true)
try {
  const fileBytes = writeSyntheticTranscript(path)
  for (let i = 0; i < runs; i++) await readDisplayHistory(path, (value) => projectSDKMessageForDisplay(value as SDKMessage), collector)
  const samples = collector.snapshot()
  const durations = percentiles(samples.map((sample) => sample.durationMs))
  const pages: PageSample[] = []
  try {
    for (let i = 0; i < runs; i++) await measurePage(path, { sessionId: 'synthetic', mode: 'tail' }, pages)
  } finally { removeTranscript(path) }
  const pageDurations = percentiles(pages.map((page) => page.durationMs))
  /** 每个数组的第 i 项对应同一新文件上的第 i 轮，步骤之间不预热或重建索引。 */
  const steps = { coldTail: [] as PageSample[], before1: [] as PageSample[], before2: [] as PageSample[], after: [] as PageSample[] }
  for (let i = 0; i < sequenceRuns; i++) {
    const sequencePath = join(directory, `sequence-${i}.jsonl`)
    const sessionId = `synthetic-sequence-${i}`
    try {
      writeSyntheticTranscript(sequencePath)
      let page = await measurePage(sequencePath, { sessionId, mode: 'tail' }, steps.coldTail)
      if (!page.before) throw new Error('冷尾页缺少 before 游标')
      page = await measurePage(sequencePath, { sessionId, mode: 'before', cursor: page.before }, steps.before1)
      if (!page.before) throw new Error('首次上翻缺少 before 游标')
      page = await measurePage(sequencePath, { sessionId, mode: 'before', cursor: page.before }, steps.before2)
      if (!page.after) throw new Error('再次上翻缺少 after 游标')
      await measurePage(sequencePath, { sessionId, mode: 'after', cursor: page.after }, steps.after)
    } finally { removeTranscript(sequencePath) }
  }
  console.log(JSON.stringify({ label: '合成全量与尾页读取（非IPC/DOM；OS缓存未清除；全量先跑）', messages: count, runs,
    full: { firstRunMs: samples[0]?.durationMs, p50Ms: durations.p50, p95Ms: durations.p95, samples },
    tail: { firstRunMs: pages[0]?.durationMs, p50Ms: pageDurations.p50, p95Ms: pageDurations.p95, samples: pages },
    sequence: { label: '新文件/新索引 cold tail → before → before → after（非IPC/DOM；OS缓存未清除；不含合成写入/清理）',
      runs: sequenceRuns, freshFiles: sequenceRuns, fileBytes, order: ['coldTail', 'before1', 'before2', 'after'],
      percentileMethod: 'nearest-rank',
      coldTail: summarizePages(steps.coldTail), before1: summarizePages(steps.before1),
      before2: summarizePages(steps.before2), after: summarizePages(steps.after) },
    rssBytes: process.memoryUsage().rss }, null, 2))
} finally {
  try { removeTranscript(path) }
  finally { rmSync(directory, { recursive: true, force: true }) }
}
