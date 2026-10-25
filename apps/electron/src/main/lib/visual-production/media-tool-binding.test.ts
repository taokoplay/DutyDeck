import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Type } from 'typebox'
import type { ToolDefinition } from '@earendil-works/pi-coding-agent'
import type { VisualProductionMediaExecution, VisualProductionMediaOption, VisualProductionInputs, VisualProductionMethod, VisualProductionResults } from '@dutydeck/shared'
import { VisualProductionService } from './store'
import { createVisualProductionRun } from './agent-run'
import { bindVisualProductionMediaTools } from './media-tool-binding'

/** 隔离每例持久化目录，不接触用户作品。 */
const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })
/** 配置目录和可信运行均用可审计 fixture，不调用供应商。 */
async function fixture(mediaKind: 'image' | 'video' = 'image') {
  const root = mkdtempSync(join(tmpdir(), 'visual-media-binding-')); roots.push(root)
  const modelRef = mediaKind === 'video' ? 'media:video:minimax-video:profile:video-model' : 'media:image:openai-images:profile:model'
  const option: VisualProductionMediaOption = { id: 'model-one', name: mediaKind === 'video' ? '测试视频模型' : '测试图片模型', kind: mediaKind, source: { type: 'model', modelRef }, parameters: {}, available: true, constraints: { maxImageReferences: mediaKind === 'video' ? 2 : 1, parameters: mediaKind === 'video' ? [] : [{ key: 'size', label: '尺寸', type: 'string', defaultValue: '1024x1024' }] } }
  const receipts = new Map<string, VisualProductionMediaExecution>()
  const service = new VisualProductionService({ workspaceId: 'project', projectRoot: root, listMediaOptions: async () => [option], readMediaExecution: async (_session, id) => { const value = receipts.get(id); if (!value) throw new Error('missing'); return value } })
  const access = { workspaceId: 'project', assertCurrent() {}, execute: <M extends VisualProductionMethod>(method: M, input: VisualProductionInputs[M]): Promise<VisualProductionResults[M]> => service.invoke(method, input) }
  const run = createVisualProductionRun('session', access, access)
  const created = await access.execute('create', { sessionId: 'session', title: '测试', kind: 'film' })
  const target = { sessionId: 'session', productionId: created.document.id }
  const calls: Record<string, unknown>[] = []
  const tools: ToolDefinition[] = ['media_prepare_generation', 'media_execute_generation', 'media_get_generation'].map(name => ({ name, label: name, description: name, parameters: Type.Object({}), execute: async (_call, params) => {
    calls.push(params as Record<string, unknown>)
    const id = name === 'media_prepare_generation' ? `run-${calls.length}` : String((params as Record<string, unknown>).runId)
    if (name === 'media_prepare_generation') {
      /** 回执参数只包含标量；图片输入属于参考素材，不能伪造为可编辑参数。 */
      const inputs = (params as { inputs: Record<string, { kind: 'scalar'; value: string | number | boolean } | { kind: 'asset' }> }).inputs
      receipts.set(id, {
        runId: id, engine: 'model', name: option.name, kind: mediaKind, source: { type: 'model', modelRef },
        parameters: Object.fromEntries(Object.entries(inputs).flatMap(([key, value]) => value.kind === 'scalar' ? [[key, value.value]] : [])),
        referenceAssets: [], phase: 'prepared', createdAt: Date.now(),
      })
    }
    const phase = name === 'media_execute_generation' ? 'running' : 'prepared'
    return { content: [{ type: 'text' as const, text: '{}' }], details: {
      id,
      phase,
      ...(name === 'media_execute_generation' ? { availableActions: ['media_wait_generation', 'media_cancel_generation'] } : {}),
    } }
  } }))
  const wrapped = bindVisualProductionMediaTools(tools, { sessionId: 'session', access, jobs: () => run.mediaJobs() })
  async function call(name: string, params: Record<string, unknown>) { return wrapped.find(tool => tool.name === name)!.execute('call', params, undefined, undefined, {} as never) }
  async function begin() { return run.execute('beginJob', { ...target, baseRevision: 1, instruction: '生成镜头' }) }
  return { option, modelRef, root, created, target, access, run, calls, call, begin }
}

describe('影像任务绑定真实媒体工具', () => {
  test('Given 模型启动媒体任务 When 返回下一动作 Then 由 Host 托管等待且不诱导重复轮询', async () => {
    const f = await fixture()
    await f.begin()
    const prepared = await f.call('media_prepare_generation', { modelRef: f.modelRef, prompt: '场景', inputs: {} })
    const runId = (prepared.details as { id: string }).id
    const executed = await f.call('media_execute_generation', { runId, expectedRevision: 0 })

    expect(executed.details).toMatchObject({ phase: 'running', availableActions: ['media_cancel_generation'], hostManagedWait: expect.stringContaining('Host 会等待') })
    expect((executed.content[0] as { text: string }).text).not.toContain('media_wait_generation')
  })

  test('Given 作品配置 When 准备 Then 合并默认参数并保存可信回执', async () => {
    const f = await fixture()
    await f.access.execute('saveMediaConfiguration', { ...f.target, expectedRevision: 0, entries: [{ ...f.option, parameters: { size: '1536x1024' } }].map(({ available: _a, constraints: _c, ...entry }) => entry), defaults: { image: f.option.id } })
    await f.begin()
    await f.call('media_prepare_generation', { modelRef: f.option.source.type === 'model' ? f.option.source.modelRef : '', prompt: '真实场景', inputs: {} })
    expect(f.calls[0]?.inputs).toEqual({ size: { kind: 'scalar', value: '1536x1024' } })
    expect((await f.access.execute('load', f.target)).jobs[0]?.mediaExecutions?.[0]?.parameters.size).toBe('1536x1024')
  })
  test('Given 显式空范围 When 准备 Then 无供应商准备调用', async () => {
    const f = await fixture()
    await f.access.execute('saveMediaConfiguration', { ...f.target, expectedRevision: 0, entries: [], defaults: {} }); await f.begin()
    await expect(f.call('media_prepare_generation', { modelRef: 'outside', prompt: '场景', inputs: {} })).rejects.toThrow()
    expect(f.calls).toHaveLength(0)
  })
  test('Given 两个运行任务 When 未指定任务 Then 拒绝歧义', async () => {
    const f = await fixture(); await f.begin(); await f.begin()
    await expect(f.call('media_prepare_generation', { modelRef: 'outside', prompt: '场景', inputs: {} })).rejects.toThrow('visualJobId')
    expect(f.calls).toHaveLength(0)
  })
  test('Given 已绑定准备任务 When 影像任务取消 Then 不执行媒体', async () => {
    const f = await fixture(); const job = await f.begin()
    const prepared = await f.call('media_prepare_generation', { modelRef: 'media:image:openai-images:profile:model', prompt: '场景', inputs: {} })
    await f.access.execute('cancelJob', { ...f.target, jobId: job.id })
    await expect(f.call('media_execute_generation', { runId: (prepared.details as { id: string }).id, expectedRevision: 0 })).rejects.toThrow()
    expect(f.calls).toHaveLength(1)
  })
  test('Given 活动影像任务 When 执行未绑定媒体 Then 拒绝绕过', async () => {
    const f = await fixture(); await f.begin()
    await expect(f.call('media_execute_generation', { runId: 'unbound', expectedRevision: 0 })).rejects.toThrow()
    expect(f.calls).toHaveLength(0)
  })
  test('Given 无影像任务 When 在影像模块准备媒体 Then 拒绝生成孤儿任务', async () => {
    const f = await fixture()
    await expect(f.call('media_prepare_generation', { modelRef: 'media:image:openai-images:profile:model', prompt: '场景', inputs: {} }))
      .rejects.toThrow('VISUAL_MEDIA_JOB_REQUIRED')
    await expect(f.call('media_prepare_generation', { modelRef: 'media:image:openai-images:profile:model', prompt: '场景', inputs: {} }))
      .rejects.toThrow('不要只报告此错误')
    expect(f.calls).toHaveLength(0)
  })
  test('Given Agent 设计为文生视频 When 准备仍带首帧 Then 生成前拒绝并保留零调用', async () => {
    const f = await fixture('video')
    /** 新作品为空，写入唯一镜头和明确文生视频计划；旧镜头不设置计划时不受此校验影响。 */
    const shot = {
      id: 'planned-shot',
      episodeId: f.created.document.episodes[0]!.id,
      title: '规划镜头',
      duration: 4,
      scene: '',
      motion: '',
      dialogue: '',
      assetIds: [],
      mediaId: null,
      continuityPlan: {
        entryState: '角色站在画面中央。',
        exitState: '角色保持站位。',
        anchors: [],
        audioTransition: 'hard-cut' as const,
        rationale: '本镜不需要跨切点声音承接。',
      },
      videoPlan: {
        mode: 'text-to-video' as const,
        firstFrameAssetId: null,
        lastFrameAssetId: null,
        transitionIn: 'hard-cut' as const,
        rationale: 'Agent 判定本镜不继承前一镜画面。',
      },
    }
    await f.access.execute('save', {
      ...f.target,
      baseRevision: 1,
      draft: {
        title: f.created.document.title,
        kind: f.created.document.kind,
        brief: f.created.document.brief,
        ratio: f.created.document.ratio,
        fps: f.created.document.fps,
        voice: f.created.document.voice,
        music: f.created.document.music,
        episodes: f.created.document.episodes,
        assets: f.created.document.assets,
        shots: [shot],
      },
    })
    await f.run.execute('beginJob', { ...f.target, baseRevision: 2, instruction: '按设计生成视频', shotId: shot.id })
    await expect(f.call('media_prepare_generation', {
      modelRef: f.modelRef,
      prompt: '场景',
      inputs: { reference: { kind: 'asset', asset: { assetId: 'image-output', revision: 1, hash: 'a'.repeat(64), mediaKind: 'image' } } },
    })).rejects.toThrow('VIDEO_PLAN_INPUT_MISMATCH')
    expect(f.calls).toHaveLength(0)
  })
  test('Given 只有视频生成方式但缺少衔接合同 When 准备视频 Then 在调用供应商前拒绝', async () => {
    const f = await fixture('video')
    const shot = {
      id: 'continuity-required-shot',
      episodeId: f.created.document.episodes[0]!.id,
      title: '缺少衔接',
      duration: 4,
      scene: '人物抬头。',
      motion: '从低头到抬头。',
      dialogue: '',
      assetIds: [],
      mediaId: null,
      videoPlan: {
        mode: 'text-to-video' as const,
        firstFrameAssetId: null,
        lastFrameAssetId: null,
        transitionIn: 'hard-cut' as const,
        rationale: '文字直接生成。',
      },
    }
    await f.access.execute('save', {
      ...f.target,
      baseRevision: 1,
      draft: {
        title: f.created.document.title,
        kind: f.created.document.kind,
        brief: f.created.document.brief,
        ratio: f.created.document.ratio,
        fps: f.created.document.fps,
        voice: f.created.document.voice,
        music: f.created.document.music,
        episodes: f.created.document.episodes,
        assets: f.created.document.assets,
        shots: [shot],
      },
    })
    await f.run.execute('beginJob', { ...f.target, baseRevision: 2, instruction: '按设计生成视频', shotId: shot.id })
    await expect(f.call('media_prepare_generation', { modelRef: f.modelRef, prompt: '人物抬头', inputs: {} })).rejects.toThrow('CONTINUITY_PLAN_REQUIRED')
    expect(f.calls).toHaveLength(0)
  })
  test('Given 动作锚点已引用但尚无图片媒体 When 准备视频 Then 拒绝静默忽略锚点', async () => {
    const f = await fixture('video')
    const shot = {
      id: 'anchor-media-required-shot',
      episodeId: f.created.document.episodes[0]!.id,
      title: '锚点缺媒体',
      duration: 4,
      scene: '人物完成起身。',
      motion: '扶住桌沿后站直。',
      dialogue: '',
      assetIds: ['anchor-asset'],
      mediaId: null,
      continuityPlan: {
        entryState: '人物坐着。',
        exitState: '人物站直。',
        anchors: [{ phase: 'contact' as const, state: '手掌承重。', assetId: 'anchor-asset' }],
        audioTransition: 'hard-cut' as const,
        rationale: '中间接触状态必须可读。',
      },
      videoPlan: {
        mode: 'text-to-video' as const,
        firstFrameAssetId: null,
        lastFrameAssetId: null,
        transitionIn: 'hard-cut' as const,
        rationale: '文字生成动作。',
      },
    }
    await f.access.execute('save', {
      ...f.target,
      baseRevision: 1,
      draft: {
        title: f.created.document.title,
        kind: f.created.document.kind,
        brief: f.created.document.brief,
        ratio: f.created.document.ratio,
        fps: f.created.document.fps,
        voice: f.created.document.voice,
        music: f.created.document.music,
        episodes: f.created.document.episodes,
        assets: [{ id: 'anchor-asset', name: '接触锚点', type: '场景', description: '', locked: false, mediaId: null }],
        shots: [shot],
      },
    })
    await f.run.execute('beginJob', { ...f.target, baseRevision: 2, instruction: '按设计生成视频', shotId: shot.id })
    await expect(f.call('media_prepare_generation', { modelRef: f.modelRef, prompt: '人物起身', inputs: {} })).rejects.toThrow('CONTINUITY_PLAN_ANCHOR_MEDIA_MISSING')
    expect(f.calls).toHaveLength(0)
  })
  test('Given 单镜头视频尚未记录生成设计 When 准备 Then 要求先完成镜头设计', async () => {
    const f = await fixture('video')
    /** 只保存镜头资料，不伪造生成方式；准备阶段必须阻断并提示先设计。 */
    const shot = { id: 'unplanned-shot', episodeId: f.created.document.episodes[0]!.id, title: '未设计镜头', duration: 4, scene: '', motion: '', dialogue: '', assetIds: [], mediaId: null }
    await f.access.execute('save', {
      ...f.target,
      baseRevision: 1,
      draft: { title: f.created.document.title, kind: f.created.document.kind, brief: '', ratio: f.created.document.ratio, fps: f.created.document.fps, voice: '', music: '', episodes: f.created.document.episodes, assets: [], shots: [shot] },
    })
    await f.run.execute('beginJob', { ...f.target, baseRevision: 2, instruction: '生成未设计视频', shotId: shot.id })
    await expect(f.call('media_prepare_generation', { modelRef: f.modelRef, prompt: '场景', inputs: {} })).rejects.toThrow('VIDEO_PLAN_REQUIRED')
    await expect(f.call('media_prepare_generation', { modelRef: f.modelRef, prompt: '场景', inputs: {} })).rejects.toThrow('visual_production_update_shot_plan')
    expect(f.calls).toHaveLength(0)
  })
  test('Given Agent 原子写入首尾帧计划 When 准备视频 Then 新正式版本直接通过计划门禁', async () => {
    const f = await fixture('video')
    /** 先导入真实受管图片，再由单镜头计划工具登记尾帧并绑定目标镜头。 */
    writeFileSync(join(f.root, 'first.png'), Buffer.from('89504e470d0a1a0a00000000', 'hex'))
    writeFileSync(join(f.root, 'last.png'), Buffer.from('89504e470d0a1a0a00000001', 'hex'))
    const first = await f.access.execute('importFile', { ...f.target, relativePath: 'first.png' })
    const last = await f.access.execute('importFile', { ...f.target, relativePath: 'last.png' })
    const shot = { id: 'planned-video', episodeId: f.created.document.episodes[0]!.id, title: '首尾帧', duration: 6, scene: '白光吞没。', motion: '手掌贴合镜面。', dialogue: '', assetIds: [], mediaId: first.id }
    await f.access.execute('save', { ...f.target, baseRevision: 1, draft: { title: f.created.document.title, kind: f.created.document.kind, brief: '', ratio: f.created.document.ratio, fps: f.created.document.fps, voice: '', music: '', episodes: f.created.document.episodes, assets: [], shots: [shot] } })
    const planned = await f.access.execute('updateShotPlan', {
      ...f.target,
      baseRevision: 2,
      shotId: shot.id,
      videoPlan: { mode: 'first-last-frame', firstFrameAssetId: null, lastFrameAssetId: 'tail', transitionIn: 'hard-cut', rationale: '尾帧约束全白切点。' },
      continuityPlan: { entryState: '手掌贴合镜面。', exitState: '画面全白。', anchors: [], audioTransition: 'carry-over', rationale: '白光延续到下一镜。' },
      references: [{ assetId: 'tail', mediaId: last.id, name: '全白尾帧', type: '场景', description: '最终过曝状态。' }],
    })
    await f.run.execute('beginJob', { ...f.target, baseRevision: planned.document.revision, instruction: '按首尾帧生成', shotId: shot.id, mediaKind: 'video' })
    const reference = (media: typeof first) => ({ kind: 'asset' as const, asset: { assetId: media.id, revision: 1, hash: media.hash, mediaKind: 'image' as const } })
    await f.call('media_prepare_generation', { modelRef: f.modelRef, prompt: '白光吞没人物', inputs: { first: reference(first), last: reference(last) } })
    expect(f.calls).toHaveLength(1)
  })
  test('Given Agent 误传裸媒体引用 When 准备首尾帧视频 Then 宿主兼容包装并继续执行', async () => {
    const f = await fixture('video')
    /** 复现真实会话中的输入：图片值是裸 MediaAssetRef，而不是标准 MediaInputValue。 */
    writeFileSync(join(f.root, 'first.png'), Buffer.from('89504e470d0a1a0a00000000', 'hex'))
    writeFileSync(join(f.root, 'last.png'), Buffer.from('89504e470d0a1a0a00000001', 'hex'))
    const first = await f.access.execute('importFile', { ...f.target, relativePath: 'first.png' })
    const last = await f.access.execute('importFile', { ...f.target, relativePath: 'last.png' })
    const shot = { id: 'raw-reference-video', episodeId: f.created.document.episodes[0]!.id, title: '裸引用', duration: 6, scene: '白光吞没。', motion: '手掌贴合镜面。', dialogue: '', assetIds: [], mediaId: first.id }
    await f.access.execute('save', { ...f.target, baseRevision: 1, draft: { title: f.created.document.title, kind: f.created.document.kind, brief: '', ratio: f.created.document.ratio, fps: f.created.document.fps, voice: '', music: '', episodes: f.created.document.episodes, assets: [], shots: [shot] } })
    const planned = await f.access.execute('updateShotPlan', {
      ...f.target,
      baseRevision: 2,
      shotId: shot.id,
      videoPlan: { mode: 'first-last-frame', firstFrameAssetId: null, lastFrameAssetId: 'tail', transitionIn: 'hard-cut', rationale: '尾帧约束全白切点。' },
      continuityPlan: { entryState: '手掌贴合镜面。', exitState: '画面全白。', anchors: [], audioTransition: 'carry-over', rationale: '白光延续到下一镜。' },
      references: [{ assetId: 'tail', mediaId: last.id, name: '全白尾帧', type: '场景', description: '最终过曝状态。' }],
    })
    await f.run.execute('beginJob', { ...f.target, baseRevision: planned.document.revision, instruction: '按首尾帧生成', shotId: shot.id, mediaKind: 'video' })
    const rawReference = (media: typeof first) => ({ assetId: media.id, revision: 1, hash: media.hash, mediaKind: 'image' })
    await f.call('media_prepare_generation', { modelRef: f.modelRef, prompt: '白光吞没人物', inputs: { first: rawReference(first), last: rawReference(last) } })
    expect(f.calls).toHaveLength(1)
  })
})

test('Given 真实统一媒体服务与影像包装器 When 跨轮执行同一运行 Then 可信上下文不可从参数伪造', async () => {
  /** 使用真实服务与 AsyncLocalStorage，只有供应商字节由隔离适配器返回。 */
  const { UnifiedMediaGenerationService } = await import('../media/unified-media-generation-service')
  const { visualMediaExecutionContext } = await import('./media-execution-context')
  const root = mkdtempSync(join(tmpdir(), 'visual-media-real-')); roots.push(root)
  const modelRef = 'media:image:openai-images:profile:model'
  const option: VisualProductionMediaOption = { id: 'model', name: '测试模型', kind: 'image', source: { type: 'model', modelRef }, parameters: {}, available: true, constraints: { parameters: [{ key: 'size', label: '尺寸', type: 'string' }] } }
  let providerCalls = 0
  const generation = new UnifiedMediaGenerationService({
    resolveModel: () => ({ option: { ref: modelRef, name: '测试模型', kind: 'image', provider: 'openai-images', profileId: 'profile', modelId: 'model', capabilities: ['text-to-image'], available: true, adapterId: 'fake' }, ref: { kind: 'image', provider: 'openai-images', profileId: 'profile', modelId: 'model' }, baseUrl: 'https://example.test', apiKey: 'secret' }),
    adapters: [{ id: 'fake', generate: async () => { providerCalls += 1; return [{ bytes: new Uint8Array([1]), contentType: 'image/png' }] } }],
    registerOutput: async () => ({ assetId: 'output', revision: 1, hash: 'a'.repeat(64), mediaKind: 'image' }),
  })
  const service = new VisualProductionService({ workspaceId: 'project', projectRoot: root, listMediaOptions: async () => [option], readMediaExecution: async (sessionId, runId, engine) => {
    const source = generation.getAttachmentSource(sessionId, runId)
    return { runId, engine, name: option.name, kind: source.snapshot.mediaKind, source: { type: 'model', modelRef: 'media:image:openai-images:profile:model' }, parameters: Object.fromEntries(Object.entries(source.request.inputs).flatMap(([key, value]) => value.kind === 'scalar' ? [[key, value.value]] : [])), referenceAssets: [], phase: source.snapshot.phase, createdAt: source.snapshot.createdAt, prompt: source.request.prompt }
  } })
  const access = { workspaceId: 'project', assertCurrent() {}, execute: <M extends VisualProductionMethod>(method: M, input: VisualProductionInputs[M]): Promise<VisualProductionResults[M]> => service.invoke(method, input) }
  const run = createVisualProductionRun('session', access, access)
  const created = await service.invoke('create', { sessionId: 'session', title: '集成测试', kind: 'film' })
  const target = { sessionId: 'session', productionId: created.document.id }
  await service.invoke('saveMediaConfiguration', { ...target, expectedRevision: 0, entries: [{ id: option.id, name: option.name, kind: option.kind, source: option.source, parameters: { size: '1024x1024' } }], defaults: { image: option.id } })
  const job = await run.execute('beginJob', { ...target, baseRevision: 1, instruction: '生成' })
  /** 与 IPC 一致：可信上下文由包装器签发，调用参数不能提供绑定。 */
  function toolsFor(sessionId: string): ToolDefinition[] {
    return ['media_prepare_generation', 'media_execute_generation', 'media_get_generation'].map(name => ({ name, label: name, description: name, parameters: Type.Object({}), execute: async (_call, raw) => {
      const params = raw as { modelRef: string; prompt: string; inputs: import('@dutydeck/shared').MediaGenerationRequest['inputs']; runId: string; expectedRevision: number }
      const context = visualMediaExecutionContext.getStore()
      let snapshot: import('@dutydeck/shared').MediaGenerationSnapshot
      if (name === 'media_prepare_generation') {
        snapshot = generation.prepare(sessionId, { projectId: 'project', operationId: 'operation', modelRef: params.modelRef, prompt: params.prompt, inputs: params.inputs })
        if (context?.sessionId === sessionId) generation.bindVisualProduction(sessionId, snapshot.id, context)
      } else if (name === 'media_execute_generation') snapshot = await generation.execute(sessionId, params.runId, params.expectedRevision, context?.sessionId === sessionId ? context : undefined)
      else snapshot = generation.get(sessionId, params.runId)
      return { content: [{ type: 'text' as const, text: '{}' }], details: snapshot }
    } }))
  }
  const wrapped = bindVisualProductionMediaTools(toolsFor('session'), { sessionId: 'session', access, jobs: () => run.mediaJobs() })
  async function call(tools: ToolDefinition[], name: string, params: Record<string, unknown>) { return tools.find(tool => tool.name === name)!.execute('call', params, undefined, undefined, {} as never) }
  const prepared = await call(wrapped, 'media_prepare_generation', { modelRef, prompt: '实际场景', inputs: {} })
  const runId = (prepared.details as { id: string }).id
  expect(generation.getAttachmentSource('session', runId).visualProduction).toEqual({ productionId: target.productionId, jobId: job.id, baseRevision: 1 })
  await call(wrapped, 'media_execute_generation', { runId, expectedRevision: 0 })
  await generation.wait('session', runId, 1000, 1)
  await call(wrapped, 'media_get_generation', { runId })
  const receipt = (await service.invoke('load', target)).jobs[0]?.mediaExecutions?.[0]
  expect(receipt?.phase).toBe('succeeded')
  expect(receipt?.parameters.size).toBe('1024x1024')
  expect(providerCalls).toBe(1)
  expect(visualMediaExecutionContext.getStore()).toBeUndefined()
  /** 下一回合无内存绑定，伪造同名参数也不能补出主进程上下文。 */
  const nextTurn = bindVisualProductionMediaTools(toolsFor('session'), { sessionId: 'session', access, jobs: () => [] })
  await expect(call(nextTurn, 'media_execute_generation', { runId, expectedRevision: generation.get('session', runId).revision, visualBinding: { productionId: target.productionId, jobId: job.id, baseRevision: 1 } })).rejects.toThrow('BINDING_REQUIRED')
  const otherSession = bindVisualProductionMediaTools(toolsFor('other'), { sessionId: 'other', access, jobs: () => [] })
  await expect(call(otherSession, 'media_execute_generation', { runId, expectedRevision: 0 })).rejects.toThrow('NOT_OWNED')
  expect(providerCalls).toBe(1)
})

test('Given 两个 ComfyUI 制作任务 When 显式指定 visualJobId Then 各自使用冻结参数并记录到对应任务', async () => {
  const root = mkdtempSync(join(tmpdir(), 'visual-comfy-binding-')); roots.push(root)
  const option: VisualProductionMediaOption = { id: 'workflow', name: 'Comfy工作流', kind: 'image', source: { type: 'workflow', connectionId: 'comfy.local', workflowId: 'workflow.v2', workflowRevision: 2 }, parameters: {}, available: true, constraints: { parameters: [{ key: 'node.seed', label: '种子', type: 'number' }] } }
  const receipts = new Map<string, VisualProductionMediaExecution>()
  const service = new VisualProductionService({ workspaceId: 'project', projectRoot: root, listMediaOptions: async () => [option], resolveMediaWorkflow: async () => option, readMediaExecution: async (_session, runId) => { const receipt = receipts.get(runId); if (!receipt) throw new Error('missing'); return receipt } })
  const access = { workspaceId: 'project', assertCurrent() {}, execute: <M extends VisualProductionMethod>(method: M, input: VisualProductionInputs[M]): Promise<VisualProductionResults[M]> => service.invoke(method, input) }
  const run = createVisualProductionRun('session', access, access)
  const created = await service.invoke('create', { sessionId: 'session', title: 'Comfy测试', kind: 'film' })
  const target = { sessionId: 'session', productionId: created.document.id }
  async function save(seed: number, expectedRevision: number) { await service.invoke('saveMediaConfiguration', { ...target, expectedRevision, entries: [{ id: option.id, name: option.name, kind: option.kind, source: { type: 'workflow', connectionId: 'comfy.local', workflowId: 'workflow.v2', workflowRevision: 2 }, parameters: { 'node.seed': seed } }], defaults: { image: option.id } }) }
  await save(1, 0)
  const first = await run.execute('beginJob', { ...target, baseRevision: 1, instruction: '第一任务' })
  await save(2, 1)
  const second = await run.execute('beginJob', { ...target, baseRevision: 1, instruction: '第二任务' })
  const tools: ToolDefinition[] = [{ name: 'media_prepare_run', label: '工作流', description: '准备工作流', parameters: Type.Object({}), execute: async (callId, raw) => {
    const params = raw as { inputs: Record<string, { kind: 'scalar'; value: number }> }
    receipts.set(callId, { runId: callId, engine: 'workflow', name: option.name, kind: option.kind, source: { type: 'workflow', connectionId: 'comfy.local', workflowId: 'workflow.v2', workflowRevision: 2 }, parameters: { 'node.seed': params.inputs['node.seed']!.value }, referenceAssets: [], phase: 'prepared', createdAt: 1 })
    return { content: [{ type: 'text' as const, text: '{}' }], details: { id: callId } }
  } }]
  const wrapped = bindVisualProductionMediaTools(tools, { sessionId: 'session', access, jobs: () => run.mediaJobs() })
  /** 故意逆序准备，验证归属来自显式身份而非最近任务。 */
  for (const [runId, job] of [['run-second', second], ['run-first', first]] as const) await wrapped[0]!.execute(runId, { connectionId: 'comfy.local', workflowId: 'workflow.v2', workflowRevision: 2, mediaKind: 'image', inputs: {}, visualJobId: job.id }, undefined, undefined, {} as never)
  const saved = await service.invoke('load', target)
  expect(saved.jobs.find(job => job.id === first.id)?.mediaExecutions?.[0]?.parameters['node.seed']).toBe(1)
  expect(saved.jobs.find(job => job.id ===second.id)?.mediaExecutions?.[0]?.parameters['node.seed']).toBe(2)
})

/** 目录仅公布服务，选中的精确工作流由宿主单独解析；不访问真实服务器。 */
async function connectionFixture() {
  /** 每个用例有独立作品、目录与可信执行记录。 */
  const root = mkdtempSync(join(tmpdir(), 'visual-comfy-choice-')); roots.push(root)
  const connection: VisualProductionMediaOption = { id: 'comfy-image', name: '制作服务', kind: 'image', source: { type: 'connection', connectionId: 'comfy.local' }, parameters: {}, available: true, constraints: {} }
  const workflow: VisualProductionMediaOption = { id: 'chosen-workflow', name: '制作服务 · Agent 选择的工作流', kind: 'image', source: { type: 'workflow', connectionId: 'comfy.local', workflowId: 'remote.snapshot', workflowRevision: 2 }, parameters: {}, available: true, constraints: { maxImageReferences: 1, parameters: [{ key: 'seed', label: '种子', type: 'number', defaultValue: 7 }] } }
  const receipts = new Map<string, VisualProductionMediaExecution>()
  const calls: string[] = []
  const resolved: string[] = []
  const service = new VisualProductionService({ workspaceId: 'project', projectRoot: root, listMediaOptions: async () => [connection], resolveMediaWorkflow: async (source, kind) => {
    resolved.push(source.connectionId)
    if (source.workflowId !== 'remote.snapshot' || source.workflowRevision !== 2 || kind !== 'image') throw new Error('WORKFLOW_NOT_MATCHED')
    return workflow
  }, readMediaExecution: async (_session, runId) => { const receipt = receipts.get(runId); if (!receipt) throw new Error('missing'); return receipt } })
  const access = { workspaceId: 'project', assertCurrent() {}, execute: <M extends VisualProductionMethod>(method: M, input: VisualProductionInputs[M]): Promise<VisualProductionResults[M]> => service.invoke(method, input) }
  const run = createVisualProductionRun('session', access, access)
  const created = await service.invoke('create', { sessionId: 'session', title: '自动选择测试', kind: 'film' })
  const target = { sessionId: 'session', productionId: created.document.id }
  await service.invoke('saveMediaConfiguration', { ...target, expectedRevision: 0, entries: [{ id: connection.id, name: connection.name, kind: connection.kind, source: connection.source, parameters: {} }], defaults: { image: connection.id } })
  await run.execute('beginJob', { ...target, baseRevision: 1, instruction: '按角色参考图生成新场景' })
  const tools: ToolDefinition[] = ['media_prepare_run', 'media_execute_run'].map(name => ({ name, label: name, description: name, parameters: Type.Object({}), execute: async (_callId, raw) => {
    calls.push(name)
    if (name === 'media_prepare_run') {
      const inputs = (raw as { inputs: Record<string, { kind: 'scalar'; value: number }> }).inputs
      receipts.set('chosen-run', { runId: 'chosen-run', engine: 'workflow', name: workflow.name, kind: 'image', source: { type: 'workflow', connectionId: 'comfy.local', workflowId: 'remote.snapshot', workflowRevision: 2 }, parameters: { seed: inputs.seed!.value }, referenceAssets: [], phase: 'prepared', createdAt: 1 })
    }
    return { content: [{ type: 'text' as const, text: '{}' }], details: { id: 'chosen-run' } }
  } }))
  const wrapped = bindVisualProductionMediaTools(tools, { sessionId: 'session', access, jobs: () => run.mediaJobs() })
  /** 调用实际包装器；测试输入不能直接写入可信回执。 */
  async function call(name: string, params: Record<string, unknown>) { return wrapped.find(tool => tool.name === name)!.execute('call', params, undefined, undefined, {} as never) }
  return { call, calls, resolved, workflow, service, target }
}

describe('ComfyUI 服务范围内由 Agent 选择工作流', () => {
  /** 模拟 Agent 从服务器发现并缓存后返回的精确来源。 */
  const selected = { connectionId: 'comfy.local', workflowId: 'remote.snapshot', workflowRevision: 2, mediaKind: 'image', inputs: {} }
  test('Given 作品仅选择服务 When Agent 选中未在目录枚举的工作流 Then 使用真实参数并记录精确版本', async () => {
    const f = await connectionFixture()
    await f.call('media_prepare_run', selected)
    await f.call('media_execute_run', { runId: 'chosen-run', expectedRevision: 0 })
    const receipt = (await f.service.invoke('load', f.target)).jobs[0]?.mediaExecutions?.[0]
    expect(receipt?.source).toEqual({ type: 'workflow', connectionId: 'comfy.local', workflowId: 'remote.snapshot', workflowRevision: 2 })
    expect(receipt?.entryId).toBe('comfy-image')
    expect(receipt?.parameters).toEqual({ seed: 7 })
    expect(f.calls).toEqual(['media_prepare_run', 'media_execute_run'])
  })
  test('Given 已选服务 When Agent 改用其他服务 Then 解析及准备前拒绝且不自动回退', async () => {
    const f = await connectionFixture()
    await expect(f.call('media_prepare_run', { ...selected, connectionId: 'another-server' })).rejects.toThrow('OUT_OF_SCOPE')
    expect(f.resolved).toHaveLength(0)
    expect(f.calls).toHaveLength(0)
  })
  test('Given 工作流未匹配或参数不支持 When 准备 Then 不调用底层生成工具', async () => {
    const f = await connectionFixture()
    await expect(f.call('media_prepare_run', { ...selected, workflowId: 'missing' })).rejects.toThrow('WORKFLOW_NOT_MATCHED')
    await expect(f.call('media_prepare_run', { ...selected, inputs: { invented: { kind: 'scalar', value: true } } })).rejects.toThrow('PARAMETER_INVALID')
    expect(f.calls).toHaveLength(0)
  })
  test('Given 已准备工作流 When 执行前服务失效 Then 拒绝执行且保留原记录', async () => {
    const f = await connectionFixture()
    await f.call('media_prepare_run', selected)
    f.workflow.available = false
    await expect(f.call('media_execute_run', { runId: 'chosen-run', expectedRevision: 0 })).rejects.toThrow('UNAVAILABLE')
    expect(f.calls).toEqual(['media_prepare_run'])
  })
})

test('Given 视频任务使用 ComfyUI When 未发现和选定工作流 Then 预检阻断，完成后才允许准备', async () => {
  const root = mkdtempSync(join(tmpdir(), 'visual-workflow-gate-')); roots.push(root)
  const connection = { id: 'comfy-video', name: '芯火服务', kind: 'video' as const, source: { type: 'connection' as const, connectionId: 'comfy.local' }, parameters: {}, available: true, constraints: {} }
  const workflow = { id: 'resolved-workflow', name: '工作流', kind: 'video' as const, source: { type: 'workflow' as const, connectionId: 'comfy.local', workflowId: 'workflow', workflowRevision: 2 }, parameters: {}, available: true, constraints: {} }
  const service = new VisualProductionService({
    workspaceId: 'project', projectRoot: root,
    listMediaOptions: async () => [connection],
    resolveMediaWorkflow: async source => ({ ...workflow, source }),
    readMediaExecution: async (_session, runId, engine) => ({ runId, engine, name: '芯火工作流', kind: 'video', source: workflow.source, parameters: {}, referenceAssets: [], phase: 'prepared', createdAt: 1 }),
  })
  const access = { workspaceId: 'project', assertCurrent() {}, execute: <M extends VisualProductionMethod>(method: M, input: VisualProductionInputs[M]): Promise<VisualProductionResults[M]> => service.invoke(method, input) }
  const run = createVisualProductionRun('session', access, access)
  const created = await service.invoke('create', { sessionId: 'session', title: '视频任务', kind: 'film' })
  const target = { sessionId: 'session', productionId: created.document.id }
  await service.invoke('saveMediaConfiguration', { ...target, expectedRevision: 0,
    entries: [{ id: connection.id, name: connection.name, kind: 'video', source: connection.source, parameters: {} }], defaults: { video: connection.id } })
  await run.execute('beginJob', { ...target, baseRevision: 1, instruction: '制作视频', mediaKind: 'video' })
  const calls: string[] = []
  const tools: ToolDefinition[] = [
    { name: 'media_discover_workflows', label: '发现', description: '', parameters: Type.Object({}), execute: async () => {
      calls.push('discover')
      return { content: [{ type: 'text' as const, text: '{}' }], details: { items: [], discovery: { status: 'candidates', candidateCount: 1 }, connectionId: 'comfy.local', snapshotId: 'snapshot-1', checkedAt: 10, nextOffset: null, total: 0 } }
    } },
    { name: 'media_use_remote_workflow', label: '选择', description: '', parameters: Type.Object({}), execute: async () => {
      calls.push('select')
      return { content: [{ type: 'text' as const, text: '{}' }], details: { id: 'workflow', revision: 2, hash: 'b'.repeat(64), contentHash: 'a'.repeat(64), connectionId: 'comfy.local', source: 'comfyui-server' } }
    } },
    { name: 'media_prepare_run', label: '准备', description: '', parameters: Type.Object({}), execute: async () => {
      calls.push('prepare')
      return { content: [{ type: 'text' as const, text: '{}' }], details: { id: 'run-1' } }
    } },
  ]
  const wrapped = bindVisualProductionMediaTools(tools, { sessionId: 'session', access, jobs: () => run.mediaJobs() })
  const call = (name: string, params: Record<string, unknown>) => wrapped.find(tool => tool.name === name)!.execute('call', params, undefined, undefined, {} as never)
  const prepare = { connectionId: 'comfy.local', workflowId: 'workflow', workflowRevision: 2, mediaKind: 'video', inputs: {} }
  await expect(call('media_prepare_run', prepare)).rejects.toThrow('WORKFLOW_DISCOVERY_REQUIRED')
  expect(calls).toEqual([])
  await call('media_discover_workflows', { connectionId: 'comfy.local', mediaKind: 'video', inputKinds: ['image', 'image'] })
  await call('media_use_remote_workflow', { descriptor: { id: 'workflow' }, contentHash: 'a'.repeat(64) })
  await call('media_prepare_run', prepare)
  expect(calls).toEqual(['discover', 'select', 'prepare'])
})
