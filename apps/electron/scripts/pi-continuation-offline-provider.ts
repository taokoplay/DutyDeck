import { appendFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { createAssistantMessageEventStream, type AssistantMessage } from '@earendil-works/pi-ai'
import type { StreamFn } from '@earendil-works/pi-agent-core'
/** 仅 smoke bundle 导入：离线生成一次 write，完成后等待强杀或输出回复。 */
export const offlineContinuationStream: StreamFn = (_model, context) => {
  const root = process.env.PI_CONTINUATION_SMOKE_ROOT!
  appendFileSync(join(root, 'calls'), `${process.env.PI_CONTINUATION_SMOKE_PHASE}\n`)
  const stream = createAssistantMessageEventStream()
  if (context.messages.at(-1)?.role === 'toolResult' && process.env.PI_CONTINUATION_SMOKE_PHASE === 'crash') {
    writeFileSync(join(root, 'ready'), 'ready')
    return stream
  }
  const tool = context.messages.at(-1)?.role === 'user'
  const message: AssistantMessage = {
    role: 'assistant', content: tool ? [{ type: 'toolCall', id: 'side-effect-once', name: 'write', arguments: { path: join(root, 'effect.txt'), content: 'once' } }] : [{ type: 'text', text: '续接完成' }],
    stopReason: tool ? 'toolUse' : 'stop', api: 'openai-completions', provider: 'openai', model: 'gpt-4o', timestamp: Date.now(),
    usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
  }
  stream.push({ type: 'start', partial: message })
  stream.push({ type: 'done', reason: tool ? 'toolUse' : 'stop', message })
  return stream
}
