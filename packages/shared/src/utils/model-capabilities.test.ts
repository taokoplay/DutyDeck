import { describe, expect, test } from 'bun:test'
import { getModelCapabilities, getModelReasoningCapability } from './model-capabilities'

describe('端点能力查询边界', () => {
  test('Given API 与订阅同名模型 When 查询 Then 不跨供应商填充订阅能力', () => {
    expect(getModelCapabilities('openai', 'gpt-6-astra')?.contextWindow).toBe(1_050_000)
    expect(getModelCapabilities('openai-codex', 'gpt-6-astra')).toBeUndefined()
    expect(getModelCapabilities('custom', 'gpt-6-astra')).toBeUndefined()
  })

  test.each(['constructor', '__proto__'])('Given 非模型键 %s When 查询 Then 明确返回未知', (modelId) => {
    expect(getModelCapabilities('openai', modelId)).toBeUndefined()
  })

  test('Given OpenAI 官网新增模型 When 查询能力 Then 使用官方窗口、输出和输入模态', () => {
    for (const modelId of ['gpt-6.2-astra', 'gpt-6.2-sol', 'gpt-6.1-terra', 'gpt-6.1-sol']) {
      const capability = getModelCapabilities('openai', modelId)
      expect(capability?.contextWindow).toBe(1_050_000)
      expect(capability?.maxOutputTokens).toBe(128_000)
      expect(capability?.inputModalities).toEqual(['text', 'image'])
    }
    expect(getModelCapabilities('openai', 'gpt-6.1-terra')?.temperature).toBe(true)
    expect(getModelCapabilities('openai', 'gpt-6.2-sol')?.temperature).toBe(false)
  })

  test('Given Z.AI Coding Plan 的 GLM-5.4 When 查询能力 Then 保留 1M、128K 和 effort 档位', () => {
    const capability = getModelCapabilities('zhipu-coding', 'glm-5.4')
    expect(capability?.contextWindow).toBe(1_000_000)
    expect(capability?.maxOutputTokens).toBe(128_000)
    expect(capability?.reasoningOptions).toEqual([{ type: 'effort', values: ['low', 'high', 'max'] }])
  })

  test('Given Z.AI 官网 GLM-5.3 FlashX Legal When 查询能力 Then 保留视觉输入与 1M 窗口', () => {
    const capability = getModelCapabilities('zhipu', 'glm-5.3-flashx-legal')
    expect(capability?.contextWindow).toBe(1_000_000)
    expect(capability?.maxOutputTokens).toBe(128_000)
    expect(capability?.inputModalities).toContain('image')
    expect(capability?.reasoningOptions).toEqual([{ type: 'effort', values: ['low', 'high', 'max'] }])
  })

  test('Given 未经官网确认的 GLM-5.5 When 查询能力 Then 保持未知', () => {
    expect(getModelCapabilities('zhipu', 'glm-5.5')).toBeUndefined()
  })

  test('Given Gemini 默认强度 When 从快照生成能力 Then 保持已知产品偏好', () => {
    expect(getModelReasoningCapability('google', 'gemini-3.8-flash')?.defaultLevel).toBe('medium')
    expect(getModelReasoningCapability('google', 'gemini-3.1-flash-lite')?.defaultLevel).toBe('minimal')
  })

  test('Given Claude 预算模式 When 展示开关 Then 开启后的最低预算不等于禁止关闭', () => {
    expect(getModelReasoningCapability('anthropic', 'claude-opus-4-5')?.levels).toContain('off')
  })
})
