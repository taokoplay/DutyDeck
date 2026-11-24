import type { ModelCapabilities } from './model-capabilities'

/**
 * 官方文档已确认、但 models.dev 快照尚未同步的能力覆盖。
 * 覆盖只补模型能力字段，费用等已有快照字段继续保留，避免手工复制价格。
 */
export const MODEL_CAPABILITY_OVERRIDES: Record<string, Record<string, Partial<ModelCapabilities>>> = {
  openai: {
    'gpt-6.2-astra': {
      reasoning: true,
      reasoningOptions: [{ type: 'effort', values: ['low', 'medium', 'high', 'xhigh', 'max'] }],
      temperature: false,
      contextWindow: 1_050_000,
      maxOutputTokens: 128_000,
      inputModalities: ['text', 'image'],
      outputModalities: ['text'],
    },
    'gpt-6.2-sol': {
      reasoning: true,
      reasoningOptions: [{ type: 'effort', values: ['low', 'medium', 'high', 'xhigh', 'max'] }],
      temperature: false,
      contextWindow: 1_050_000,
      maxOutputTokens: 128_000,
      inputModalities: ['text', 'image'],
      outputModalities: ['text'],
    },
    'gpt-6.1-terra': {
      reasoning: true,
      reasoningOptions: [{ type: 'effort', values: ['none', 'low', 'medium', 'high', 'xhigh', 'max'] }],
      temperature: true,
      contextWindow: 1_050_000,
      maxOutputTokens: 128_000,
      inputModalities: ['text', 'image'],
      outputModalities: ['text'],
    },
    'gpt-6.1-sol': {
      reasoning: true,
      reasoningOptions: [{ type: 'effort', values: ['low', 'medium', 'high', 'xhigh', 'max'] }],
      temperature: false,
      contextWindow: 1_050_000,
      maxOutputTokens: 128_000,
      inputModalities: ['text', 'image'],
      outputModalities: ['text'],
    },
  },
  'zhipuai-coding-plan': {
    'glm-5.4': {
      reasoning: true,
      reasoningOptions: [{ type: 'effort', values: ['low', 'high', 'max'] }],
      temperature: true,
      contextWindow: 1_000_000,
      maxOutputTokens: 128_000,
      inputModalities: ['text', 'image'],
      outputModalities: ['text'],
    },
  },
  zhipuai: {
    'glm-5.3-flashx-legal': {
      reasoning: true,
      reasoningOptions: [{ type: 'effort', values: ['low', 'high', 'max'] }],
      temperature: true,
      contextWindow: 1_000_000,
      maxOutputTokens: 128_000,
      inputModalities: ['text', 'image', 'video', 'pdf'],
      outputModalities: ['text'],
      interleaved: { field: 'reasoning_content' },
    },
  },
}
