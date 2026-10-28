import { expect, test } from 'bun:test'
import { normalizeContext } from '@earendil-works/pi-ai'
import type { Api, Model } from '@earendil-works/pi-ai/compat'
import { streamSimple as anthropic } from '@earendil-works/pi-ai/api/anthropic-messages'
import { streamSimple as completions } from '@earendil-works/pi-ai/api/openai-completions'
import { streamSimple as responses } from '@earendil-works/pi-ai/api/openai-responses'
import { buildComputerUseTools } from './tools'
import type { ComputerUseRun } from './service'

test.each(['anthropic-messages', 'openai-completions', 'openai-responses'] as const)('Given 桌面动作工具 When Pi 编码 %s 请求 Then 模型可以看到全部必要动作参数', async api => {
  /** 本测试只验证模型入口，绝不进入桌面执行。 */
  const unavailable = async (): Promise<never> => { throw new Error('此测试禁止桌面调用') }
  const run: ComputerUseRun = { discover: unavailable, observe: unavailable, action: unavailable, stop: unavailable, dispose: unavailable }
  const tools = buildComputerUseTools({ run, signal: new AbortController().signal, assertActive: () => {}, getPermissionMode: () => 'bypassPermissions', approve: unavailable })
  /** 真实工具 builder 产物必须经过供应商实际编码，不自行模拟 schema 转换。 */
  const context = normalizeContext({ messages: [{ role: 'user', content: '离线参数验证', timestamp: 1 }], tools })
  const model: Omit<Model<Api>, 'api' | 'compat'> = { id: 'offline-model', name: '离线模型', provider: 'offline-computer-use', baseUrl: 'https://fixture.invalid/v1', reasoning: false, input: ['text', 'image'], contextWindow: 32000, maxTokens: 1000, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }
  /** 在任何网络请求之前截获生产请求体并结束流。 */
  let payload: unknown
  let networkCalls = 0
  const options = { apiKey: 'offline-fixture', maxRetries: 0,
    onPayload: (body: unknown) => { payload = body; throw new Error('offline-payload-captured') },
    fetch: (async () => { networkCalls += 1; throw new Error('此测试禁止联网') }) as unknown as typeof fetch,
  }
  if (api === 'anthropic-messages') await anthropic({ ...model, api }, context, options).result()
  else if (api === 'openai-completions') await completions({ ...model, api }, context, options).result()
  else await responses({ ...model, api }, context, options).result()
  expect(networkCalls).toBe(0)
  expect(payload).toBeDefined()
  /** 三种供应商外层合同不同；这里只解析真实捕获的请求。 */
  const body = payload as { tools: Array<{ name?: string; parameters?: { type: string; properties: Record<string, unknown>; required: string[] }; input_schema?: { type: string; properties: Record<string, unknown>; required: string[] }; function?: { name: string; parameters: { type: string; properties: Record<string, unknown>; required: string[] } } }> }
  const action = body.tools.find(tool => (tool.name ?? tool.function?.name) === 'ComputerUseAction')
  const schema = action?.input_schema ?? action?.parameters ?? action?.function?.parameters
  expect(schema?.type).toBe('object')
  for (const key of ['kind', 'observationId', 'elementToken', 'text', 'key', 'direction', 'amount']) expect(schema?.properties[key]).toBeDefined()
  expect(schema?.required).toContain('kind')
  expect(schema?.required).toContain('observationId')
  expect(schema?.required).toContain('elementToken')
})
