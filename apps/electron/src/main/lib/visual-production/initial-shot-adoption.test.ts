import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { VisualCandidate, VisualJob, VisualMedia, VisualProductionDraft, VisualProductionSnapshot } from '@dutydeck/shared'
import { writeJsonFileAtomicSecure } from '../safe-file'
import { VisualProductionService } from './store'

/** 本组测试仅操作临时项目，结束后清理所有副本。 */
const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })

/** 提取业务草稿，避免把宿主版本字段传给保存命令。 */
function editable(document: VisualProductionDraft): VisualProductionDraft {
  const { title, kind, brief, ratio, fps, voice, music, episodes, assets, shots } = document
  return { title, kind, brief, ratio, fps, voice, music, episodes, assets, shots }
}

/** 建立两个空镜头和三份真实导入图片，返回服务、媒体与当前基线。 */
async function fixture(outputCount?: number) {
  /** 每次独立目录使并发测试不共享锁或快照。 */
  const projectRoot = mkdtempSync('/private/tmp/visual-initial-shot-'); roots.push(projectRoot)
  /** 生产服务直接用于验证原子版本行为。 */
  const service = new VisualProductionService({ projectRoot, workspaceId: 'workspace', readMediaExecution: async (_sessionId, runId, engine) => ({ runId, engine, name: '真实回执', kind: 'image', source: { type: 'model', modelRef: 'image-model' }, parameters: {}, referenceAssets: [], phase: 'succeeded', createdAt: 1, ...(outputCount === undefined ? {} : { outputCount }) }) })
  /** 创建后的正式身份用于后续全部调用。 */
  const created = await service.invoke('create', { sessionId: 'session', title: '分镜', kind: 'comic' })
  const target = { sessionId: 'session', productionId: created.document.id }
  /** 三份不同字节图片可验证多图选择与不可变媒体身份。 */
  const media: VisualMedia[] = []
  for (let index = 0; index < 3; index++) {
    writeFileSync(join(projectRoot, `${index}.png`), Buffer.concat([Buffer.from('89504e470d0a1a0a00000000', 'hex'), Buffer.from([index])]))
    media.push(await service.invoke('importFile', { ...target, relativePath: `${index}.png` }))
  }
  /** 两镜头共享锁定资产，验证画面采用不会改资产或分镜设定。 */
  const draft: VisualProductionDraft = { ...editable(created.document), assets: [{ id: 'actor', name: '角色', type: '角色', description: '固定身份', locked: true, mediaId: media[0]!.id }], shots: ['shot1', 'shot2'].map(id => ({ id, episodeId: created.document.episodes[0]!.id, title: id, duration: 5, scene: '原画面', motion: '', dialogue: '', assetIds: ['actor'], mediaId: null })) }
  const snapshot = await service.invoke('save', { ...target, baseRevision: 1, draft })
  /** 用于兼容旧候选测试的固定快照位置。 */
  const snapshotPath = join(projectRoot, '.proma/visual-production/projects', target.productionId, 'snapshot.json')
  return { service, target, media, snapshot, snapshotPath, projectRoot }
}

/** 在原始 v2 基线上登记指定镜头任务；返回可信任务身份。 */
async function begin(context: Awaited<ReturnType<typeof fixture>>, shotId = 'shot1'): Promise<VisualJob> {
  return context.service.invoke('beginJob', { ...context.target, baseRevision: 2, shotId, instruction: '生成镜头画面' })
}

/** 构造旧版已经提交但尚未采用的候选，只替换目标画面。 */
function legacyCandidate(snapshot: VisualProductionSnapshot, job: VisualJob, mediaId: string, id: string): VisualCandidate {
  return { id, jobId: job.id, baseRevision: 2, status: 'ready', createdAt: 1, summary: '旧版待采用画面', draft: { ...editable(snapshot.document), shots: snapshot.document.shots.map(shot => shot.id === job.shotId ? { ...shot, mediaId } : shot) } }
}

describe('空镜头唯一图片自动采用', () => {
  test('Given 空镜头 When 提交唯一图片 Then 原子采用且保留设定、资产、其他镜头与历史', async () => {
    const f = await fixture()
    const job = await begin(f)
    const candidate = await f.service.invoke('proposeShot', { ...f.target, baseRevision: 2, jobId: job.id, shotId: 'shot1', mediaId: f.media[1]!.id, summary: '新画面' })
    expect(candidate.status).toBe('adopted')
    expect(candidate.adoptedRevision).toBe(3)
    const saved = await f.service.invoke('load', f.target)
    expect(saved.document.shots[0]).toEqual({ ...f.snapshot.document.shots[0]!, mediaId: f.media[1]!.id, outputs: { image: f.media[1]!.id, video: null, audio: null } })
    expect(saved.document.shots[1]).toEqual(f.snapshot.document.shots[1]!)
    expect(saved.document.assets).toEqual(f.snapshot.document.assets)
    expect(saved.assetVersions).toEqual(f.snapshot.assetVersions)
    expect(saved.shotStates.shot1).toMatchObject({ outputVersion: 1, needsUpdate: false })
    expect(saved.candidates[0]?.status).toBe('adopted')
  })

  test('Given 两个镜头在同一版本开始 When 分别返回图片 Then 均自动采用且第二个任务沿用原始基线', async () => {
    const f = await fixture()
    const first = await begin(f)
    const second = await begin(f, 'shot2')
    await f.service.invoke('proposeShot', { ...f.target, baseRevision: 2, jobId: first.id, shotId: 'shot1', mediaId: f.media[1]!.id, summary: '第一镜' })
    const middle = await f.service.invoke('load', f.target)
    expect(middle.jobs.find(job => job.id === second.id)).toMatchObject({ status: 'running', baseRevision: 2, compatibleRevision: 3 })
    await f.service.invoke('updateJob', { ...f.target, baseRevision: 2, jobId: second.id, stage: 'generating' })
    const result = await f.service.invoke('proposeShot', { ...f.target, baseRevision: 2, jobId: second.id, shotId: 'shot2', mediaId: f.media[2]!.id, summary: '第二镜' })
    expect(result.status).toBe('adopted')
    const saved = await f.service.invoke('load', f.target)
    expect(saved.document.shots.map(shot => shot.mediaId)).toEqual([f.media[1]!.id, f.media[2]!.id])
    expect(saved.document.revision).toBe(4)
  })

  test('Given 已有正式画面 When 生成另一张 Then 保留原图并等待选择', async () => {
    const f = await fixture()
    const saved = await f.service.invoke('save', { ...f.target, baseRevision: 2, draft: { ...editable(f.snapshot.document), shots: f.snapshot.document.shots.map(shot => ({ ...shot, mediaId: f.media[0]!.id })) } })
    const job = await f.service.invoke('beginJob', { ...f.target, baseRevision: 3, shotId: 'shot1', instruction: '重做' })
    const candidate = await f.service.invoke('proposeShot', { ...f.target, baseRevision: 3, jobId: job.id, shotId: 'shot1', mediaId: f.media[1]!.id, summary: '备选' })
    expect(candidate.status).toBe('ready')
    expect((await f.service.invoke('load', f.target)).document).toEqual(saved.document)
  })

  test('Given 空镜头一次两张图 When 提交全部候选 Then 不自动选择且两图都可预览', async () => {
    const f = await fixture()
    const job = await begin(f)
    const result = await f.service.invoke('proposeShot', { ...f.target, baseRevision: 2, jobId: job.id, shotId: 'shot1', mediaId: f.media[1]!.id, alternativeMediaIds: [f.media[2]!.id], summary: '二选一' })
    expect(result.status).toBe('ready')
    const saved = await f.service.invoke('load', f.target)
    expect(saved.document).toEqual(f.snapshot.document)
    expect(saved.candidates.map(candidate => candidate.draft.shots[0]!.mediaId)).toEqual([f.media[1]!.id, f.media[2]!.id])
    const adopted = await f.service.invoke('adopt', { ...f.target, baseRevision: 2, candidateId: saved.candidates[1]!.id })
    expect(adopted.document.shots[0]!.mediaId).toBe(f.media[2]!.id)
  })

  test('Given 正式设定改变 When 旧镜头任务返回 Then 拒绝且不沿兼容版本继续', async () => {
    const f = await fixture()
    const job = await begin(f)
    await f.service.invoke('save', { ...f.target, baseRevision: 2, draft: { ...editable(f.snapshot.document), brief: '新风格' } })
    await expect(f.service.invoke('proposeShot', { ...f.target, baseRevision: 2, jobId: job.id, shotId: 'shot1', mediaId: f.media[1]!.id, summary: '旧结果' })).rejects.toThrow()
    expect((await f.service.invoke('load', f.target)).document.shots[0]!.mediaId).toBeNull()
  })

  test('Given 宿主记录实际生成多图 When Agent只提交一张 Then 仍保留选择而不自动采用', async () => {
    const f = await fixture(2)
    const job = await begin(f)
    await f.service.invoke('recordMediaExecution', { ...f.target, baseRevision: 2, jobId: job.id, runId: 'batch', engine: 'model' })
    const candidate = await f.service.invoke('proposeShot', { ...f.target, baseRevision: 2, jobId: job.id, shotId: 'shot1', mediaId: f.media[1]!.id, summary: '批次中的一张' })
    expect(candidate.status).toBe('ready')
    expect((await f.service.invoke('load', f.target)).document.shots[0]!.mediaId).toBeNull()
  })

  test('Given 同镜头两次生成各一张 When 只提交其中一张 Then 累计多图仍需选择', async () => {
    const f = await fixture(1)
    const job = await begin(f)
    for (const runId of ['first-run', 'second-run']) await f.service.invoke('recordMediaExecution', { ...f.target, baseRevision: 2, jobId: job.id, runId, engine: 'model' })
    const candidate = await f.service.invoke('proposeShot', { ...f.target, baseRevision: 2, jobId: job.id, shotId: 'shot1', mediaId: f.media[1]!.id, summary: '挑出其中一张' })
    expect(candidate.status).toBe('ready')
    expect((await f.service.invoke('load', f.target)).document.shots[0]!.mediaId).toBeNull()
  })

  test('Given 整作品任务生成两图但只提交一个空镜头 When 使用完整候选 Then 不能绕过多图选择', async () => {
    const f = await fixture(1)
    const job = await f.service.invoke('beginJob', { ...f.target, baseRevision: 2, instruction: '生成画面' })
    for (const runId of ['first-run', 'second-run']) await f.service.invoke('recordMediaExecution', { ...f.target, baseRevision: 2, jobId: job.id, runId, engine: 'model' })
    const candidate = await f.service.invoke('propose', { ...f.target, baseRevision: 2, jobId: job.id, summary: '只交一张', draft: { ...editable(f.snapshot.document), shots: f.snapshot.document.shots.map(shot => shot.id === 'shot1' ? { ...shot, mediaId: f.media[1]!.id } : shot) } })
    expect(candidate.status).toBe('ready')
    expect((await f.service.invoke('load', f.target)).document.shots[0]!.mediaId).toBeNull()
  })

  test('Given 整作品一次产两图 When 同一张填入两个空镜头 Then 不能按镜头数掩盖未选择的另一张', async () => {
    const f = await fixture(2)
    const job = await f.service.invoke('beginJob', { ...f.target, baseRevision: 2, instruction: '批次画面' })
    await f.service.invoke('recordMediaExecution', { ...f.target, baseRevision: 2, jobId: job.id, runId: 'batch', engine: 'model' })
    const candidate = await f.service.invoke('propose', { ...f.target, baseRevision: 2, jobId: job.id, summary: '同一图重复使用', draft: { ...editable(f.snapshot.document), shots: f.snapshot.document.shots.map(shot => ({ ...shot, mediaId: f.media[1]!.id })) } })
    expect(candidate.status).toBe('ready')
  })

  test('Given 同镜头两个并行任务 When 第一张自动采用后第二张返回 Then 保留第一张并让用户选择替换', async () => {
    const f = await fixture()
    const first = await begin(f)
    const second = await begin(f)
    await f.service.invoke('proposeShot', { ...f.target, baseRevision: 2, jobId: first.id, shotId: 'shot1', mediaId: f.media[1]!.id, summary: '先完成' })
    const candidate = await f.service.invoke('proposeShot', { ...f.target, baseRevision: 2, jobId: second.id, shotId: 'shot1', mediaId: f.media[2]!.id, summary: '后完成' })
    expect(candidate.status).toBe('ready')
    expect((await f.service.invoke('load', f.target)).document.shots[0]!.mediaId).toBe(f.media[1]!.id)
  })

  test('Given 旧任务已兼容到新版本 When 用户取消后提交 Then 不得自动采用迟到图片', async () => {
    const f = await fixture()
    const first = await begin(f)
    const second = await begin(f, 'shot2')
    await f.service.invoke('proposeShot', { ...f.target, baseRevision: 2, jobId: first.id, shotId: 'shot1', mediaId: f.media[1]!.id, summary: '先完成' })
    await f.service.invoke('cancelJob', { ...f.target, jobId: second.id })
    await expect(f.service.invoke('proposeShot', { ...f.target, baseRevision: 2, jobId: second.id, shotId: 'shot2', mediaId: f.media[2]!.id, summary: '迟到' })).rejects.toThrow()
    expect((await f.service.invoke('load', f.target)).document.shots[1]!.mediaId).toBeNull()
  })

  test('Given 完整候选仅填入两个空镜头的图片 When 提交 Then 自动采用全部且仅推进一个版本', async () => {
    const f = await fixture()
    const job = await f.service.invoke('beginJob', { ...f.target, baseRevision: 2, instruction: '两镜图片' })
    const candidate = await f.service.invoke('propose', { ...f.target, baseRevision: 2, jobId: job.id, summary: '两镜完成', draft: { ...editable(f.snapshot.document), shots: f.snapshot.document.shots.map((shot, index) => ({ ...shot, mediaId: f.media[index + 1]!.id })) } })
    expect(candidate.status).toBe('adopted')
    expect(candidate.adoptedRevision).toBe(3)
  })

  test('Given 完整候选同时修改台词 When 提交图片 Then 不擅自采用文字改动', async () => {
    const f = await fixture()
    const job = await begin(f)
    const candidate = await f.service.invoke('propose', { ...f.target, baseRevision: 2, jobId: job.id, summary: '图片及台词', draft: { ...editable(f.snapshot.document), shots: f.snapshot.document.shots.map(shot => shot.id === 'shot1' ? { ...shot, dialogue: '新台词', mediaId: f.media[1]!.id } : shot) } })
    expect(candidate.status).toBe('ready')
    expect((await f.service.invoke('load', f.target)).document).toEqual(f.snapshot.document)
  })

  test('Given 图片副本损坏 When 自动采用 Then 拒绝且不留下半提交候选或正式画面', async () => {
    const f = await fixture()
    const job = await begin(f)
    writeJsonFileAtomicSecure(join(f.projectRoot, '.proma/visual-production/projects', f.target.productionId, 'media', `${f.media[1]!.id}.json`), { hash: f.media[1]!.id, data: '' })
    await expect(f.service.invoke('proposeShot', { ...f.target, baseRevision: 2, jobId: job.id, shotId: 'shot1', mediaId: f.media[1]!.id, summary: '损坏画面' })).rejects.toThrow('损坏')
    const saved = await f.service.invoke('load', f.target)
    expect(saved.document).toEqual(f.snapshot.document)
    expect(saved.candidates).toEqual([])
  })
})

describe('旧候选兼容与独立镜头采用', () => {
  test('Given 旧版两镜各一张候选 When 打开并应用新规则 Then 一次采用两镜且重复执行不增版本', async () => {
    const f = await fixture()
    const first = await begin(f)
    const second = await begin(f, 'shot2')
    const pending = await f.service.invoke('load', f.target)
    pending.jobs.forEach(job => { job.status = 'candidate' })
    pending.candidates = [legacyCandidate(pending, first, f.media[1]!.id, 'first'), legacyCandidate(pending, second, f.media[2]!.id, 'second')]
    writeJsonFileAtomicSecure(f.snapshotPath, pending)
    expect((await f.service.invoke('load', f.target)).document.revision).toBe(2)
    const saved = await f.service.invoke('autoAdoptShots', f.target)
    expect(saved.document.revision).toBe(3)
    expect(saved.document.shots.map(shot => shot.mediaId)).toEqual([f.media[1]!.id, f.media[2]!.id])
    expect(saved.candidates.map(candidate => candidate.status)).toEqual(['adopted', 'adopted'])
    expect((await f.service.invoke('autoAdoptShots', f.target)).document.revision).toBe(3)
  })

  test('Given 同一镜头两个旧候选 When 应用新规则 Then 保留两图待选择', async () => {
    const f = await fixture()
    const first = await begin(f)
    const second = await begin(f)
    const pending = await f.service.invoke('load', f.target)
    pending.jobs.forEach(job => { job.status = 'candidate' })
    pending.candidates = [legacyCandidate(pending, first, f.media[1]!.id, 'first'), legacyCandidate(pending, second, f.media[2]!.id, 'second')]
    writeJsonFileAtomicSecure(f.snapshotPath, pending)
    const saved = await f.service.invoke('autoAdoptShots', f.target)
    expect(saved.document.revision).toBe(2)
    expect(saved.candidates.every(candidate => candidate.status === 'ready')).toBe(true)
  })

  test('Given 两个独立镜头候选 When 手动采用一个 Then 另一个继续可采用且不会覆盖前者', async () => {
    const f = await fixture()
    const first = await begin(f)
    const second = await begin(f, 'shot2')
    const pending = await f.service.invoke('load', f.target)
    pending.jobs.forEach(job => { job.status = 'candidate' })
    pending.candidates = [legacyCandidate(pending, first, f.media[1]!.id, 'first'), legacyCandidate(pending, second, f.media[2]!.id, 'second')]
    writeJsonFileAtomicSecure(f.snapshotPath, pending)
    const saved = await f.service.invoke('adopt', { ...f.target, baseRevision: 2, candidateId: 'first' })
    expect(saved.candidates[1]).toMatchObject({ status: 'ready', baseRevision: 3 })
    const final = await f.service.invoke('adopt', { ...f.target, baseRevision: 3, candidateId: 'second' })
    expect(final.document.shots.map(shot => shot.mediaId)).toEqual([f.media[1]!.id, f.media[2]!.id])
  })
})
