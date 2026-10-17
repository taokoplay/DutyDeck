import { describe, expect, test } from 'bun:test'
import type { MediaGenerationRequest, UnifiedMediaModelOption } from '@proma/shared'
import { UnifiedMediaGenerationService, type UnifiedMediaGenerationAdapter } from './unified-media-generation-service'

const model: UnifiedMediaModelOption = {
  ref: 'media:audio:minimax:profile:speech-2.8-hd', name: 'Speech', kind: 'audio', provider: 'minimax', profileId: 'profile', modelId: 'speech-2.8-hd', capabilities: ['text-to-speech'], available: true, adapterId: 'fake',
}

const request: MediaGenerationRequest = {
  projectId: 'project-1', operationId: 'operation-1', modelRef: model.ref, prompt: '你好', inputs: {},
}

describe('UnifiedMediaGenerationService', () => {
  test('Given 已配置模型 When Agent 准备、执行并等待 Then 输出登记为媒体资产', async () => {
    const adapter: UnifiedMediaGenerationAdapter = { id: 'fake', generate: async () => [{ bytes: new Uint8Array([1, 2, 3]), contentType: 'audio/mpeg' }] }
    let registeredKind: string | undefined
    const service = new UnifiedMediaGenerationService({
      resolveModel: () => ({ option: model, ref: { kind: 'audio', provider: 'minimax', profileId: 'profile', modelId: 'speech-2.8-hd' }, baseUrl: 'https://example.test', apiKey: 'secret' }),
      adapters: [adapter],
      registerOutput: async (_projectId, _operationId, _bytes, _contentType, origin, expectedMediaKind) => {
        registeredKind = expectedMediaKind
        return { assetId: 'asset-1', revision: 1, hash: 'a'.repeat(64), mediaKind: 'audio', sourceSessionId: origin.sourceSessionId }
      },
      now: () => 100,
    })
    const prepared = service.prepare('session-1', request)
    expect(prepared.phase).toBe('prepared')
    const running = await service.execute('session-1', prepared.id, prepared.revision)
    expect(running.phase).toBe('running')
    const done = await service.wait('session-1', prepared.id, 1_000, running.revision)
    expect(done.phase).toBe('succeeded')
    expect(done.outputs[0]?.asset.assetId).toBe('asset-1')
    expect(registeredKind).toBe('audio')
  })

  test('Given 其它会话持有运行 When 查询或取消 Then 拒绝越权', () => {
    const service = new UnifiedMediaGenerationService({
      resolveModel: () => ({ option: model, ref: { kind: 'audio', provider: 'minimax', profileId: 'profile', modelId: 'speech-2.8-hd' }, baseUrl: 'https://example.test', apiKey: 'secret' }),
      adapters: [{ id: 'fake', generate: async () => [{ bytes: new Uint8Array([1]), contentType: 'audio/mpeg' }] }],
      registerOutput: async () => ({ assetId: 'asset-1', revision: 1, hash: 'a'.repeat(64), mediaKind: 'audio' }),
    })
    const prepared = service.prepare('session-1', request)
    expect(() => service.get('session-2', prepared.id)).toThrow('MEDIA_GENERATION_NOT_OWNED')
    expect(() => service.cancel('session-2', prepared.id)).toThrow('MEDIA_GENERATION_NOT_OWNED')
    expect(() => service.getAttachmentSource('session-2', prepared.id)).toThrow('MEDIA_GENERATION_NOT_OWNED')
    /** 回填只读取冻结输入，不泄漏供应商密钥，也不能改写原运行。 */
    const source = service.getAttachmentSource('session-1', prepared.id)
    expect(source.request.prompt).toBe('你好')
    expect(JSON.stringify(source)).not.toContain('secret')
    source.request.prompt = '已修改'
    expect(service.getAttachmentSource('session-1', prepared.id).request.prompt).toBe('你好')
  })

  test('Given 模型能力与素材类型不匹配 When Agent 准备生成 Then 在供应商请求前拒绝', () => {
    const imageModel: UnifiedMediaModelOption = {
      ref: 'media:image:openai-images:image:gpt-image-1', name: 'Image', kind: 'image', provider: 'openai-images', profileId: 'image', modelId: 'gpt-image-1', capabilities: ['text-to-image'], available: true, adapterId: 'openai-images',
    }
    const service = new UnifiedMediaGenerationService({
      resolveModel: () => ({ option: imageModel, ref: { kind: 'image', provider: 'openai-images', profileId: 'image', modelId: 'gpt-image-1' }, baseUrl: 'https://example.test', apiKey: 'secret' }),
      adapters: [{ id: 'openai-images', generate: async () => [] }],
      registerOutput: async () => ({ assetId: 'asset-1', revision: 1, hash: 'a'.repeat(64), mediaKind: 'image' }),
    })
    expect(() => service.prepare('session-1', {
      projectId: 'project-1', operationId: 'operation-1', modelRef: imageModel.ref, prompt: '生成',
      inputs: { reference: { kind: 'asset', asset: { assetId: 'audio-1', revision: 1, hash: 'a'.repeat(64), mediaKind: 'audio' } } },
    })).toThrow('MEDIA_GENERATION_INPUT_INVALID')
  })

  test('Given 图片适配器只接入单参考 When 准备两张参考 Then 执行前拒绝', () => {
    /** 两张合法图片引用用于证明不是媒体类型校验导致失败。 */
    const imageModel: UnifiedMediaModelOption = { ...model, kind: 'image', capabilities: ['image-to-image'], adapterId: 'openai-images' }
    const service = new UnifiedMediaGenerationService({
      resolveModel: () => ({ option: imageModel, ref: { kind: 'image', provider: 'openai-images', profileId: 'profile', modelId: 'image' }, baseUrl: 'https://example.test', apiKey: 'secret' }),
      adapters: [{ id: 'openai-images', generate: async () => [] }],
      registerOutput: async () => ({ assetId: 'output', revision: 1, hash: 'a'.repeat(64), mediaKind: 'image' }),
    })
    expect(() => service.prepare('session-1', { ...request, inputs: {
      first: { kind: 'asset', asset: { assetId: 'first', revision: 1, hash: 'a'.repeat(64), mediaKind: 'image' } },
      second: { kind: 'asset', asset: { assetId: 'second', revision: 1, hash: 'b'.repeat(64), mediaKind: 'image' } },
    } })).toThrow('MEDIA_GENERATION_MULTIPLE_REFERENCES_UNSUPPORTED')
  })

  test('Given 即梦图生图执行器 When 准备十张参考 Then 保留全部引用且第十一张在准备前拒绝', () => {
    /** 即梦有独立的多参考能力，不扩大其他 HTTP 执行器的限制。 */
    const imageModel: UnifiedMediaModelOption = { ...model, kind: 'image', capabilities: ['text-to-image', 'image-to-image'], adapterId: 'dreamina-image' }
    const service = new UnifiedMediaGenerationService({
      resolveModel: () => ({ option: imageModel, ref: { kind: 'image', provider: 'dreamina', profileId: 'profile', modelId: '4.0' }, baseUrl: '', apiKey: '' }),
      adapters: [{ id: 'dreamina-image', generate: async () => [] }],
      registerOutput: async () => ({ assetId: 'output', revision: 1, hash: 'a'.repeat(64), mediaKind: 'image' }),
    })
    /** 使用不同资产身份，验证不会只保留第一张。 */
    const inputs = Object.fromEntries(Array.from({ length: 10 }, (_, index) => [`reference-${index}`, { kind: 'asset' as const, asset: { assetId: `image-${index}`, revision: 1, hash: 'a'.repeat(64), mediaKind: 'image' as const } }]))
    const prepared = service.prepare('session', { ...request, inputs })
    expect(Object.keys(service.getAttachmentSource('session', prepared.id).request.inputs)).toHaveLength(10)
    expect(() => service.prepare('session', { ...request, inputs: { ...inputs, extra: inputs['reference-0']! } })).toThrow('MULTIPLE_REFERENCES_UNSUPPORTED')
  })

  test('Given 产物登记期间收到取消 When 供应商结果迟到 Then 取消终态不能被成功结果覆盖', async () => {
    let resolveRegistration: ((asset: { assetId: string; revision: number; hash: string; mediaKind: 'audio' }) => void) | undefined
    let registrationStarted: (() => void) | undefined
    const registrationReady = new Promise<void>((resolve) => { registrationStarted = resolve })
    const service = new UnifiedMediaGenerationService({
      resolveModel: () => ({ option: model, ref: { kind: 'audio', provider: 'minimax', profileId: 'profile', modelId: 'speech-2.8-hd' }, baseUrl: 'https://example.test', apiKey: 'secret' }),
      adapters: [{ id: 'fake', generate: async () => [{ bytes: new Uint8Array([1]), contentType: 'audio/mpeg' }] }],
      registerOutput: async () => {
        registrationStarted?.()
        return await new Promise((resolve) => { resolveRegistration = resolve })
      },
    })
    const prepared = service.prepare('session-1', request)
    await service.execute('session-1', prepared.id, prepared.revision)
    await registrationReady
    expect(service.cancel('session-1', prepared.id).phase).toBe('cancelled')
    resolveRegistration?.({ assetId: 'asset-late', revision: 1, hash: 'a'.repeat(64), mediaKind: 'audio' })
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(service.get('session-1', prepared.id).phase).toBe('cancelled')
  })
})

test('Given 影像运行归属 When 可信宿主绑定 Then 固定身份且拒绝跨会话和改派', () => {
  const service = new UnifiedMediaGenerationService({
    resolveModel: () => ({ option: model, ref: { kind: 'audio', provider: 'minimax', profileId: 'profile', modelId: 'speech' }, baseUrl: 'https://example.test', apiKey: 'secret' }),
    adapters: [{ id: 'fake', generate: async () => [] }],
    registerOutput: async () => ({ assetId: 'asset', revision: 1, hash: 'a'.repeat(64), mediaKind: 'audio' }),
  })
  const prepared = service.prepare('session-1', request)
  const binding = { productionId: 'production', jobId: 'job', baseRevision: 1 }
  service.bindVisualProduction('session-1', prepared.id, binding)
  expect(() => service.bindVisualProduction('session-1', prepared.id, { ...binding })).not.toThrow()
  expect(() => service.bindVisualProduction('session-2', prepared.id, binding)).toThrow('NOT_OWNED')
  expect(() => service.bindVisualProduction('session-1', prepared.id, { ...binding, jobId: 'other' })).toThrow('BINDING_CONFLICT')
  binding.jobId = 'changed-input'
  const source = service.getAttachmentSource('session-1', prepared.id)
  expect(source.visualProduction?.jobId).toBe('job')
  source.visualProduction!.jobId = 'changed-output'
  expect(service.getAttachmentSource('session-1', prepared.id).visualProduction?.jobId).toBe('job')
  expect(JSON.stringify(source)).not.toContain('secret')
})

test('Given 已绑定影像生成 When 跨轮普通调用或错误归属执行 Then 供应商请求前拒绝且正确可信归属可执行', async () => {
  let calls = 0
  const service = new UnifiedMediaGenerationService({
    resolveModel: () => ({ option: model, ref: { kind: 'audio', provider: 'minimax', profileId: 'profile', modelId: 'speech' }, baseUrl: 'https://example.test', apiKey: 'secret' }),
    adapters: [{ id: 'fake', generate: async () => { calls += 1; return [] } }],
    registerOutput: async () => ({ assetId: 'asset', revision: 1, hash: 'a'.repeat(64), mediaKind: 'audio' }),
  })
  const prepared = service.prepare('session-1', request)
  const binding = { productionId: 'production', jobId: 'job', baseRevision: 1 }
  service.bindVisualProduction('session-1', prepared.id, binding)
  await expect(service.execute('session-1', prepared.id, 0)).rejects.toThrow('BINDING_REQUIRED')
  await expect(service.execute('session-1', prepared.id, 0, { ...binding, jobId: 'other' })).rejects.toThrow('BINDING_REQUIRED')
  expect(calls).toBe(0)
  await service.execute('session-1', prepared.id, 0, binding)
  expect(calls).toBe(1)
  const ordinary = service.prepare('session-1', request)
  await service.execute('session-1', ordinary.id, 0)
  expect(calls).toBe(2)
  expect(() => service.bindVisualProduction('session-1', ordinary.id, binding)).toThrow('TOO_LATE')
})
