import { randomUUID } from 'node:crypto'
import type { SDKAssistantMessage, TypedError } from '@dutydeck/shared'

/** 宿主错误提示及已持久化的恢复操作元数据。 */
interface AgentErrorMessage extends SDKAssistantMessage {
  /** 提示创建时间，单位为毫秒。 */
  _createdAt: number
  /** 用户可见的错误类别。 */
  _errorCode: TypedError['code']
  /** 用户可见的错误标题。 */
  _errorTitle: string
  /** 用于排查的错误详情。 */
  _errorDetails?: string[]
  /** 是否允许用户重试。 */
  _errorCanRetry: boolean
  /** 错误提示支持的恢复操作。 */
  _errorActions: TypedError['actions']
}

/**
 * 将原始 assistant 的终态错误包装成独立提示，不改写已产生的部分正文。
 * @param source 原始 Pi assistant 消息，保留其历史节点关联。
 * @param error 已完成分类和友好化的错误。
 * @param modelId 当前渠道模型 ID。
 * @param provider 当前渠道供应商。
 * @returns 使用独立展示 UUID 的可持久化错误提示。
 */
export function createAgentErrorMessage(
  source: SDKAssistantMessage,
  error: TypedError,
  modelId: SDKAssistantMessage['_channelModelId'],
  provider: SDKAssistantMessage['_channelProvider'],
): AgentErrorMessage {
  return {
    type: 'assistant',
    message: {
      content: [{ type: 'text', text: error.title ? `${error.title}: ${error.message}` : error.message }],
    },
    parent_tool_use_id: null,
    uuid: randomUUID(),
    _piSourceUuid: source.uuid,
    _channelModelId: modelId,
    _channelProvider: provider,
    error: { message: error.message, errorType: error.code },
    _createdAt: Date.now(),
    _errorCode: error.code,
    _errorTitle: error.title,
    _errorDetails: error.details,
    _errorCanRetry: error.canRetry,
    _errorActions: error.actions,
  }
}
