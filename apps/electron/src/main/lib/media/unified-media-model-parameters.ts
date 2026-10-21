import type { MediaInputValue, UnifiedMediaModelParameter } from '@dutydeck/shared'

/** 参数类型共享给IPC目录与执行器，避免两份合同漂移。 */
export type { UnifiedMediaModelParameter } from '@dutydeck/shared'

/** 根据已实现协议返回参数，不宣称尚未透传的供应商功能。 */
export function getUnifiedMediaModelParameters(adapterId: string, modelId?: string): UnifiedMediaModelParameter[] {
  if (adapterId === 'dreamina-image' && modelId && ['3.0', '3.1', '4.0', '4.1', '4.5', '4.6', '4.7', '5.0', '5.0Pro'].includes(modelId)) {
    /** 与即梦现有 prepareInputs 合同一致；配置默认值由执行时路由决定。 */
    const resolutions = modelId === '5.0Pro' ? ['1.5k', '2k', '4k'] : ['3.0', '3.1'].includes(modelId) ? ['1k', '2k'] : ['2k', '4k']
    /** 宽高边长与总像素上限取决于分辨率，不能声明一个误导性的固定最大值。 */
    const dimensions = `正整数像素；width 与 height 必须成对提供，与 ratio 互斥；边长和总像素需符合所选分辨率限制${['3.0', '3.1'].includes(modelId) ? '；此模型自定义尺寸必须使用 2k' : ''}`
    return [
      { name: 'ratio', type: 'string', description: '图片宽高比；与 width、height 自定义尺寸互斥', enum: ['21:9', '16:9', '3:2', '4:3', '1:1', '3:4', '2:3', '9:16'] },
      { name: 'count', type: 'number', description: '生成图片数量，必须为整数', defaultValue: 1, min: 1, max: 4 },
      { name: 'resolution_type', type: 'string', description: '图片分辨率；省略时使用模型配置的默认值', enum: resolutions },
      { name: 'width', type: 'number', description: dimensions, min: 1 },
      { name: 'height', type: 'number', description: dimensions, min: 1 },
    ]
  }
  if (adapterId === 'openai-images') {
    /** 已知模型使用各自尺寸集合；未知兼容模型只开放共同默认尺寸。 */
    const sizes = modelId === 'dall-e-2' ? ['256x256', '512x512', '1024x1024']
      : modelId === 'dall-e-3' ? ['1024x1024', '1792x1024', '1024x1792']
        : modelId?.startsWith('gpt-image-') ? ['1024x1024', '1536x1024', '1024x1536', 'auto'] : ['1024x1024']
    return [{ name: 'size', type: 'string', description: '输出图片尺寸', defaultValue: '1024x1024', enum: sizes }]
  }
  if (adapterId === 'minimax-speech' || adapterId === 'xiaomi-speech') return [
    { name: 'voice', type: 'string', description: '供应商音色 ID', defaultValue: adapterId === 'minimax-speech' ? 'female-shaonv' : 'mimo_default' },
    { name: 'format', type: 'string', description: '输出音频格式', defaultValue: 'mp3', enum: ['mp3'] },
  ]
  return []
}

/** 验证标量参数并返回原始输入；未知字段与非法值请求前明确拒绝。 */
export function prepareUnifiedMediaHttpInputs(adapterId: string, modelId: string, inputs: Record<string, MediaInputValue>): Record<string, MediaInputValue> {
  /** 参数集合很小，逐项查找避免额外缓存与失效状态。 */
  const parameters = getUnifiedMediaModelParameters(adapterId, modelId)
  for (const [name, input] of Object.entries(inputs)) {
    if (input.kind === 'asset') {
      if (adapterId.endsWith('-speech')) throw new Error('MEDIA_GENERATION_REFERENCE_UNSUPPORTED')
      continue
    }
    /** 拒绝错误类型与空音色，避免 String() 把非法输入转换后提交。 */
    const parameter = parameters.find(item => item.name === name)
    if (!parameter) throw new Error('MEDIA_GENERATION_PARAMETER_UNSUPPORTED')
    if (typeof input.value !== 'string' || !input.value.trim() || (parameter.enum && !parameter.enum.includes(input.value))) throw new Error('MEDIA_GENERATION_PARAMETER_INVALID')
  }
  return inputs
}
