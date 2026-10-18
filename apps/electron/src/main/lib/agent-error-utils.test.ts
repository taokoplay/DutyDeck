import { describe, expect, test } from 'bun:test'
import { mapAgentErrorToTypedError } from './agent-error-utils'

describe('mapAgentErrorToTypedError', () => {
  test('413 请求体过大时不提供原上下文重试，并引导压缩或新会话', () => {
    const result = mapAgentErrorToTypedError(
      'provider_error',
      '413 Request Entity Too Large',
      '413 Request Entity Too Large',
    )

    expect(result.code).toBe('prompt_too_long')
    expect(result.canRetry).toBe(false)
    expect(result.message).toBe('当前请求内容超过模型或网关限制，请压缩上下文、移除大附件或开启新会话')
    expect(result.actions).toEqual([
      { key: 's', label: '设置', action: 'settings' },
      { key: 'c', label: '压缩上下文', action: 'compact' },
    ])
  })

  test('Given 网关只返回 HTTP 413 When 没有附带错误文案 Then 仍归类为请求内容过大', () => {
    const result = mapAgentErrorToTypedError('unknown', 'HTTP 413', 'HTTP 413')

    expect(result.code).toBe('prompt_too_long')
    expect(result.canRetry).toBe(false)
  })
})
