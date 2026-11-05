import { afterEach, describe, expect, mock, test } from 'bun:test'
import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { calculateContextUsageRatio, inferContextWindow } from '@dutydeck/shared'

let sessionPath = ''
const temporaryDirectories: string[] = []

mock.module('./config-paths', () => ({
  getAgentSessionMessagesPath: () => sessionPath,
}))

const { getSessionContextUsageRatio, captureSessionUsageSnapshot, observeSessionUsageAppend } = await import('./agent-session-usage')

interface UsageStatusCarrier {
  usageStatus?: 'known' | 'partial' | 'unknown'
}

function writeSession(messages: unknown[]): void {
  const directory = mkdtempSync(join(tmpdir(), 'proma-agent-session-usage-'))
  temporaryDirectories.push(directory)
  sessionPath = join(directory, 'session.jsonl')
  writeFileSync(sessionPath, `${messages.map((message) => JSON.stringify(message)).join('\n')}\n`, 'utf-8')
}

function assistant(inputTokens: number, status?: UsageStatusCarrier['usageStatus']): object {
  return {
    type: 'assistant',
    message: {
      content: [],
      model: 'gpt-6-astra',
      usage: { input_tokens: inputTokens, output_tokens: 1 },
      ...(status ? { usageStatus: status } : {}),
    },
  }
}

function result(inputTokens: number, status?: UsageStatusCarrier['usageStatus']): object {
  return {
    type: 'result',
    subtype: 'success',
    usage: { input_tokens: inputTokens, output_tokens: 1 },
    ...(status ? { usageStatus: status } : {}),
    modelUsage: { 'gpt-6-astra': { contextWindow: 372_000 } },
  }
}

afterEach(() => {
  while (temporaryDirectories.length > 0) {
    const directory = temporaryDirectories.pop()
    if (directory) rmSync(directory, { recursive: true, force: true })
  }
  sessionPath = ''
})

describe('Agent 会话上下文用量', () => {
  test('Given 可靠usage被超长未知尾部隔开 When 超出尾读预算 Then 返回未知而不全文扫描取旧值', () => {
    writeSession([assistant(120, 'known'), { type: 'user', message: { content: '汉'.repeat(300000) } }])
    expect(getSessionContextUsageRatio('bounded')).toBeUndefined()
  })

  test('Given 缓存后同长度正文替换 When 再查 Then 不能返回旧快照', () => {
    writeSession([assistant(120, 'known')])
    expect(getSessionContextUsageRatio('rewrite')).toBe(calculateContextUsageRatio(120, inferContextWindow('gpt-6-astra')))
    writeFileSync(sessionPath, JSON.stringify(assistant(240, 'known')) + '\n')
    expect(getSessionContextUsageRatio('rewrite')).toBe(calculateContextUsageRatio(240, inferContextWindow('gpt-6-astra')))
  })

  test('Given 缓存后追加压缩边界 When 再查 Then 不返回缓存的旧usage', () => {
    writeSession([assistant(120, 'known')])
    getSessionContextUsageRatio('append-boundary')
    appendFileSync(sessionPath, JSON.stringify({ type: 'system', subtype: 'compact_boundary' }) + '\n')
    expect(getSessionContextUsageRatio('append-boundary')).toBeUndefined()
  })

  test('Given 缓存token与半行尾部 When 读取 Then 包含缓存token并跳过未完成JSON', () => {
    writeSession([{ type: 'assistant', message: { model: 'gpt-6-astra', usage: { input_tokens: 10, cache_read_input_tokens: 20, cache_creation_input_tokens: 30 } } }])
    appendFileSync(sessionPath, '{"type":')
    expect(getSessionContextUsageRatio('partial-line')).toBe(calculateContextUsageRatio(60, inferContextWindow('gpt-6-astra')))
  })

  test('Given 超过并发上限的未知usage When 后续再次查询 Then 等待中的会话仍可回填', async () => {
    const paths: string[] = []
    for (let index = 0; index < 3; index++) {
      writeSession([assistant(120, 'known'), ...Array.from({ length: 2300 }, () => ({ type: 'tool_progress' }))])
      paths.push(sessionPath)
      expect(getSessionContextUsageRatio(`backfill-${index}`)).toBeUndefined()
    }
    const values: Array<number | undefined> = []
    for (let attempt = 0; attempt < 100; attempt++) {
      await Bun.sleep(10)
      for (let index = 0; index < paths.length; index++) {
        sessionPath = paths[index]!
        values[index] = getSessionContextUsageRatio(`backfill-${index}`)
      }
      if (values.every((value) => value !== undefined)) break
    }
    expect(values).toEqual(paths.map(() => calculateContextUsageRatio(120, inferContextWindow('gpt-6-astra'))))
  })

  test('Given 回填期间追加未知日志 When 旧回填失效 Then 新版本仍能重新回填', async () => {
    writeSession([assistant(120, 'known'), ...Array.from({ length: 2300 }, () => ({ type: 'tool_progress' }))])
    expect(getSessionContextUsageRatio('pending-append')).toBeUndefined()
    const previous = captureSessionUsageSnapshot(sessionPath)
    expect(previous).toBeUndefined()
    const message = { type: 'tool_progress' }
    appendFileSync(sessionPath, JSON.stringify(message) + '\n')
    observeSessionUsageAppend(sessionPath, [message], previous)
    let value: number | undefined
    for (let attempt = 0; attempt < 100; attempt++) {
      await Bun.sleep(10)
      value = getSessionContextUsageRatio('pending-append')
      if (value !== undefined) break
    }
    expect(value).toBe(calculateContextUsageRatio(120, inferContextWindow('gpt-6-astra')))
  })

  test('Given 可靠快照后受管追加大量无usage记录 When 版本连续 Then 不必重新扫描尾部且遇边界清零', () => {
    writeSession([assistant(120, 'known')])
    const expected = getSessionContextUsageRatio('append')
    const previous = captureSessionUsageSnapshot(sessionPath)
    const messages = [{ type: 'user', message: { content: '汉'.repeat(300000) } }]
    appendFileSync(sessionPath, JSON.stringify(messages[0]) + '\n')
    observeSessionUsageAppend(sessionPath, messages, previous)
    expect(getSessionContextUsageRatio('append')).toBe(expected)
    const current = captureSessionUsageSnapshot(sessionPath)
    const boundary = { type: 'system', subtype: 'compact_boundary' }
    appendFileSync(sessionPath, JSON.stringify(boundary) + '\n')
    observeSessionUsageAppend(sessionPath, [boundary], current)
    expect(getSessionContextUsageRatio('append')).toBeUndefined()
  })

  test('Given 新 result 是部分累计值且同轮有可靠 assistant When 读取占用 Then 使用 assistant 的最后已知上下文', () => {
    writeSession([
      assistant(120, 'known'),
      result(960, 'partial'),
    ])

    expect(getSessionContextUsageRatio('session-1')).toBe(
      calculateContextUsageRatio(120, inferContextWindow('gpt-6-astra')),
    )
  })

  test('Given 新 result 标记为 known 但其值是累计值 When 同轮有 assistant Then 不以 result 替换 assistant 上下文', () => {
    writeSession([
      assistant(120, 'known'),
      result(960, 'known'),
    ])

    expect(getSessionContextUsageRatio('session-1')).toBe(
      calculateContextUsageRatio(120, inferContextWindow('gpt-6-astra')),
    )
  })

  test('Given 最新 assistant 用量未知且尚未压缩 When 之前有可靠 assistant Then 保留最后已知上下文', () => {
    writeSession([
      assistant(120, 'known'),
      assistant(0, 'unknown'),
    ])

    expect(getSessionContextUsageRatio('session-1')).toBe(
      calculateContextUsageRatio(120, inferContextWindow('gpt-6-astra')),
    )
  })

  test('Given 未知用量位于压缩边界之后 When 读取占用 Then 不跨边界复用压缩前的精确值', () => {
    writeSession([
      assistant(120, 'known'),
      { type: 'system', subtype: 'compact_boundary' },
      assistant(0, 'unknown'),
      result(0, 'unknown'),
    ])

    expect(getSessionContextUsageRatio('session-1')).toBeUndefined()
  })

  test('Given 合成压缩 result 没有状态且带零值 When 后面没有 assistant Then 不将其当作真实上下文', () => {
    writeSession([
      {
        type: 'result',
        subtype: 'success',
        usage: { input_tokens: 0, output_tokens: 0 },
        isSyntheticCompactionResult: true,
      },
    ])

    expect(getSessionContextUsageRatio('session-1')).toBeUndefined()
  })

  test('Given 旧 JSONL 没有 usageStatus When 读取占用 Then 保留原 result 优先行为', () => {
    writeSession([
      assistant(120),
      result(960),
    ])

    expect(getSessionContextUsageRatio('session-1')).toBe(
      calculateContextUsageRatio(960, 372_000),
    )
  })

  test('Given result 提供真实 128K 窗口 When 模型推断回退为 200K Then 使用真实窗口计算占用率', () => {
    writeSession([{
      type: 'result',
      subtype: 'success',
      usage: { input_tokens: 64_000, output_tokens: 1 },
      modelUsage: { 'unknown-128k-model': { contextWindow: 128_000 } },
    }])

    expect(getSessionContextUsageRatio('session-1')).toBe(
      calculateContextUsageRatio(64_000, 128_000),
    )
  })

  test('Given result 的运行时窗口非法 When 模型可推断 Then 仅此时使用推断窗口', () => {
    writeSession([{
      type: 'result',
      subtype: 'success',
      usage: { input_tokens: 64_000, output_tokens: 1 },
      modelUsage: { 'unknown-model': { contextWindow: 0 } },
    }])

    expect(getSessionContextUsageRatio('session-1')).toBe(
      calculateContextUsageRatio(64_000, inferContextWindow('unknown-model')),
    )
  })
})
