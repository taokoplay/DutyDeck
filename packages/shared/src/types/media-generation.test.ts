import { describe, expect, test } from 'bun:test'
import { formatMediaModelRef, parseMediaGenerationRequest, parseMediaModelRef } from './media-generation'

describe('统一媒体模型引用', () => {
  test('Given 合法音频模型 When 编解码 Then 保持稳定引用', () => {
    const ref = { kind: 'audio' as const, provider: 'minimax', profileId: 'speech-main', modelId: 'speech-2.8-hd' }
    expect(parseMediaModelRef(formatMediaModelRef(ref))).toEqual(ref)
  })

  test('Given 越权或不完整模型引用 When 解析 Then 拒绝', () => {
    expect(() => parseMediaModelRef('media:audio:minimax:__proto__:speech')).toThrow('MEDIA_MODEL_REF_INVALID')
    expect(() => parseMediaModelRef('media:audio:minimax:profile:')).toThrow('MEDIA_MODEL_REF_INVALID')
  })

  test('Given 统一生成输入 When 包含密钥字段或空提示词 Then 拒绝', () => {
    expect(() => parseMediaGenerationRequest({ projectId: 'p', operationId: 'o', modelRef: 'media:audio:minimax:profile:speech', prompt: ' ', inputs: {}, apiKey: 'secret' })).toThrow('MEDIA_GENERATION_INPUT_INVALID')
  })

  test('Given 受管图片资产 When 使用统一包装格式 Then 接受并保留完整引用', () => {
    /** 参考图必须经过 kind/asset 包装，保证模型不能把裸对象误当成输入值。 */
    const request = parseMediaGenerationRequest({
      projectId: 'p',
      operationId: 'o',
      modelRef: 'media:video:minimax:profile:video-model',
      prompt: '生成首帧视频',
      inputs: {
        reference: {
          kind: 'asset',
          asset: {
            assetId: 'asset-1',
            revision: 1,
            hash: 'a'.repeat(64),
            mediaKind: 'image',
          },
        },
      },
    })
    expect(request.inputs.reference).toEqual({
      kind: 'asset',
      asset: { assetId: 'asset-1', revision: 1, hash: 'a'.repeat(64), mediaKind: 'image' },
    })
  })

  test('Given 裸媒体资产 When 省略 kind 包装 Then 拒绝并返回输入错误', () => {
    /** 裸 MediaAssetRef 是此前会话反复失败的输入形状，必须保持明确拒绝。 */
    expect(() => parseMediaGenerationRequest({
      projectId: 'p',
      operationId: 'o',
      modelRef: 'media:video:minimax:profile:video-model',
      prompt: '生成首帧视频',
      inputs: {
        reference: { assetId: 'asset-1', revision: 1, hash: 'a'.repeat(64), mediaKind: 'image' },
      },
    })).toThrow('MEDIA_GENERATION_INPUT_INVALID')
  })
})
