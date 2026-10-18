import { describe, expect, test } from 'bun:test'
import type { SDKAssistantMessage } from '@dutydeck/shared'
import { createAgentErrorMessage } from './agent-error-message'
import { mapAgentErrorToTypedError } from './agent-error-utils'
import { hasPiAssistantTextContent, stripPiAssistantError } from './adapters/pi-message-adapter'

describe('Pi 终态错误提示的历史身份', () => {
  test.each(['Request timed out', 'Connection error.', '413 Request Entity Too Large'])(
    'Given 无正文错误 %s When 包装提示并持久化 Then 独立 UUID 仍关联原始 Pi 消息',
    (rawError) => {
      /** 原始错误消息具有 adapter 已建立 entry 映射的 UUID。 */
      const source: SDKAssistantMessage = {
        type: 'assistant', uuid: 'pi-original', parent_tool_use_id: null,
        message: { content: [] }, error: { message: rawError },
      }
      /** 提示走生产错误分类与包装链路，不伪造错误字段。 */
      const result = createAgentErrorMessage(source, mapAgentErrorToTypedError('unknown', rawError, rawError), 'model-1', 'openai')
      /** JSONL 序列化后仍须能定位 Pi 原始消息。 */
      const persisted = JSON.parse(JSON.stringify(result)) as SDKAssistantMessage
      expect(hasPiAssistantTextContent(source)).toBe(false)
      expect(persisted.uuid).toBeTruthy()
      expect(persisted.uuid).not.toBe(source.uuid)
      expect(persisted._piSourceUuid).toBe(source.uuid)
      expect(persisted._channelModelId).toBe('model-1')
      expect(persisted._channelProvider).toBe('openai')
      expect(result._errorActions.length).toBeGreaterThan(0)
    },
  )

  test('Given 断流前已输出正文 When 分别保存正文与错误提示 Then 正文不丢失且两个展示 UUID 不重复', () => {
    /** 原始回复含正文、用量及独立的失败字段。 */
    const source: SDKAssistantMessage = {
      type: 'assistant', uuid: 'pi-partial', parent_tool_use_id: null,
      message: { content: [{ type: 'text', text: '已经完成的分析内容' }], usage: { input_tokens: 42, output_tokens: 12 } },
      error: { message: 'Connection error.' },
    }
    /** 使用编排层同一条正文保留路径。 */
    const partial = stripPiAssistantError(source)
    /** 使用编排层同一条错误包装路径。 */
    const error = createAgentErrorMessage(source, mapAgentErrorToTypedError('unknown', 'Connection error.', 'Connection error.'), undefined, 'openai')
    expect(hasPiAssistantTextContent(source)).toBe(true)
    expect(partial.uuid).toBe(source.uuid)
    expect(partial.message).toEqual(source.message)
    expect(partial.error).toBeUndefined()
    expect(source.error).toEqual({ message: 'Connection error.' })
    expect(new Set([partial.uuid, error.uuid]).size).toBe(2)
    expect(error._piSourceUuid).toBe(partial.uuid)
    expect(error.message.content).not.toEqual(partial.message.content)
  })

  test('Given 原始消息无 UUID When 包装提示 Then 不伪造历史关联', () => {
    /** 无历史身份的异常输入仍允许显示提示，但不能承诺可回退。 */
    const source: SDKAssistantMessage = { type: 'assistant', parent_tool_use_id: null, message: { content: [] } }
    /** 缺少来源身份时也保留既有错误提示能力。 */
    const error = createAgentErrorMessage(source, mapAgentErrorToTypedError('unknown', 'Unknown error', 'Unknown error'), undefined, undefined)
    expect(error._piSourceUuid).toBeUndefined()
    expect(error.uuid).toBeTruthy()
  })
})
