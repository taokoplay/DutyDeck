import { afterEach, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import sharp from 'sharp'
import type { MediaAssetRef, VisualJob, VisualMedia, VisualCandidate, VisualProductionDraft } from '@proma/shared'
import { createDesignPathResolver } from '../design/design-paths'
import { createDesignStore } from '../design/design-store'
import { DesignAssetService } from '../design/design-asset-service'
import { MediaDesignAssets } from '../media/media-design-assets'
import { MediaAssetService } from '../media/media-asset-service'
import { UnifiedMediaGenerationService } from '../media/unified-media-generation-service'
import { createUnifiedMediaHttpAdapters } from '../media/unified-media-http-adapters'
import { VisualProductionService } from './store'
import { createVisualProductionAccess } from './access'
import { createVisualProductionRun } from './agent-run'
import { buildVisualProductionAgentTools } from './agent-tools'

/** 所有文件均位于每例独立的临时根，清理不涉及用户项目。 */
const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })

/** 从正式快照提取允许保存的领域字段，避免把系统版本作为草稿传入。 */
function editable(document: VisualProductionDraft): VisualProductionDraft {
  const { title, kind, brief, ratio, fps, voice, music, episodes, assets, shots } = document
  return { title, kind, brief, ratio, fps, voice, music, episodes, assets, shots }
}

/** 使用真实资产、存储、访问控制、工具及 HTTP 适配器，只有供应商 HTTP 响应使用 fixture。 */
async function fixture(httpFailure = false, holdResponse = false) {
  /** 项目与配置缓存隔离在同一可清理根下。 */
  const root = mkdtempSync(join(tmpdir(), 'visual-generation-loop-')); roots.push(root)
  const projectRoot = join(root, 'project')
  mkdirSync(projectRoot)
  mkdirSync(join(root, 'config'))
  /** sharp 生成可真实解码的参考与输出，验证图片资产服务和缩略图链路。 */
  const referenceBytes = await sharp({ create: { width: 8, height: 8, channels: 4, background: '#ff0000' } }).png().toBuffer()
  const outputBytes = await sharp({ create: { width: 8, height: 8, channels: 4, background: '#0000ff' } }).png().toBuffer()
  writeFileSync(join(projectRoot, 'actor.png'), referenceBytes)
  /** 固定工作区解析器不会访问真实配置或项目目录。 */
  const pathResolver = createDesignPathResolver({
    getWorkspace: () => ({ id: 'workspace', name: '测试', slug: 'test', projectRootPath: projectRoot, createdAt: 1, updatedAt: 1 }),
    getProjectFilesPath: () => projectRoot,
    getConfigDir: () => join(root, 'config'),
  })
  const store = createDesignStore({ pathResolver })
  store.load('workspace')
  const assets = new DesignAssetService({ pathResolver, store, runWorkspaceWrite: (_id, effect) => effect(), registerDirectoryPath: path => `proma-file://${basename(path)}`, revokePathUrl() {}, warn() {} })
  const images = new MediaDesignAssets({ store, assets, getStagingDirectory: id => pathResolver.resolve(id).stagingDir, runWorkspaceWrite: (_id, effect) => effect() })
  const mediaAssets = new MediaAssetService({ pathResolver, store, images, resolveImagePath: (id, assetId) => assets.resolveAssetPath(id, assetId), runWorkspaceWrite: (_id, effect) => effect() })
  /** UI 和 Agent 共用真实服务；参考登记键与宿主保持同一会话隔离合同。 */
  const accessFor = (sessionId: string) => createVisualProductionAccess(sessionId, {
    resolveSession: () => ({ workspaceId: 'workspace', projectRoot }),
    acquireWriteLease: () => () => {},
    createService: context => new VisualProductionService({
      ...context,
      readMediaAsset: reference => mediaAssets.read('workspace', reference),
      registerReference: ({ sessionId: owner, productionId, media, bytes }) => mediaAssets.register('workspace', `${owner}:${media.hash}`, bytes, media.mime, { mediaRunId: productionId, sourceSessionId: owner }, media.kind),
    }),
  })
  const ui = accessFor('ui')
  const created = await ui.execute('create', { sessionId: 'ui', title: '三个镜头宣传片', kind: 'promo' })
  const target = { sessionId: 'ui', productionId: created.document.id }
  const reference = await ui.execute('importFile', { ...target, relativePath: 'actor.png' })
  const draft: VisualProductionDraft = {
    ...editable(created.document),
    assets: [{ id: 'actor', name: '主角', type: '角色', description: '锁定红色角色', locked: true, mediaId: reference.id }],
    shots: [1, 2, 3].map(index => ({ id: `shot${index}`, episodeId: created.document.episodes[0]!.id, title: `镜头${index}`, duration: 5, scene: `场景${index}`, motion: '推进', dialogue: '', assetIds: ['actor'], mediaId: reference.id })),
  }
  const baseline = await ui.execute('save', { ...target, baseRevision: 1, draft })
  /** 每次创建全新的真实运行，旧任务不能被新会话接管。 */
  function agent(sessionId: string) {
    const access = accessFor(sessionId)
    const run = createVisualProductionRun(sessionId, access, access)
    const tools = buildVisualProductionAgentTools({ sessionId, sdk: { defineTool: (definition: unknown) => definition } as Parameters<typeof buildVisualProductionAgentTools>[0]['sdk'], execute: run.execute, assertAccess: () => access.assertCurrent() })
    return {
      run,
      /** 通过生产工具参数校验和响应投影执行，不绕开领域工具入口。 */
      async call<T>(name: string, input: Record<string, unknown>): Promise<T> {
        const tool = tools.find(item => item.name === `visual_production_${name}`)
        if (!tool) throw new Error(`缺少工具 ${name}`)
        return (await tool.execute('call', input, undefined, undefined, {} as never)).details as T
      },
    }
  }
  /** 捕获真实适配器提交的 multipart 字节，HTTP fixture 不实现任何资产或状态逻辑。 */
  const submittedReferences: Buffer[] = []
  /** HTTP 响应闸门使取消用例确定发生于上游请求中，不依赖定时器竞速。 */
  let releaseHttp: () => void = () => {}
  let notifyHttpStarted: () => void = () => {}
  const httpReleased = new Promise<void>(resolve => { releaseHttp = resolve })
  const httpStarted = new Promise<void>(resolve => { notifyHttpStarted = resolve })
  const generation = new UnifiedMediaGenerationService({
    resolveModel: () => ({ option: { ref: 'media:image:openai-images:profile:gpt-image-1', name: '图片模型', kind: 'image', provider: 'openai-images', profileId: 'profile', modelId: 'gpt-image-1', capabilities: ['image-to-image'], available: true, adapterId: 'openai-images' }, ref: { kind: 'image', provider: 'openai-images', profileId: 'profile', modelId: 'gpt-image-1' }, baseUrl: 'https://fixture.invalid/v1', apiKey: 'fixture-key' }),
    registerOutput: (projectId, operationId, bytes, mime, origin, kind) => mediaAssets.register(projectId, operationId, bytes, mime, origin, kind),
    adapters: createUnifiedMediaHttpAdapters({ readAsset: (projectId, asset) => mediaAssets.read(projectId, asset), fetch: async (url, init) => {
      expect(String(url)).toBe('https://fixture.invalid/v1/images/edits')
      expect(init?.body).toBeInstanceOf(FormData)
      const image = (init!.body as FormData).get('image') as File
      expect(image.type).toBe('image/png')
      submittedReferences.push(Buffer.from(await image.arrayBuffer()))
      notifyHttpStarted()
      if (holdResponse) await httpReleased
      return httpFailure ? new Response('fixture unavailable', { status: 503 }) : new Response(JSON.stringify({ data: [{ b64_json: outputBytes.toString('base64') }] }))
    } }),
  })
  /** 准备、执行并等待真实统一媒体服务，返回登记后的受管输出。 */
  async function generate(sessionId: string, reference: MediaAssetRef) {
    const prepared = generation.prepare(sessionId, { projectId: 'workspace', operationId: 'shot3-output', modelRef: 'media:image:openai-images:profile:gpt-image-1', prompt: '保持角色，仅重做第三镜头', inputs: { reference: { kind: 'asset', asset: reference } } })
    const running = await generation.execute(sessionId, prepared.id, prepared.revision)
    return await generation.wait(sessionId, running.id, 10_000, running.revision)
  }
  return { ui, uiFor: accessFor, httpStarted, releaseHttp, target, baseline, reference, referenceBytes, outputBytes, submittedReferences, agent, generate }
}

/** 冻结第三镜头并通过领域工具获取正式锁定参考。 */
async function begin(f: Awaited<ReturnType<typeof fixture>>, sessionId = 'agent') {
  const agent = f.agent(sessionId)
  const base = { productionId: f.target.productionId, baseRevision: f.baseline.document.revision }
  const context = await agent.call<{ shot: { id: string }; assets: Array<{ locked: boolean }> }>('read_shot', { productionId: base.productionId, shotId: 'shot3' })
  expect(context.shot.id).toBe('shot3')
  expect(context.assets[0]?.locked).toBe(true)
  const job = await agent.call<VisualJob>('begin_job', { ...base, shotId: 'shot3', instruction: '仅重做第三镜头' })
  const reference = await agent.call<MediaAssetRef>('reference_media', { ...base, jobId: job.id, mediaId: f.reference.id })
  return { agent, base, job, reference }
}

describe('影像制作真实组件闭环（仅 HTTP 使用 fixture）', () => {
  test('Given 三镜头与锁定角色 When 生成第三镜头并由UI采用 Then 参考完整、采用前不变且只更新目标输出', async () => {
    const f = await fixture()
    const flow = await begin(f)
    const done = await f.generate('agent', flow.reference)
    expect(done.phase).toBe('succeeded')
    expect(f.submittedReferences).toEqual([f.referenceBytes])
    const output = done.outputs[0]!.asset
    const media = await flow.agent.call<VisualMedia>('import_media', { productionId: flow.base.productionId, reference: output })
    expect(media.id).not.toBe(output.assetId)
    expect(media.id).not.toBe(f.reference.id)
    expect(Buffer.from((await f.ui.execute('mediaContent', { ...f.target, mediaId: media.id })).bytes)).toEqual(f.outputBytes)
    const candidate = await flow.agent.call<VisualCandidate>('propose_shot', { ...flow.base, jobId: flow.job.id, shotId: 'shot3', mediaId: media.id, summary: '第三镜头新画面' })
    const before = await f.ui.execute('load', f.target)
    expect(before.document).toEqual(f.baseline.document)
    expect(before.assetVersions).toEqual(f.baseline.assetVersions)
    expect(before.shotStates).toEqual(f.baseline.shotStates)
    const after = await f.ui.execute('adopt', { ...f.target, baseRevision: flow.base.baseRevision, candidateId: candidate.id })
    expect(after.document.assets).toEqual(f.baseline.document.assets)
    expect(after.assetVersions).toEqual(f.baseline.assetVersions)
    expect(after.document.shots.slice(0, 2)).toEqual(f.baseline.document.shots.slice(0, 2))
    expect(after.shotStates.shot1).toEqual(f.baseline.shotStates.shot1)
    expect(after.shotStates.shot2).toEqual(f.baseline.shotStates.shot2)
    expect(after.document.shots[2]).toEqual({ ...f.baseline.document.shots[2]!, mediaId: media.id })
    expect(editable(after.document)).toEqual({ ...editable(f.baseline.document), shots: f.baseline.document.shots.map(shot => shot.id === 'shot3' ? { ...shot, mediaId: media.id } : shot) })
    expect(after.shotStates.shot3!.outputVersion).toBe(f.baseline.shotStates.shot3!.outputVersion + 1)
    expect(after.document.revision).toBe(flow.base.baseRevision + 1)
  })

  test('Given 新会话重试相同锁定参考 When 再次登记 Then 不发生来源身份冲突', async () => {
    const f = await fixture()
    const first = await begin(f, 'session-one')
    await first.agent.run.finish(true)
    const second = await begin(f, 'session-two')
    expect(second.reference.hash).toBe(first.reference.hash)
    expect((await f.generate('session-two', second.reference)).phase).toBe('succeeded')
    expect(f.submittedReferences).toEqual([f.referenceBytes])
    expect((await f.ui.execute('load', f.target)).document).toEqual(f.baseline.document)
  })

  test('Given 上游HTTP失败 When 执行并记录失败 Then 没有候选、输出或正式变更', async () => {
    const f = await fixture(true)
    const flow = await begin(f)
    const done = await f.generate('agent', flow.reference)
    expect(done.phase).toBe('failed')
    expect(done.outputs).toEqual([])
    await flow.agent.call('fail_job', { productionId: flow.base.productionId, jobId: flow.job.id, message: '供应商 HTTP 503' })
    const after = await f.ui.execute('load', f.target)
    expect(after.jobs.find(item => item.id === flow.job.id)?.status).toBe('failed')
    expect(after.candidates).toEqual([])
    expect(after.document).toEqual(f.baseline.document)
  })

  test('Given 生成期间用户取消影像任务 When 真实媒体迟到并回流 Then 不得提交候选或改变正式镜头', async () => {
    const f = await fixture(false, true)
    const flow = await begin(f)
    const pending = f.generate('agent', flow.reference)
    await f.httpStarted
    await f.uiFor('agent').execute('cancelJob', { ...f.target, sessionId: 'agent', jobId: flow.job.id })
    f.releaseHttp()
    const done = await pending
    expect(done.phase).toBe('succeeded')
    const media = await flow.agent.call<VisualMedia>('import_media', { productionId: flow.base.productionId, reference: done.outputs[0]!.asset })
    await expect(flow.agent.call('propose_shot', { ...flow.base, jobId: flow.job.id, shotId: 'shot3', mediaId: media.id, summary: '迟到结果' })).rejects.toThrow()
    const after = await f.ui.execute('load', f.target)
    expect(after.candidates).toEqual([])
    expect(after.document).toEqual(f.baseline.document)
    expect(after.jobs.find(item => item.id === flow.job.id)?.status).toBe('cancelled')
  })
})
