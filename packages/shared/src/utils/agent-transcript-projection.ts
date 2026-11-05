import type { SDKMessage } from '../types/agent'

/** 仅缩减展示正文，保留角色、工具结果身份与错误/父工具关系；绝不用于模型恢复。 */
export function projectDeferredTranscriptMessage(message: SDKMessage | undefined, text: string, maxBlocks = 16): SDKMessage {
  if (!message) return { type: 'system', subtype: 'transcript_deferred', description: text }
  const source = message as Record<string, unknown>
  const result: Record<string, unknown> = { type: source.type, _promaTranscriptDeferred: true }
  for (const key of ['uuid', '_promaTranscriptId', 'parent_tool_use_id', 'isSynthetic', 'subtype', 'error', '_errorCode', '_createdAt', '_channelModelId']) {
    const value = source[key]
    if ((typeof value === 'string' && value.length <= 200) || typeof value === 'boolean' || typeof value === 'number' || value === null) result[key] = value
  }
  const body = source.message as { content?: unknown; role?: string; model?: string } | undefined
  const blocks = Array.isArray(body?.content) ? body.content as Array<Record<string, unknown>> : []
  if (source.type === 'user' || source.type === 'assistant') {
    const results = blocks.filter(block => block?.type === 'tool_result')
    const boundedId = (value: unknown): string | undefined => typeof value === 'string' && value.length <= 200 ? value : undefined
    const calls = blocks.filter(block => block?.type === 'tool_use')
    const content = results.length > 0 ? results.slice(0, maxBlocks).map(block => ({ type: 'tool_result', tool_use_id: boundedId(block.tool_use_id), is_error: block.is_error === true, content: text }))
      : calls.length > 0 ? [...calls.slice(0, Math.max(1, maxBlocks - 1)).map(block => ({ type: 'tool_use', id: boundedId(block.id), name: boundedId(block.name), input: { _transcriptDeferred: true } })), { type: 'text', text }]
      : [{ type: 'text', text }]
    result.message = { role: source.type, ...(typeof body?.model === 'string' && body.model.length <= 200 ? { model: body.model } : {}), content }
  } else if (source.type === 'system') result.description = text
  else return { type: 'system', subtype: 'transcript_deferred', description: text }
  return result as SDKMessage
}
