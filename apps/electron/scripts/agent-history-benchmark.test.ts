import { describe, expect, test } from 'bun:test'
import { mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'

/** 子进程输出的单步数值契约，不持有合成正文。 */
interface Sample { durationMs: number; indexBytes: number; ioBytes: number; records: number; returnedBytes: number }
interface Summary { firstRunMs: number; p50Ms: number; p95Ms: number; samples: Sample[] }
interface StepSummary extends Summary { indexBytes: { p50: number; p95: number }; ioBytes: { p50: number; p95: number } }
interface Report {
  messages: number
  runs: number
  full: Summary
  tail: Summary
  rssBytes: number
  sequence: { runs: number; freshFiles: number; fileBytes: number; order: string[];
    coldTail: StepSummary; before1: StepSummary; before2: StepSummary; after: StepSummary }
}
/** 在独立临时根运行真实 CLI，检查正常/异常退出后均无残留；返回退出状态及输出。 */
function runBenchmark(args: string[]) {
  const directory = mkdtempSync(join(tmpdir(), 'dutydeck-history-benchmark-test-'))
  try {
    const result = spawnSync(process.execPath, [join(import.meta.dir, 'agent-history-benchmark.ts'), ...args], {
      encoding: 'utf8', env: { ...process.env, TMPDIR: directory, TMP: directory, TEMP: directory },
      timeout: 30_000, maxBuffer: 4 * 1024 * 1024,
    })
    expect(result.error).toBeUndefined()
    expect(readdirSync(directory)).toEqual([])
    return result
  } finally { rmSync(directory, { recursive: true, force: true }) }
}

describe('合成历史基准 CLI', () => {
  test('给定小样本，默认测量20个冷文件并保留旧full/tail输出和分步百分位', () => {
    const result = runBenchmark(['--synthetic', '--messages', '600', '--runs', '2'])
    expect(result.status).toBe(0)
    const report = JSON.parse(result.stdout) as Report
    expect(report.messages).toBe(600)
    expect(report.runs).toBe(2)
    expect(report.full.samples).toHaveLength(2)
    expect(report.tail.samples).toHaveLength(2)
    expect(report.rssBytes).toBeGreaterThan(0)
    expect(report.sequence.runs).toBe(20)
    expect(report.sequence.freshFiles).toBe(20)
    expect(report.sequence.order).toEqual(['coldTail', 'before1', 'before2', 'after'])
    for (const step of [report.sequence.coldTail, report.sequence.before1, report.sequence.before2, report.sequence.after]) {
      const sorted = step.samples.map((sample) => sample.durationMs).sort((a, b) => a - b)
      expect(step.samples).toHaveLength(20)
      expect(step.firstRunMs).toBe(step.samples[0]!.durationMs)
      expect(step.p50Ms).toBe(sorted[9]!)
      expect(step.p95Ms).toBe(sorted[18]!)
      for (const metric of ['ioBytes', 'indexBytes'] as const) {
        const values = step.samples.map((sample) => sample[metric]).sort((a, b) => a - b)
        expect(step[metric]).toEqual({ p50: values[9]!, p95: values[18]! })
      }
      for (const sample of step.samples) {
        expect(sample.records).toBe(120)
        expect(sample.ioBytes).toBeGreaterThan(0)
        expect(sample.returnedBytes).toBeGreaterThan(0)
      }
    }
    // 每个新文件实际倒读首批；冷尾页不因历史总量增加而突破 256 KiB。
    expect(report.sequence.coldTail.samples.every((sample) => sample.indexBytes === Math.min(report.sequence.fileBytes, 256 * 1024))).toBe(true)
    expect(report.sequence.before2.samples.every((sample) => sample.indexBytes === 0)).toBe(true)
    expect(report.sequence.after.samples.every((sample) => sample.indexBytes === 0)).toBe(true)
  }, 30_000)

  test('给定超过冷尾页预算的样本，冷扫描保持有界且后续步骤都有正文读取', () => {
    const result = runBenchmark(['--synthetic', '--messages', '1500', '--runs', '1', '--sequence-runs', '2'])
    expect(result.status).toBe(0)
    const report = JSON.parse(result.stdout) as Report
    expect(report.sequence.fileBytes).toBeGreaterThan(1024 * 1024)
    for (const sample of report.sequence.coldTail.samples) {
      expect(sample.indexBytes).toBeGreaterThan(0)
      expect(sample.indexBytes).toBeLessThanOrEqual(1024 * 1024)
    }
    for (const step of [report.sequence.before1, report.sequence.before2, report.sequence.after]) {
      expect(step.samples).toHaveLength(2)
      expect(step.samples.every((sample) => sample.records === 120 && sample.ioBytes > 0)).toBe(true)
    }
  })

  test('给定只有一条消息的会话，保留空上翻页指标而非伪造有效正文', () => {
    const result = runBenchmark(['--synthetic', '--messages', '1', '--runs', '1', '--sequence-runs', '1'])
    expect(result.status).toBe(0)
    const report = JSON.parse(result.stdout) as Report
    expect(report.sequence.before1.samples[0]!.records).toBe(0)
    expect(report.sequence.before2.samples[0]!.records).toBe(0)
    expect(report.sequence.after.samples[0]!.records).toBe(1)
  })

  test('给定未授权合成模式或非法次数，在创建文件前拒绝执行', () => {
    for (const args of [[], ['--synthetic', '--sequence-runs', '0'], ['--synthetic', '--sequence-runs', '101']]) {
      const result = runBenchmark(args)
      expect(result.status).not.toBe(0)
      expect(result.stdout).toBe('')
    }
  })
})
