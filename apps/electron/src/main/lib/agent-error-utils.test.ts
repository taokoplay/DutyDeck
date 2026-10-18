import { describe, expect, test } from 'bun:test'
import { mapAgentErrorToTypedError } from './agent-error-utils'

describe('mapAgentErrorToTypedError', () => {
  test.each([
    '413 Failed to buffer the request body: length limit exceeded',
    'IMAGE_REQUEST_BUDGET_EXCEEDED: 图片预览合计超过 12 MiB，请分批比较；未自动丢弃任何图片。',
    'MODEL_REQUEST_BUDGET_EXCEEDED: 请求内容超过 16 MiB 客户端预算，请压缩上下文。',
  ])('Given 请求体超限 %s When 映射错误 Then 禁止原样重试并提示请求过大', (message) => {
    /** 三种真实入口应得到相同的不可重试语义。 */
    const result = mapAgentErrorToTypedError('provider_error', message, message)
    expect(result.title).toBe('请求内容过大')
    expect(result.canRetry).toBe(false)
    expect(result.actions?.some((action) => action.action === 'retry')).toBe(false)
    expect(result.message).not.toContain('MODEL_REQUEST_BUDGET_EXCEEDED')
    expect(result.message).not.toContain('IMAGE_REQUEST_BUDGET_EXCEEDED')
  })

  test('Given 普通正文中出现数字 413 When 映射错误 Then 不当作 HTTP 状态码', () => {
    /** 编号不能触发请求体错误分类。 */
    const result = mapAgentErrorToTypedError('provider_error', '任务 413 执行失败', '')
    expect(result.code).toBe('provider_error')
  })

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
