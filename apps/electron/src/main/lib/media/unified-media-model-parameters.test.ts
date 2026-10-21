import { describe, expect, test } from 'bun:test'
import { getUnifiedMediaModelParameters, prepareUnifiedMediaHttpInputs } from './unified-media-model-parameters'

describe('统一媒体参数目录', () => {
  test('Given 各已实现适配器 When 查询参数 Then 只声明已透传能力', () => {
    expect(getUnifiedMediaModelParameters('openai-images', 'gpt-image-1')[0]?.enum).toContain('1536x1024')
    expect(getUnifiedMediaModelParameters('minimax-video')).toEqual([])
    expect(getUnifiedMediaModelParameters('minimax-image')).toEqual([])
    expect(getUnifiedMediaModelParameters('minimax-speech').map(item => item.name)).toEqual(['voice', 'format'])
  })
  test('Given 非MP3格式或非法尺寸 When 预处理 Then 拒绝错误输出声明', () => {
    expect(() => prepareUnifiedMediaHttpInputs('minimax-speech', 'speech', { format: { kind: 'scalar', value: 'wav' } })).toThrow('MEDIA_GENERATION_PARAMETER_INVALID')
    expect(() => prepareUnifiedMediaHttpInputs('openai-images', 'gpt-image-1', { size: { kind: 'scalar', value: '123x456' } })).toThrow('MEDIA_GENERATION_PARAMETER_INVALID')
    expect(() => prepareUnifiedMediaHttpInputs('xiaomi-speech', 'speech', { voice: { kind: 'scalar', value: 42 } })).toThrow('MEDIA_GENERATION_PARAMETER_INVALID')
  })
  test('Given 有效音色与格式 When 预处理 Then 保留完整输入', () => {
    expect(prepareUnifiedMediaHttpInputs('minimax-speech', 'speech', { voice: { kind: 'scalar', value: 'custom' }, format: { kind: 'scalar', value: 'mp3' } })).toEqual({ voice: { kind: 'scalar', value: 'custom' }, format: { kind: 'scalar', value: 'mp3' } })
  })
})
