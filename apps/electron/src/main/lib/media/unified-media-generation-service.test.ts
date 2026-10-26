import { describe, expect, test } from 'bun:test'
import type { MediaGenerationRequest, UnifiedMediaModelOption } from '@dutydeck/shared'
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
    expect(service.hasActiveWork()).toBe(false)
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
    expect(() => service.prepare('session', { ...request, operationId: 'eleventh-reference', inputs: { ...inputs, extra: inputs['reference-0']! } })).toThrow('MULTIPLE_REFERENCES_UNSUPPORTED')
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
    expect(service.hasActiveWork()).toBe(true)
    expect(service.cancel('session-1', prepared.id).phase).toBe('cancelled')
    expect(service.hasActiveWork()).toBe(true)
    resolveRegistration?.({ assetId: 'asset-late', revision: 1, hash: 'a'.repeat(64), mediaKind: 'audio' })
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(service.get('session-1', prepared.id).phase).toBe('cancelled')
    expect(service.hasActiveWork()).toBe(false)
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
  const ordinary = service.prepare('session-1', { ...request, operationId: 'ordinary-operation' })
  await service.execute('session-1', ordinary.id, 0)
  expect(calls).toBe(2)
  expect(() => service.bindVisualProduction('session-1', ordinary.id, binding)).toThrow('TOO_LATE')
})

/** 持久化回归使用临时目录，绝不读取真实宿主配置。 */
const { mkdtempSync, rmSync, readFileSync, readdirSync, mkdirSync } = await import('node:fs')
const { tmpdir } = await import('node:os')
const { join } = await import('node:path')

/** 构造可重建的服务宿主，模拟凭据轮换与进程重启。 */
function durableFixture() {
  const directory = mkdtempSync(join(tmpdir(), 'media-durable-'))
  const route = { option: { ...model }, ref: { kind: 'audio' as const, provider: 'minimax', profileId: 'profile', modelId: 'speech-2.8-hd' }, baseUrl: 'https://private-endpoint.test', apiKey: 'original-secret' }
  const adapter: UnifiedMediaGenerationAdapter = { id: 'fake', generate: async () => [{ bytes: new Uint8Array([1]), contentType: 'audio/mpeg' }] }
  const create = () => new UnifiedMediaGenerationService({ storageDirectory: directory, resolveModel: () => structuredClone(route), adapters: [adapter], registerOutput: async () => ({ assetId: 'asset', revision: 1, hash: 'a'.repeat(64), mediaKind: 'audio' }) })
  return { directory, route, adapter, create, cleanup: () => rmSync(directory, { recursive: true, force: true }) }
}

test('Given prepared 已落盘 When 重建服务并轮换密钥 Then 保留绑定与归属且用当前凭据执行', async () => {
  const fixture = durableFixture()
  try {
    const first = fixture.create()
    const prepared = first.prepare('owner', request)
    const binding = { productionId: 'production', jobId: 'job', baseRevision: 1 }
    first.bindVisualProduction('owner', prepared.id, binding)
    fixture.route.apiKey = 'rotated-secret'
    let credential = ''
    fixture.adapter.generate = async ({ route }) => { credential = route.apiKey; return [{ bytes: new Uint8Array([1]), contentType: 'audio/mpeg' }] }
    const second = fixture.create()
    expect(second.get('owner', prepared.id).phase).toBe('prepared')
    expect(() => second.get('stranger', prepared.id)).toThrow('NOT_OWNED')
    expect(second.getAttachmentSource('owner', prepared.id).visualProduction).toEqual(binding)
    await expect(second.execute('owner', prepared.id, 0)).rejects.toThrow('BINDING_REQUIRED')
    const running = await second.execute('owner', prepared.id, 0, binding)
    const completed = await second.wait('owner', prepared.id, 100, running.revision)
    expect(completed.phase).toBe('succeeded')
    expect(credential).toBe('rotated-secret')
    expect(fixture.create().get('owner', prepared.id)).toEqual(completed)
    const disk = readdirSync(fixture.directory).map(file => readFileSync(join(fixture.directory, file), 'utf8')).join('')
    expect(disk).not.toContain('secret')
    expect(disk).not.toContain('private-endpoint')
    expect(disk).not.toContain('apiKey')
  } finally { fixture.cleanup() }
})

test('Given 同一 operationId When 重启后再次 prepare Then 返回同一运行且不同输入拒绝', () => {
  const fixture = durableFixture()
  try {
    const first = fixture.create().prepare('owner', request)
    expect(fixture.create().prepare('owner', request).id).toBe(first.id)
    expect(() => fixture.create().prepare('owner', { ...request, prompt: '不同的生成' })).toThrow('OPERATION_CONFLICT')
  } finally { fixture.cleanup() }
})

test('Given 无远端身份的运行崩溃 When 重启 Then unknown 且不再发起生成', async () => {
  const fixture = durableFixture()
  try {
    let calls = 0
    fixture.adapter.generate = async () => { calls++; return await new Promise(() => {}) }
    const first = fixture.create()
    const prepared = first.prepare('owner', request)
    await first.execute('owner', prepared.id, 0)
    const second = fixture.create()
    const loaded = second.get('owner', prepared.id)
    expect(loaded.phase).toBe('unknown')
    await expect(second.execute('owner', prepared.id, loaded.revision)).rejects.toThrow('OUTCOME_UNKNOWN')
    expect(calls).toBe(1)
  } finally { fixture.cleanup() }
})

test('Given 已保存供应商任务 When 重启并执行 Then 只传原 taskId 续查且完成可重载', async () => {
  const fixture = durableFixture()
  try {
    fixture.adapter.supportsResume = true
    fixture.adapter.generate = async ({ onRemoteTask }) => { onRemoteTask?.({ taskId: 'remote-1' }); return await new Promise(() => {}) }
    const first = fixture.create()
    const prepared = first.prepare('owner', request)
    await first.execute('owner', prepared.id, 0)
    let resumedId: string | undefined
    fixture.adapter.generate = async ({ remoteTask }) => { resumedId = remoteTask?.taskId; return [{ bytes: new Uint8Array([1]), contentType: 'audio/mpeg' }] }
    const second = fixture.create()
    const loaded = second.get('owner', prepared.id)
    const running = await second.execute('owner', prepared.id, loaded.revision)
    expect((await second.wait('owner', prepared.id, 100, running.revision)).phase).toBe('succeeded')
    expect(resumedId).toBe('remote-1')
  } finally { fixture.cleanup() }
})

test('Given 冻结路由或可用性变化 When 执行 prepared Then 远端请求前拒绝', async () => {
  const fixture = durableFixture()
  try {
    const service = fixture.create()
    const prepared = service.prepare('owner', request)
    fixture.route.baseUrl = 'https://changed.test'
    await expect(service.execute('owner', prepared.id, 0)).rejects.toThrow('MODEL_CHANGED')
    fixture.route.option.available = false
    await expect(service.execute('owner', prepared.id, 0)).rejects.toThrow('MODEL_UNAVAILABLE')
  } finally { fixture.cleanup() }
})

test('Given 提交前持久化失败 When execute Then 请求次数为零', async () => {
  const fixture = durableFixture()
  try {
    let calls = 0
    fixture.adapter.generate = async () => { calls++; return [] }
    const service = fixture.create()
    const prepared = service.prepare('owner', request)
    rmSync(fixture.directory, { recursive: true })
    mkdirSync(fixture.directory)
    mkdirSync(join(fixture.directory, `${prepared.id}.json`))
    await expect(service.execute('owner', prepared.id, 0)).rejects.toThrow()
    expect(calls).toBe(0)
  } finally { fixture.cleanup() }
})

test('Given 查询网络超时且已保存 taskId When wait 恢复 Then 继续查询同一任务而非重新生成', async () => {
  const fixture = durableFixture()
  try {
    fixture.adapter.supportsResume = true
    let attempts = 0
    fixture.adapter.generate = async ({ remoteTask, onRemoteTask }) => {
      attempts++
      if (attempts === 1) { onRemoteTask?.({ taskId: 'known-task' }); throw new Error('socket timeout with sensitive details') }
      expect(remoteTask?.taskId).toBe('known-task')
      return [{ bytes: new Uint8Array([1]), contentType: 'audio/mpeg' }]
    }
    const first = fixture.create()
    const prepared = first.prepare('owner', request)
    await first.execute('owner', prepared.id, 0)
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(first.get('owner', prepared.id).phase).toBe('unknown')
    expect(first.get('owner', prepared.id).error).not.toContain('sensitive')
    const second = fixture.create()
    const loaded = second.get('owner', prepared.id)
    expect(attempts).toBe(1)
    await second.wait('owner', prepared.id, 100, loaded.revision)
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(second.get('owner', prepared.id).phase).toBe('succeeded')
    expect(attempts).toBe(2)
  } finally { fixture.cleanup() }
})

test('Given 两实例已加载 prepared When 首实例提交后第二实例执行 Then 不得重复收费', async () => {
  const fixture = durableFixture()
  try {
    let calls = 0
    fixture.adapter.generate = async () => { calls++; return await new Promise(() => {}) }
    const first = fixture.create()
    const prepared = first.prepare('owner', request)
    const second = fixture.create()
    second.get('owner', prepared.id)
    await first.execute('owner', prepared.id, 0)
    await expect(second.execute('owner', prepared.id, 0)).rejects.toThrow('REVISION_CONFLICT')
    expect(calls).toBe(1)
  } finally { fixture.cleanup() }
})

test('Given 已运行任务被取消 When 供应商迟到 Then 取消可跨重启读取且无产物复活', async () => {
  const fixture = durableFixture()
  try {
    let finish: ((outputs: { bytes: Uint8Array; contentType: string }[]) => void) | undefined
    fixture.adapter.generate = async () => await new Promise(resolve => { finish = resolve })
    const service = fixture.create()
    const prepared = service.prepare('owner', request)
    await service.execute('owner', prepared.id, 0)
    service.cancel('owner', prepared.id)
    finish?.([{ bytes: new Uint8Array([1]), contentType: 'audio/mpeg' }])
    await new Promise(resolve => setTimeout(resolve, 0))
    const recovered = fixture.create().get('owner', prepared.id)
    expect(recovered.phase).toBe('cancelled')
    expect(recovered.outputs).toEqual([])
  } finally { fixture.cleanup() }
})

test('Given 供应商返回 taskId 但保存失败 When onRemoteTask 返回 Then 不能继续查询且内存标记 unknown', async () => {
  const fixture = durableFixture()
  try {
    let continued = false
    fixture.adapter.supportsResume = true
    fixture.adapter.generate = async ({ onRemoteTask }) => {
      /** 模拟收到远端回执时磁盘不可写，验证同步回调没有吞错。 */
      rmSync(fixture.directory, { recursive: true })
      mkdirSync(fixture.directory)
      mkdirSync(join(fixture.directory, `${prepared.id}.json`))
      onRemoteTask?.({ taskId: 'already-submitted' })
      continued = true
      return []
    }
    const service = fixture.create()
    const prepared = service.prepare('owner', request)
    await service.execute('owner', prepared.id, 0)
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(continued).toBe(false)
    expect(service.get('owner', prepared.id).phase).toBe('unknown')
    await expect(service.execute('owner', prepared.id, service.get('owner', prepared.id).revision)).rejects.toThrow('OUTCOME_UNKNOWN')
  } finally { fixture.cleanup() }
})

test('Given 供应商明确返回远端失败 When 重启读取 Then 保留 failed 终态且同操作不可再次生成', async () => {
  const fixture = durableFixture()
  try {
    let calls = 0
    fixture.adapter.generate = async () => { calls++; throw new Error('MEDIA_ADAPTER_REMOTE_FAILED') }
    const first = fixture.create()
    const prepared = first.prepare('owner', request)
    await first.execute('owner', prepared.id, 0)
    await new Promise(resolve => setTimeout(resolve, 0))
    const second = fixture.create()
    const failed = second.get('owner', prepared.id)
    expect(failed.phase).toBe('failed')
    expect((await second.execute('owner', prepared.id, failed.revision)).phase).toBe('failed')
    expect(second.prepare('owner', request).id).toBe(prepared.id)
    expect(calls).toBe(1)
  } finally { fixture.cleanup() }
})

test('Given 影像绑定的远端运行已保存 When 普通 wait 恢复 Then 不得借旧绑定绕过本轮执行授权', async () => {
  const fixture = durableFixture()
  try {
    let calls = 0
    fixture.adapter.supportsResume = true
    fixture.adapter.generate = async ({ onRemoteTask }) => { calls++; onRemoteTask?.({ taskId: 'remote' }); return await new Promise(() => {}) }
    const first = fixture.create()
    const prepared = first.prepare('owner', request)
    const binding = { productionId: 'production', jobId: 'job', baseRevision: 1 }
    first.bindVisualProduction('owner', prepared.id, binding)
    await first.execute('owner', prepared.id, 0, binding)
    const second = fixture.create()
    const loaded = second.get('owner', prepared.id)
    await second.wait('owner', prepared.id, 1, loaded.revision)
    expect(calls).toBe(1)
    await expect(second.execute('owner', prepared.id, second.get('owner', prepared.id).revision)).rejects.toThrow('BINDING_REQUIRED')
  } finally { fixture.cleanup() }
})

/** 三类真实 HTTP 执行器走完整 Facade，fetch 全部离线替身，不触碰真实渠道。 */
for (const scenario of [
  { kind: 'image', provider: 'openai-images', adapterId: 'openai-images', capability: 'text-to-image', contentType: 'image/png' },
  { kind: 'audio', provider: 'minimax', adapterId: 'minimax-speech', capability: 'text-to-speech', contentType: 'audio/mpeg' },
  { kind: 'video', provider: 'minimax', adapterId: 'minimax-video', capability: 'text-to-video', contentType: 'video/mp4' },
] as const) {
  test(`Given ${scenario.kind} 已配置真实HTTP适配器 When 离线准备执行等待 Then 字节登记与终态恢复闭环`, async () => {
    const { createUnifiedMediaHttpAdapters } = await import('./unified-media-http-adapters')
    const directory = mkdtempSync(join(tmpdir(), 'media-http-integration-'))
    try {
      const ref = { kind: scenario.kind, provider: scenario.provider, profileId: 'profile', modelId: 'model' }
      const modelRef = `media:${scenario.kind}:${scenario.provider}:profile:model`
      const option: UnifiedMediaModelOption = { ...ref, ref: modelRef, name: '离线模型', capabilities: [scenario.capability], available: true, adapterId: scenario.adapterId }
      let postCount = 0
      let registered = false
      const adapters = createUnifiedMediaHttpAdapters({ pollIntervalMs: 0, timeoutMs: 100, fetch: async (input, init) => {
        if (init?.method === 'POST') postCount++
        const url = String(input)
        if (scenario.kind === 'image') return Response.json({ data: [{ b64_json: Buffer.from('fixture').toString('base64') }] })
        if (scenario.kind === 'audio') return Response.json({ data: { audio: Buffer.from('fixture').toString('base64') } })
        if (url.includes('/query/')) return Response.json({ status: 'Success', video_url: 'https://fixture.test/result.mp4' })
        if (url.endsWith('/video_generation')) return Response.json({ task_id: 'video-task' })
        return new Response('fixture', { headers: { 'content-type': scenario.contentType } })
      } })
      const options = {
        storageDirectory: directory, adapters,
        resolveModel: () => ({ option, ref, baseUrl: 'https://fixture.test/v1', apiKey: 'offline-secret' }),
        registerOutput: async (projectId: string, operationId: string, bytes: Uint8Array, contentType: string, origin: { mediaRunId: string; sourceSessionId: string }) => {
          expect(projectId).toBe('project-1')
          expect(operationId).toBe(`${origin.mediaRunId}:output-1`)
          expect(origin.sourceSessionId).toBe('owner')
          expect(new TextDecoder().decode(bytes)).toBe('fixture')
          expect(contentType).toBe(scenario.contentType)
          registered = true
          return { assetId: `${scenario.kind}-asset`, revision: 1, hash: 'a'.repeat(64), mediaKind: scenario.kind }
        },
      }
      const service = new UnifiedMediaGenerationService(options)
      const prepared = service.prepare('owner', { ...request, modelRef })
      expect(postCount).toBe(0)
      const running = await service.execute('owner', prepared.id, 0)
      const completed = await service.wait('owner', prepared.id, 100, running.revision)
      expect(completed.phase).toBe('succeeded')
      expect(registered).toBe(true)
      expect(postCount).toBe(1)
      const restored = new UnifiedMediaGenerationService(options)
      expect(restored.get('owner', prepared.id).outputs[0]?.asset.mediaKind).toBe(scenario.kind)
      await restored.execute('owner', prepared.id, completed.revision)
      expect(postCount).toBe(1)
    } finally { rmSync(directory, { recursive: true, force: true }) }
  })
}
