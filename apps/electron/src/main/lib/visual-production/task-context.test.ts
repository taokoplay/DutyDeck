import { describe, expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import type { VisualProductionSnapshot, VisualProductionInputs, VisualProductionMethod, VisualProductionResults } from '@dutydeck/shared'
import { createVisualTaskContextRuntime } from './task-context'
import type { VisualContextObservation, VisualTaskContextRuntimeOptions } from './task-context'

/** 固定媒体数据让测试核对真实内容 hash，不依赖图片解码器。 */
const bytes = new Uint8Array([1, 2, 3])
/** 构造含无关镜头的作品，防止上下文退化为全库图片。 */
function fixture(options: Partial<VisualTaskContextRuntimeOptions> = {}) {
  const media = ['m1', 'm2', 'ma'].map(id => ({ id, hash: createHash('sha256').update(bytes).digest('hex'), name: id, mime: 'image/png', kind: 'image' as const, byteSize: bytes.length, createdAt: 1 }))
  const snapshot: VisualProductionSnapshot = { document: { schemaVersion: 1, id: 'p1', revision: 1, createdAt: 1, updatedAt: 1, title: '作品', kind: 'film', brief: '', ratio: '16:9', fps: 24, voice: '', music: '', episodes: [{ id: 'e1', title: '集' }], assets: [{ id: 'a1', name: '角色', type: '角色', description: '', locked: true, mediaId: 'ma' }], shots: ['s1', 's2'].map((id, index) => ({ id, title: id, episodeId: 'e1', duration: 2, scene: '', motion: '', dialogue: '', assetIds: index === 0 ? ['a1'] : [], mediaId: index === 0 ? 'm1' : 'm2' })) }, media, assetVersions: { a1: 1 }, shotStates: { s1: { revision: 1, outputVersion: 1, needsUpdate: false }, s2: { revision: 1, outputVersion: 1, needsUpdate: false } }, candidates: [], jobs: [] }
  const access = { workspaceId: 'w1', assertCurrent() {}, async execute<M extends VisualProductionMethod>(method: M, _input: VisualProductionInputs[M]): Promise<VisualProductionResults[M]> { return (method === 'load' ? structuredClone(snapshot) : { mediaId: 'm1', bytes, mime: 'image/png' }) as VisualProductionResults[M] } }
  const runtime = createVisualTaskContextRuntime({ runId: 'r1', sessionId: 'u1', access, ...options })
  const input = { productionId: 'p1', productionRevision: 1, target: { kind: 'shot' as const, shotId: 's1' }, objective: '检查角色一致性' }
  return { snapshot, runtime, input, access }
}

describe('影像任务范围', () => {
  test('Given目标镜头 When打开 Then只允许正式输出与绑定资产', async () => {
    const { runtime, input } = fixture()
    const opened = await runtime.open(input)
    const scope = await runtime.describe(opened.details.visualTaskContext.contextId)
    expect(scope.media.map(item => item.id)).toEqual(['m1', 'ma'])
    await expect(runtime.inspect({ contextId: scope.contextId, mediaId: 'm2' })).rejects.toThrow('OUT_OF_SCOPE')
    expect((await runtime.inspect({ contextId: scope.contextId, mediaId: 'm1' })).content.some(item => item.type === 'image')).toBe(true)
  })
  test('Given作品范围 When打开 Then不能默认读取整作品图片', async () => {
    const { runtime, input } = fixture()
    const opened = await runtime.open({ ...input, target: { kind: 'production' } })
    await expect(runtime.inspect({ contextId: opened.details.visualTaskContext.contextId, mediaId: 'm1' })).rejects.toThrow('OUT_OF_SCOPE')
  })
  test('Given已打开范围 When正式版本变化或取消 Then拒绝继续读取', async () => {
    const { runtime, input, snapshot } = fixture()
    const opened = await runtime.open(input)
    snapshot.document.revision++
    await expect(runtime.describe(opened.details.visualTaskContext.contextId)).rejects.toThrow('VERSION_CHANGED')
    snapshot.document.revision--
    const controller = new AbortController(); controller.abort()
    await expect(runtime.inspect({ contextId: opened.details.visualTaskContext.contextId, mediaId: 'm1' }, controller.signal)).rejects.toThrow()
  })
  test('Given旧范围 When新范围替换 Then旧授权不可恢复且未检查证据不可提交', async () => {
    const { runtime, input } = fixture()
    const first = await runtime.open(input)
    const second = await runtime.open(input)
    await expect(runtime.describe(first.details.visualTaskContext.contextId)).rejects.toThrow('CONTEXT_INACTIVE')
    expect(() => runtime.assertContextActive(first.details.visualTaskContext.contextId)).toThrow('CONTEXT_INACTIVE')
    expect(() => runtime.assertContextActive(second.details.visualTaskContext.contextId)).not.toThrow()
    await expect(runtime.record({ contextId: second.details.visualTaskContext.contextId, evidenceIds: ['invented'], objective: '检查', conclusion: '通过', unchecked: [] })).rejects.toThrow('EVIDENCE_REQUIRED')
  })
})


describe('证据与恢复', () => {
  test('Given已看图并记录 When新运行重开 Then结论可追溯但旧证据不能重用', async () => {
    const observations: VisualContextObservation[] = []
    const evidenceStore = { list: () => observations, append: (value: VisualContextObservation) => { observations.push(value) } }
    const first = fixture({ evidenceStore })
    const opened = await first.runtime.open(first.input)
    const contextId = opened.details.visualTaskContext.contextId
    const inspected = await first.runtime.inspect({ contextId, mediaId: 'm1' })
    const evidenceId = inspected.details.visualTaskContext.evidenceId!
    await first.runtime.record({ contextId, evidenceIds: [evidenceId], objective: '角色一致性', conclusion: '衣服颜色一致', unchecked: ['动作连续性'] })
    expect(observations[0]?.evidence[0]?.mediaHash).toBe(first.snapshot.media[0]?.hash)
    first.runtime.dispose()
    const second = fixture({ evidenceStore, runId: 'r2' })
    const resumed = await second.runtime.open(second.input)
    const description = await second.runtime.describe(resumed.details.visualTaskContext.contextId)
    expect(description.observations).toHaveLength(1)
    await expect(second.runtime.record({ contextId: description.contextId, evidenceIds: [evidenceId], objective: '复核', conclusion: '通过', unchecked: [] })).rejects.toThrow('EVIDENCE_REQUIRED')
  })
  test('Given候选 When绑定目标检查 Then拒绝其他镜头任务与过期候选', async () => {
    const { runtime, input, snapshot } = fixture()
    snapshot.jobs.push({ id: 'j1', sessionId: 'u1', baseRevision: 1, shotId: 's2', instruction: '生成', status: 'candidate', createdAt: 1 })
    snapshot.candidates.push({ id: 'c1', jobId: 'j1', baseRevision: 1, draft: structuredClone(snapshot.document), status: 'ready', summary: '', createdAt: 1 })
    await expect(runtime.open({ ...input, candidateId: 'c1' })).rejects.toThrow('OUT_OF_SCOPE')
    snapshot.jobs[0]!.shotId = 's1'
    const opened = await runtime.open({ ...input, candidateId: 'c1' })
    snapshot.candidates[0]!.status = 'stale'
    await expect(runtime.describe(opened.details.visualTaskContext.contextId)).rejects.toThrow('CANDIDATE_STALE')
  })
  test('Given显式连续性镜头 When打开 Then可读该镜头而不是邻近猜测', async () => {
    const { runtime, input } = fixture()
    const opened = await runtime.open({ ...input, continuityShotIds: ['s2'] })
    expect((await runtime.describe(opened.details.visualTaskContext.contextId)).media.map(item => item.id)).toEqual(['m1', 'ma', 'm2'])
    await expect(runtime.open({ ...input, continuityShotIds: ['s2', 's2', 's2', 's2', 's2'] })).rejects.toThrow('SCOPE_LIMIT')
  })
  test('Given媒体被替换 When检查 Then拒绝hash不匹配并不登记证据', async () => {
    const { runtime, input, snapshot } = fixture()
    snapshot.media[0]!.hash = '0'.repeat(64)
    const opened = await runtime.open(input)
    await expect(runtime.inspect({ contextId: opened.details.visualTaskContext.contextId, mediaId: 'm1' })).rejects.toThrow('MEDIA_CHANGED')
  })
})

test('Given父子相同素材版本 When子记录不同检查目标 Then父describe刷新可追溯结论', async () => {
  const observations: VisualContextObservation[] = []
  const evidenceStore = { list: () => observations, append: (value: VisualContextObservation) => { observations.push(value) } }
  const parent = fixture({ evidenceStore })
  const child = fixture({ evidenceStore, runId: 'child' })
  const parentOpened = await parent.runtime.open(parent.input)
  const childOpened = await child.runtime.open({ ...child.input, objective: '检查服装颜色' })
  const contextId = childOpened.details.visualTaskContext.contextId
  const inspected = await child.runtime.inspect({ contextId, mediaId: 'm1' })
  await child.runtime.record({ contextId, evidenceIds: [inspected.details.visualTaskContext.evidenceId!], objective: '服装颜色', conclusion: '颜色相同', unchecked: [] })
  expect((await parent.runtime.describe(parentOpened.details.visualTaskContext.contextId)).observations[0]?.runId).toBe('child')
})

test('Given检查读取尚未完成 When关闭范围 Then迟到媒体不重新激活授权', async () => {
  const base = fixture()
  let release: (() => void) | undefined
  let reading: (() => void) | undefined
  const started = new Promise<void>(resolve => { reading = resolve })
  const pending = new Promise<void>(resolve => { release = resolve })
  const runtime = createVisualTaskContextRuntime({ runId: 'r2', sessionId: 'u1', access: { ...base.access, async execute<M extends VisualProductionMethod>(method: M, input: VisualProductionInputs[M]): Promise<VisualProductionResults[M]> {
    if (method === 'mediaContent') { reading!(); await pending }
    return base.access.execute(method, input)
  } } })
  const opened = await runtime.open(base.input)
  const contextId = opened.details.visualTaskContext.contextId
  const inspecting = runtime.inspect({ contextId, mediaId: 'm1' })
  await started
  await runtime.close({ contextId })
  release!()
  await expect(inspecting).rejects.toThrow('CONTEXT_INACTIVE')
})

test('Given音频身份检查 When没有声音样本 Then只登记technical且保存未听取限制', async () => {
  const base = fixture()
  base.snapshot.media[0]!.kind = 'audio'
  base.snapshot.media[0]!.mime = 'audio/wav'
  const observations: VisualContextObservation[] = []
  const runtime = createVisualTaskContextRuntime({ runId: 'audio-run', sessionId: 'u1', evidenceStore: { list: () => observations, append: value => { observations.push(value) } }, access: { ...base.access, async execute<M extends VisualProductionMethod>(method: M, input: VisualProductionInputs[M]): Promise<VisualProductionResults[M]> {
    if (method === 'mediaContent') return { mediaId: 'm1', bytes, mime: 'audio/wav' } as VisualProductionResults[M]
    return base.access.execute(method, input)
  } } })
  const opened = await runtime.open(base.input)
  const contextId = opened.details.visualTaskContext.contextId
  const inspected = await runtime.inspect({ contextId, mediaId: 'm1' })
  expect(inspected.details.visualTaskContext.inspectionKind).toBe('technical')
  expect(inspected.content.some(item => item.type === 'image')).toBe(false)
  await runtime.record({ contextId, evidenceIds: [inspected.details.visualTaskContext.evidenceId!], objective: '身份检查', conclusion: '字节身份匹配，未听取内容', unchecked: [] })
  expect(observations[0]?.evidence[0]?.inspectionKind).toBe('technical')
  expect(observations[0]?.unchecked.join('')).toContain('未查看视觉内容或听取声音内容')
})

test('Given子任务A结论后B写满近期窗口 When按A查询父范围 Then先过滤运行再分页', async () => {
  const observations: VisualContextObservation[] = []
  const evidenceStore = { list: () => observations, append: (value: VisualContextObservation) => { observations.push(value) } }
  const parent = fixture({ evidenceStore })
  const opened = await parent.runtime.open(parent.input)
  for (const runId of ['A', 'B']) {
    const child = fixture({ evidenceStore, runId })
    const scope = await child.runtime.open(child.input)
    const contextId = scope.details.visualTaskContext.contextId
    const inspected = await child.runtime.inspect({ contextId, mediaId: 'm1' })
    for (let index = 0; index < (runId === 'A' ? 1 : 4); index++) await child.runtime.record({ contextId, evidenceIds: [inspected.details.visualTaskContext.evidenceId!], objective: '检查', conclusion: '结果', unchecked: [] })
  }
  const description = await parent.runtime.describe(opened.details.visualTaskContext.contextId, undefined, 'A')
  expect(description.observations.map(item => item.runId)).toEqual(['A'])
})
