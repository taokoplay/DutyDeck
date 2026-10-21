import { describe, expect, test } from 'bun:test'
import type { AudioGenerationPublicCatalog } from '@dutydeck/shared'
import type { ImageGenerationPublicCatalog } from '@dutydeck/shared'
import { formatMediaModelRef } from '@dutydeck/shared'
import { UnifiedMediaModelCatalog } from './unified-media-model-catalog'

const imageCatalog: ImageGenerationPublicCatalog = {
  schemaVersion: 1,
  revision: 2,
  profiles: [{ id: 'image-main', name: '图片主配置', provider: 'minimax', baseUrl: 'https://api.example.test/v1', models: [
    { id: 'image-01', name: 'Image 01', capabilities: ['text-to-image', 'image-to-image'] },
    { id: 'video-01', name: 'Video 01', capabilities: ['text-to-video'] },
  ], enabled: true, credentialConfigured: true, endpointOrigin: 'https://api.example.test', createdAt: 1, updatedAt: 2 }],
}

const audioCatalog: AudioGenerationPublicCatalog = {
  schemaVersion: 3,
  revision: 4,
  profiles: [{ id: 'audio-main', name: '语音主配置', provider: 'minimax', baseUrl: 'https://api.example.test/v1', models: [{ id: 'speech-2.8-hd', voices: [{ id: '青舟', source: 'remote' }] }], enabled: true, credentialConfigured: true, endpointOrigin: 'https://api.example.test', createdAt: 1, updatedAt: 2 }],
}

describe('UnifiedMediaModelCatalog', () => {
  test('Given 图片、视频和音频独立目录 When 列出模型 Then 统一引用且按能力报告执行器', () => {
    const catalog = new UnifiedMediaModelCatalog({
      readImageCatalog: () => imageCatalog,
      readAudioCatalog: () => audioCatalog,
      resolveImageApiKey: () => 'image-secret',
      resolveAudioApiKey: () => 'audio-secret',
    })
    const models = catalog.list('project-1')
    expect(models.map((model) => model.ref)).toEqual([
      formatMediaModelRef({ kind: 'image', provider: 'minimax', profileId: 'image-main', modelId: 'image-01' }),
      formatMediaModelRef({ kind: 'video', provider: 'minimax', profileId: 'image-main', modelId: 'video-01' }),
      formatMediaModelRef({ kind: 'audio', provider: 'minimax', profileId: 'audio-main', modelId: 'speech-2.8-hd' }),
    ])
    expect(models.find((model) => model.kind === 'video')?.adapterId).toBe('minimax-video')
  })

  test('Given 已停用模型 When 解析 Then 标记不可用且不能解析秘密路由', () => {
    const disabled = { ...imageCatalog, profiles: [{ ...imageCatalog.profiles[0]!, enabled: false }] }
    const catalog = new UnifiedMediaModelCatalog({
      readImageCatalog: () => disabled,
      readAudioCatalog: () => ({ ...audioCatalog, profiles: [] }),
      resolveImageApiKey: () => 'secret',
      resolveAudioApiKey: () => 'secret',
    })
    const model = catalog.list('project-1')[0]!
    expect(model.available).toBe(false)
    expect(() => catalog.resolve(model.ref)).toThrow('MEDIA_MODEL_UNAVAILABLE')
  })

  test('Given 只有尚未接入执行器的放大能力 When 列出模型 Then 明确标记不可用', () => {
    const catalog = new UnifiedMediaModelCatalog({
      readImageCatalog: () => ({ ...imageCatalog, profiles: [{ ...imageCatalog.profiles[0]!, models: [{ id: 'upscale-1', name: 'Upscale', capabilities: ['upscale'] }] }] }),
      readAudioCatalog: () => ({ ...audioCatalog, profiles: [] }),
      resolveImageApiKey: () => 'secret',
      resolveAudioApiKey: () => 'secret',
    })
    const model = catalog.list('project-1')[0]!
    expect(model.available).toBe(false)
    expect(model.unavailableReason).toBe('执行器尚未接入')
  })
})

/** 即梦不使用API key，公开目录中的凭据状态不证明实际CLI登录。 */
function dreaminaCatalog(models: ImageGenerationPublicCatalog['profiles'][number]['models'], enabled = true) {
  return new UnifiedMediaModelCatalog({
    readImageCatalog: () => ({ schemaVersion: 1, revision: 1, profiles: [{ id: 'dreamina', name: '即梦', provider: 'dreamina', cliPath: '/opt/dreamina', models, enabled, credentialConfigured: false, createdAt: 1, updatedAt: 1 }] }),
    readAudioCatalog: () => ({ ...audioCatalog, profiles: [] }),
    resolveImageApiKey: () => { throw new Error('不应读取API key') },
    resolveAudioApiKey: () => { throw new Error('不应读取API key') },
  })
}

describe('即梦统一图片目录', () => {
  test('Given 已核验图片模型 When 解析 Then 使用CLI路由和配置分辨率而非API凭据', () => {
    const catalog = dreaminaCatalog([{ id: '5.0', capabilities: ['text-to-image', 'image-to-image'], params: { resolution_type: '4k' } }])
    const option = catalog.list('project')[0]!
    expect(option).toMatchObject({ available: true, adapterId: 'dreamina-image' })
    expect(catalog.resolve(option.ref)).toMatchObject({ baseUrl: '', apiKey: '', cliPath: '/opt/dreamina', resolutionType: '4k' })
  })
  test('Given 旧模型虚报图生图或未知模型 When 列目录 Then 与真实能力取交集', () => {
    const catalog = dreaminaCatalog([
      { id: '3.0', capabilities: ['text-to-image', 'image-to-image'] },
      { id: '3.1', capabilities: ['image-to-image'] },
      { id: 'future', capabilities: ['text-to-image'] },
      { id: 'seedance2.5', capabilities: ['text-to-video'] },
    ])
    const options = catalog.list('project')
    expect(options[0]?.capabilities).toEqual(['text-to-image'])
    expect(catalog.resolve(options[0]!.ref).resolutionType).toBe('1k')
    expect(options.slice(1).every(option => !option.available)).toBe(true)
    expect(options[3]?.unavailableReason).toBe('即梦视频执行器尚未接入')
    expect(() => catalog.resolve(options[2]!.ref)).toThrow('MEDIA_MODEL_UNAVAILABLE')
  })
  test('Given 新图片模型缺省分辨率或停用配置 When 解析 Then 使用2k且不绕过停用', () => {
    const models = [{ id: '5.0Pro', capabilities: ['text-to-image' as const] }]
    const catalog = dreaminaCatalog(models)
    expect(catalog.resolve(catalog.list('project')[0]!.ref).resolutionType).toBe('2k')
    expect(dreaminaCatalog(models, false).list('project')[0]?.available).toBe(false)
  })
})

describe('统一目录公开参数', () => {
  test('Given OpenAI图片和音频模型 When 列目录 Then 返回与执行器一致的真实参数', () => {
    /** 使用真实目录投影，防止仅参数工具正确但API未接线。 */
    const catalog = new UnifiedMediaModelCatalog({
      readImageCatalog: () => ({ ...imageCatalog, profiles: [{ ...imageCatalog.profiles[0]!, provider: 'openai-images', baseUrl: 'https://api.example.test/v1', models: [{ id: 'gpt-image-1', capabilities: ['text-to-image'] }] }] }),
      readAudioCatalog: () => audioCatalog,
      resolveImageApiKey: () => 'secret', resolveAudioApiKey: () => 'secret',
    })
    /** 图片公开尺寸、音频公开音色和唯一已支持的MP3格式。 */
    const models = catalog.list('project')
    expect(models[0]?.parameters).toEqual([{ name: 'size', type: 'string', description: '输出图片尺寸', defaultValue: '1024x1024', enum: ['1024x1024', '1536x1024', '1024x1536', 'auto'] }])
    expect(models[1]?.parameters?.map(parameter => parameter.name)).toEqual(['voice', 'format'])
    expect(models[1]?.parameters?.find(parameter => parameter.name === 'format')?.enum).toEqual(['mp3'])
  })
  test('Given 未接入协议或未实现标量参数 When 列目录 Then 不虚构尺寸或时长', () => {
    /** MiniMax图片和视频当前只支持提示词与参考图，放大模型无执行器。 */
    const catalog = new UnifiedMediaModelCatalog({
      readImageCatalog: () => ({ ...imageCatalog, profiles: [{ ...imageCatalog.profiles[0]!, models: [...imageCatalog.profiles[0]!.models, { id: 'upscale', capabilities: ['upscale'] }] }] }),
      readAudioCatalog: () => ({ ...audioCatalog, profiles: [] }),
      resolveImageApiKey: () => 'secret', resolveAudioApiKey: () => 'secret',
    })
    expect(catalog.list('project').map(model => model.parameters)).toEqual([[], [], []])
  })
})

describe('即梦公开参数合同', () => {
  for (const [modelId, resolutions] of [['3.0', ['1k', '2k']], ['4.7', ['2k', '4k']], ['5.0Pro', ['1.5k', '2k', '4k']]] as const) {
    test(`Given 即梦${modelId} When 列目录 Then 公开真实五参数且不伪报配置默认分辨率`, () => {
      /** 配置可覆盖默认分辨率，因此目录不声明通用默认值。 */
      const parameters = dreaminaCatalog([{ id: modelId, capabilities: ['text-to-image'], params: { resolution_type: '4k' } }]).list('project')[0]!.parameters!
      expect(parameters.map(parameter => parameter.name)).toEqual(['ratio', 'count', 'resolution_type', 'width', 'height'])
      expect(parameters.find(parameter => parameter.name === 'resolution_type')).toEqual({ name: 'resolution_type', type: 'string', description: '图片分辨率；省略时使用模型配置的默认值', enum: resolutions })
      expect(parameters.find(parameter => parameter.name === 'count')).toMatchObject({ type: 'number', defaultValue: 1, min: 1, max: 4 })
      expect(parameters.find(parameter => parameter.name === 'ratio')?.enum).toContain('16:9')
      expect(parameters.find(parameter => parameter.name === 'width')?.description).toContain('成对')
      expect(parameters.find(parameter => parameter.name === 'height')?.description).toContain('互斥')
    })
  }
})
