import { describe, expect, test } from 'bun:test'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ExtensionAPI, ExtensionContext, SessionBeforeCompactEvent } from '@earendil-works/pi-coding-agent'
import { createPiCompactionExtension } from './pi-compaction-extension'

type PiSdk = typeof import('@earendil-works/pi-coding-agent')

/** 最小消息构造：内容长度用于触发预算判断。 */
function message(role: 'user' | 'assistant', chars: number, index: number): Record<string, unknown> {
  return {
    role,
    content: [{ type: 'text', text: `${index}`.padStart(8, '0') + 'x'.repeat(chars) }],
    timestamp: index,
  }
}

/** 构造超预算的压缩 preparation。 */
function preparation(messageCount = 2): SessionBeforeCompactEvent['preparation'] {
  return {
    firstKeptEntryId: 'entry-keep',
    messagesToSummarize: Array.from({ length: messageCount }, (_, index) => message('user', 60_000, index)) as never,
    turnPrefixMessages: [],
    isSplitTurn: false,
    tokensBefore: 120_000,
    fileOps: { read: new Set<string>(), written: new Set<string>(), edited: new Set<string>() },
    settings: { enabled: true, reserveTokens: 1_000, keepRecentTokens: 20_000 },
  }
}

/** 构造事件；reason 决定是否应被接管。 */
function event(reason: SessionBeforeCompactEvent['reason'] = 'manual', messageCount = 2): SessionBeforeCompactEvent {
  return {
    type: 'session_before_compact',
    preparation: preparation(messageCount),
    branchEntries: [],
    reason,
    willRetry: false,
    signal: new AbortController().signal,
  }
}

/** 捕获扩展注册的 handler。 */
function captureHandler(deps: Parameters<typeof createPiCompactionExtension>[0]) {
  const extension = createPiCompactionExtension(deps)
  const factory = (extension as { factory: (pi: ExtensionAPI) => void }).factory
  let handler: ((input: SessionBeforeCompactEvent, ctx: ExtensionContext) => Promise<unknown>) | undefined
  factory({
    on: (name: string, registered: unknown) => {
      if (name === 'session_before_compact') handler = registered as typeof handler
      return () => undefined
    },
  } as unknown as ExtensionAPI)
  if (!handler) throw new Error('session_before_compact handler not registered')
  return handler
}

/** 构造带鉴权的扩展上下文。 */
function context(options: { authorized?: boolean } = {}): ExtensionContext {
  return {
    model: { provider: 'test', id: 'model', api: 'openai-completions', contextWindow: 5_000, maxTokens: 1_000 },
    thinkingLevel: 'off',
    modelRegistry: {
      getApiKeyAndHeaders: async () => options.authorized === false
        ? { ok: false, error: 'missing credentials' }
        : { ok: true, apiKey: 'test-key', headers: { 'x-test': '1' } },
    },
  } as unknown as ExtensionContext
}

/** 构造记录调用的 SDK：序列化保持真实长度，摘要返回可识别的结果。 */
function sdkStub(overrides: { compact?: (input: unknown) => Promise<unknown> } = {}) {
  const calls: unknown[] = []
  const sdk = {
    convertToLlm: (messages: unknown[]) => messages,
    serializeConversation: (messages: unknown[]) => JSON.stringify(messages),
    estimateTokens: () => 1_000,
    compact: async (input: unknown) => {
      calls.push(input)
      if (overrides.compact) return overrides.compact(input)
      return {
        summary: `summary-${calls.length}`,
        firstKeptEntryId: 'entry-keep',
        tokensBefore: 120_000,
        usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: 15, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
        details: { readFiles: [], modifiedFiles: [] },
      }
    },
  } as unknown as PiSdk
  return { sdk, calls }
}

/** 默认依赖：模型窗口很小，保证超预算路径被触发。 */
function deps(sdk: PiSdk) {
  return {
    sdk,
    getSession: () => undefined,
    getModel: () => ({ provider: 'test', id: 'model', api: 'openai-completions', contextWindow: 5_000, maxTokens: 1_000 }) as never,
    getCompactionSettings: () => ({ enabled: true, reserveTokens: 1_000, keepRecentTokens: 20_000 }),
    getRetrySettings: () => ({ enabled: true, maxRetries: 3, baseDelayMs: 2_000 }) as never,
  }
}

describe('手动压缩摘要策略扩展', () => {
  test('Given 手动压缩且输入超预算 When 接管 Then 分块摘要并返回首个 keep 边界', async () => {
    const { sdk, calls } = sdkStub()
    const handler = captureHandler(deps(sdk))
    const result = await handler(event('manual'), context()) as { compaction: { summary: string; firstKeptEntryId: string } }
    expect(calls.length).toBe(2)
    expect(result.compaction.summary).toBe('summary-2')
    expect(result.compaction.firstKeptEntryId).toBe('entry-keep')
  })

  test('Given 自动阈值压缩 When 触发 Then 不接管，保持 Pi 原生自动续跑', async () => {
    const { sdk, calls } = sdkStub()
    const handler = captureHandler(deps(sdk))
    const result = await handler(event('threshold'), context())
    expect(result).toBeUndefined()
    expect(calls).toHaveLength(0)
  })

  test('Given 摘要输入未超预算 When 手动压缩 Then 交回 Pi 默认单次摘要', async () => {
    const { sdk, calls } = sdkStub()
    const handler = captureHandler(deps(sdk))
    const small = event('manual')
    small.preparation.messagesToSummarize = [message('user', 10, 0)] as never
    const result = await handler(small, context())
    expect(result).toBeUndefined()
    expect(calls).toHaveLength(0)
  })

  test('Given 模型未配置鉴权 When 超预算 Then 不接管且不冒发请求', async () => {
    const { sdk, calls } = sdkStub()
    const handler = captureHandler(deps(sdk))
    const result = await handler(event('manual'), context({ authorized: false }))
    expect(result).toBeUndefined()
    expect(calls).toHaveLength(0)
  })

  test('Given 摘要请求失败 When 分块执行 Then 回退到 Pi 默认路径而不是新增失败', async () => {
    const { sdk } = sdkStub({ compact: async () => { throw new Error('provider overloaded') } })
    const handler = captureHandler(deps(sdk))
    const result = await handler(event('manual'), context())
    expect(result).toBeUndefined()
  })

  test('Given 托管模式 noExtensions When 注入内联扩展 Then 仍会被 Pi 加载并注册压缩 hook', async () => {
    const sdk = await import('@earendil-works/pi-coding-agent')
    const loader = new sdk.DefaultResourceLoader({
      cwd: process.cwd(),
      agentDir: mkdtempSync(join(tmpdir(), 'dutydeck-compaction-')),
      noExtensions: true,
      noSkills: true,
      noContextFiles: true,
      extensionFactories: [createPiCompactionExtension(deps(sdk as unknown as PiSdk))],
    })
    await loader.reload()
    const extensions = loader.getExtensions().extensions
    expect(extensions.some((extension) => extension.handlers.has('session_before_compact'))).toBe(true)
  })
})
