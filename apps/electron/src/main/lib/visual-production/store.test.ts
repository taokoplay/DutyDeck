import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync, symlinkSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { VisualMedia, VisualProductionDraft } from '@dutydeck/shared'
import { VisualProductionService } from './store'
/** 隔离测试项目，不读取用户数据。 */
const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })
/** 从正式文档取出允许编辑的字段。 */
function editable(document: VisualProductionDraft): VisualProductionDraft {
  const { title, kind, brief, ratio, fps, voice, music, episodes, assets, shots } = document
  return { title, kind, brief, ratio, fps, voice, music, episodes, assets, shots }
}
/** 创建独立服务及首个作品。 */
async function fixture() {
  const projectRoot = mkdtempSync(join(tmpdir(), 'visual-production-')); roots.push(projectRoot)
  const service = new VisualProductionService({ workspaceId: 'workspace', projectRoot })
  const snapshot = await service.invoke('create', { sessionId: 'session', title: '测试作品', kind: 'film' })
  const target = { sessionId: 'session', productionId: snapshot.document.id }
  return { service, snapshot, target, projectRoot }
}
describe('Given 独立影像作品', () => {
  test('When 保存正式设定 Then 递增版本且拒绝旧基线', async () => {
    const { service, snapshot, target } = await fixture()
    const saved = await service.invoke('save', { ...target, baseRevision: 1, draft: { ...editable(snapshot.document), brief: '新目标' } })
    expect(saved.document.revision).toBe(2)
    await expect(service.invoke('save', { ...target, baseRevision: 1, draft: editable(snapshot.document) })).rejects.toThrow('CONFLICT')
  })
  test('When 取消任务 Then 迟到候选不能登记', async () => {
    const { service, snapshot, target } = await fixture()
    const job = await service.invoke('beginJob', { ...target, baseRevision: 1, instruction: '制作' })
    await service.invoke('cancelJob', { ...target, jobId: job.id })
    await expect(service.invoke('propose', { ...target, baseRevision: 1, jobId: job.id, draft: editable(snapshot.document), summary: '候选' })).rejects.toThrow()
    expect((await service.invoke('load', target)).candidates).toHaveLength(0)
  })
  test('When 登记和采纳候选 Then 采纳前正式文档不变且仅采纳递增版本', async () => {
    const { service, snapshot, target } = await fixture()
    const job = await service.invoke('beginJob', { ...target, baseRevision: 1, instruction: '修改目标' })
    const candidate = await service.invoke('propose', { ...target, baseRevision: 1, jobId: job.id, draft: { ...editable(snapshot.document), brief: '候选目标' }, summary: '候选' })
    expect((await service.invoke('load', target)).document.brief).toBe('')
    const adopted = await service.invoke('adopt', { ...target, baseRevision: 1, candidateId: candidate.id })
    expect(adopted.document.brief).toBe('候选目标')
    expect(adopted.document.revision).toBe(2)
    expect(adopted.candidates[0]?.status).toBe('adopted')
  })
})

describe('Given 资产与镜头制作依赖', () => {
  test('When Agent 修改锁定资产或单镜头范围外内容 Then 拒绝候选', async () => {
    const { service, snapshot, target } = await fixture()
    const draft = { ...editable(snapshot.document), assets: [{ id: 'asset', name: '角色', type: '角色' as const, description: '原描述', locked: true, mediaId: null }], shots: [{ id: 'shot', episodeId: snapshot.document.episodes[0]!.id, title: '镜头', duration: 5, scene: '场景', motion: '', dialogue: '', assetIds: ['asset'], mediaId: null }] }
    await service.invoke('save', { ...target, baseRevision: 1, draft })
    const job = await service.invoke('beginJob', { ...target, baseRevision: 2, instruction: '制作', shotId: 'shot' })
    await expect(service.invoke('propose', { ...target, baseRevision: 2, jobId: job.id, draft: { ...draft, assets: [{ ...draft.assets[0]!, description: '偷改' }] }, summary: '修改' })).rejects.toThrow('锁定')
    await expect(service.invoke('propose', { ...target, baseRevision: 2, jobId: job.id, draft: { ...draft, brief: '越界修改' }, summary: '修改' })).rejects.toThrow('单镜头')
    await expect(service.invoke('propose', { ...target, sessionId: 'other', baseRevision: 2, jobId: job.id, draft, summary: '修改' })).rejects.toThrow('会话')
  })
  test('When 正式版本更新 Then 旧候选和运行任务失效', async () => {
    const { service, snapshot, target } = await fixture()
    const job = await service.invoke('beginJob', { ...target, baseRevision: 1, instruction: '制作' })
    const pending = await service.invoke('beginJob', { ...target, baseRevision: 1, instruction: '并行制作' })
    const candidate = await service.invoke('propose', { ...target, baseRevision: 1, jobId: job.id, draft: editable(snapshot.document), summary: '候选' })
    const saved = await service.invoke('save', { ...target, baseRevision: 1, draft: { ...editable(snapshot.document), brief: '新设定' } })
    expect(saved.candidates[0]?.status).toBe('stale')
    expect(saved.jobs.find(item => item.id === pending.id)?.status).toBe('interrupted')
    await expect(service.invoke('adopt', { ...target, baseRevision: 2, candidateId: candidate.id })).rejects.toThrow()
  })
})


describe('Given 作品独立媒体与受管文件', () => {
  test('When 导入媒体后来源删除 Then 副本仍可读取且正式版本不变', async () => {
    const { service, snapshot, target, projectRoot } = await fixture()
    const bytes = Buffer.from('89504e470d0a1a0a00000000', 'hex')
    writeFileSync(join(projectRoot, 'image.png'), bytes)
    const media = await service.invoke('importFile', { ...target, relativePath: 'image.png' })
    rmSync(join(projectRoot, 'image.png'))
    expect(Buffer.from((await service.invoke('mediaContent', { ...target, mediaId: media.id })).bytes)).toEqual(bytes)
    expect((await service.invoke('load', target)).document.revision).toBe(1)
    const draft = { ...editable(snapshot.document), assets: [{ id: 'asset', name: '产品', type: '产品', description: '第一版', locked: false, mediaId: media.id }], shots: [{ id: 'shot', episodeId: snapshot.document.episodes[0]!.id, title: '镜头', duration: 4, scene: '', motion: '', dialogue: '', assetIds: ['asset'], mediaId: media.id }] }
    const initial = await service.invoke('save', { ...target, baseRevision: 1, draft })
    expect(initial.shotStates.shot).toEqual({ revision: 1, outputVersion: 1, needsUpdate: false })
    const changed = await service.invoke('save', { ...target, baseRevision: 2, draft: { ...draft, assets: [{ ...draft.assets[0]!, description: '第二版' }] } })
    expect(changed.shotStates.shot?.needsUpdate).toBe(true)
    expect(changed.document.shots[0]?.mediaId).toBe(media.id)
    expect(changed.assetVersions.asset).toBe(2)
  })
  test('When 读取链接或越界来源 Then 拒绝且不登记媒体', async () => {
    const { service, target, projectRoot } = await fixture()
    writeFileSync(join(projectRoot, 'image.png'), Buffer.from('89504e470d0a1a0a00000000', 'hex'))
    symlinkSync(join(projectRoot, 'image.png'), join(projectRoot, 'linked.png'))
    await expect(service.invoke('importFile', { ...target, relativePath: 'linked.png' })).rejects.toThrow()
    await expect(service.invoke('importFile', { ...target, relativePath: '../image.png' })).rejects.toThrow()
    expect((await service.invoke('load', target)).media).toHaveLength(0)
  })
  test('When 快照损坏 Then 报错而不静默重置', async () => {
    const { service, target, projectRoot } = await fixture()
    writeFileSync(join(projectRoot, '.proma', 'visual-production', 'projects', target.productionId, 'snapshot.json'), '{broken')
    await expect(service.invoke('load', target)).rejects.toThrow()
    await expect(service.invoke('list', { sessionId: 'session' })).rejects.toThrow()
  })
})


test('Given 损坏任务索引 When 读取作品 Then 拒绝不可信运行状态', async () => {
  const { service, target, projectRoot } = await fixture()
  const path = join(projectRoot, '.proma', 'visual-production', 'projects', target.productionId, 'snapshot.json')
  const snapshot = JSON.parse(readFileSync(path, 'utf8'))
  snapshot.jobs = [{ id: 'job', sessionId: 'session', status: 'running', baseRevision: -1 }]
  writeFileSync(path, JSON.stringify(snapshot))
  await expect(service.invoke('load', target)).rejects.toThrow('任务索引损坏')
})

test('Given 同一版本两个客户端 When 同时保存 Then 只允许一次正式提交', async () => {
  const { service, snapshot, target } = await fixture()
  const outcomes = await Promise.allSettled([
    service.invoke('save', { ...target, baseRevision: 1, draft: { ...editable(snapshot.document), brief: 'A' } }),
    service.invoke('save', { ...target, baseRevision: 1, draft: { ...editable(snapshot.document), brief: 'B' } }),
  ])
  expect(outcomes.filter(item => item.status === 'fulfilled')).toHaveLength(1)
  expect((await service.invoke('load', target)).document.revision).toBe(2)
})

test('Given 单镜头任务 When 通过候选重排目标镜头 Then 拒绝范围外顺序变化', async () => {
  const { service, snapshot, target } = await fixture()
  const shot = { id: 'shot1', episodeId: snapshot.document.episodes[0]!.id, title: '镜头', duration: 4, scene: '', motion: '', dialogue: '', assetIds: [], mediaId: null }
  const draft = { ...editable(snapshot.document), shots: [shot, { ...shot, id: 'shot2' }] }
  await service.invoke('save', { ...target, baseRevision: 1, draft })
  const job = await service.invoke('beginJob', { ...target, baseRevision: 2, instruction: '修改镜头', shotId: 'shot1' })
  await expect(service.invoke('propose', { ...target, baseRevision: 2, jobId: job.id, draft: { ...draft, shots: [...draft.shots].reverse() }, summary: '重排' })).rejects.toThrow('单镜头')
})

test('Given 已导入音频 When 将音频作为正式镜头画面 Then 拒绝引用', async () => {
  const { service, snapshot, target, projectRoot } = await fixture()
  writeFileSync(join(projectRoot, 'voice.wav'), Buffer.from('RIFF0000WAVE0000'))
  const media = await service.invoke('importFile', { ...target, relativePath: 'voice.wav' })
  const shot = { id: 'shot', episodeId: snapshot.document.episodes[0]!.id, title: '镜头', duration: 4, scene: '', motion: '', dialogue: '', assetIds: [], mediaId: media.id }
  await expect(service.invoke('save', { ...target, baseRevision: 1, draft: { ...editable(snapshot.document), shots: [shot] } })).rejects.toThrow('镜头媒体')
})

test('Given 图片作品与视频素材 When 将视频作为图片输出 Then 拒绝引用', async () => {
  const { service, snapshot, target, projectRoot } = await fixture()
  writeFileSync(join(projectRoot, 'clip.mp4'), Buffer.from('0000ftypisom0000'))
  const media = await service.invoke('importFile', { ...target, relativePath: 'clip.mp4' })
  const shot = { id: 'shot', episodeId: snapshot.document.episodes[0]!.id, title: '图片', duration: 0, scene: '', motion: '', dialogue: '', assetIds: [], mediaId: media.id }
  await expect(service.invoke('save', { ...target, baseRevision: 1, draft: { ...editable(snapshot.document), kind: 'image', shots: [shot] } })).rejects.toThrow('镜头媒体')
})

test('Given 单镜头任务 When 将目标移动到其他集 Then 拒绝越界候选', async () => {
  const { service, snapshot, target } = await fixture()
  const shot = { id: 'shot', episodeId: snapshot.document.episodes[0]!.id, title: '镜头', duration: 4, scene: '', motion: '', dialogue: '', assetIds: [], mediaId: null }
  const draft = { ...editable(snapshot.document), episodes: [...snapshot.document.episodes, { id: 'episode2', title: '第二集' }], shots: [shot] }
  await service.invoke('save', { ...target, baseRevision: 1, draft })
  const job = await service.invoke('beginJob', { ...target, baseRevision: 2, instruction: '修改镜头', shotId: 'shot' })
  await expect(service.invoke('propose', { ...target, baseRevision: 2, jobId: job.id, draft: { ...draft, shots: [{ ...shot, episodeId: 'episode2' }] }, summary: '跨集' })).rejects.toThrow('单镜头')
})

test('Given 磁盘媒体元数据类型被改坏 When 读取作品 Then 拒绝损坏索引', async () => {
  const { service, target, projectRoot } = await fixture()
  writeFileSync(join(projectRoot, 'image.png'), Buffer.from('89504e470d0a1a0a00000000', 'hex'))
  await service.invoke('importFile', { ...target, relativePath: 'image.png' })
  const path = join(projectRoot, '.proma', 'visual-production', 'projects', target.productionId, 'snapshot.json')
  const snapshot = JSON.parse(readFileSync(path, 'utf8'))
  snapshot.media[0].kind = 'audio'
  writeFileSync(path, JSON.stringify(snapshot))
  await expect(service.invoke('load', target)).rejects.toThrow('媒体索引损坏')
})

test('Given 候选历史达到上限 When 丢弃旧候选后继续生成 Then 裁剪终态并允许继续', async () => {
  const { service, snapshot, target } = await fixture()
  for (let index = 0; index < 33; index++) {
    const job = await service.invoke('beginJob', { ...target, baseRevision: 1, instruction: '生成' })
    const candidate = await service.invoke('propose', { ...target, baseRevision: 1, jobId: job.id, draft: editable(snapshot.document), summary: '候选' })
    await service.invoke('discardCandidate', { ...target, candidateId: candidate.id })
  }
  expect((await service.invoke('load', target)).candidates.length).toBeLessThanOrEqual(32)
})

test('Given 任务历史达到上限 When 已失败后继续发起 Then 裁剪终态并允许继续', async () => {
  const { service, target } = await fixture()
  for (let index = 0; index < 101; index++) {
    const job = await service.invoke('beginJob', { ...target, baseRevision: 1, instruction: '生成' })
    await service.invoke('failJob', { ...target, jobId: job.id, message: '失败' })
  }
  expect((await service.invoke('load', target)).jobs.length).toBeLessThanOrEqual(100)
})

/** 建立三镜头、正式引用与未绑定素材，验证真实范围边界。 */
async function loopFixture() {
  const context = await fixture()
  /** 正式媒体样本用于检验绑定范围与输出替换。 */
  const media: VisualMedia[] = []
  for (let index = 0; index < 4; index++) {
    writeFileSync(join(context.projectRoot, `image${index}.png`), Buffer.concat([Buffer.from('89504e470d0a1a0a00000000', 'hex'), Buffer.from([index])]))
    media.push(await context.service.invoke('importFile', { ...context.target, relativePath: `image${index}.png` }))
  }
  const draft = { ...editable(context.snapshot.document), assets: [{ id: 'asset', name: '产品', type: '产品', description: '', locked: true, mediaId: media[0]!.id }], shots: [1, 2, 3].map(index => ({ id: `shot${index}`, episodeId: context.snapshot.document.episodes[0]!.id, title: `镜头${index}`, duration: 5, scene: '', motion: '', dialogue: '', assetIds: index === 3 ? ['asset'] : [], mediaId: media[index === 3 ? 1 : 2]!.id })) }
  await context.service.invoke('save', { ...context.target, baseRevision: 1, draft })
  const job = await context.service.invoke('beginJob', { ...context.target, baseRevision: 2, instruction: '只重做第三镜头', shotId: 'shot3' })
  return { ...context, media, draft, job }
}

test('Given 第三镜头任务 When 登记替换输出 Then 仅第三镜头候选变化且采纳前正式不变', async () => {
  const { service, target, media, draft, job } = await loopFixture()
  const input = { ...target, baseRevision: 2, jobId: job.id, shotId: 'shot3', mediaId: media[3]!.id, summary: '替换第三镜头' }
  await expect(service.invoke('proposeShot', { ...input, shotId: 'shot2' })).rejects.toThrow()
  await expect(service.invoke('proposeShot', { ...input, mediaId: media[1]!.id })).rejects.toThrow()
  const candidate = await service.invoke('proposeShot', input)
  expect(candidate.draft).toEqual({ ...draft, shots: draft.shots.map(shot => shot.id === 'shot3' ? { ...shot, mediaId: media[3]!.id } : shot) })
  expect(editable((await service.invoke('load', target)).document)).toEqual(draft)
  const adopted = await service.invoke('adopt', { ...target, baseRevision: 2, candidateId: candidate.id })
  expect(adopted.document.shots).toEqual(candidate.draft.shots)
  await expect(service.invoke('updateJob', { ...target, baseRevision: 3, jobId: job.id, stage: 'generating' })).rejects.toThrow()
})

test('Given 当前运行任务 When 推进阶段 Then 拒绝倒退、跨会话、旧版本和取消后复活', async () => {
  const { service, target, job } = await loopFixture()
  const input = { ...target, baseRevision: 2, jobId: job.id, stage: 'generating' as const }
  expect((await service.invoke('updateJob', input)).stage).toBe('generating')
  await expect(service.invoke('updateJob', { ...input, stage: 'preparing' })).rejects.toThrow()
  await expect(service.invoke('updateJob', { ...input, sessionId: 'other' })).rejects.toThrow()
  await expect(service.invoke('updateJob', { ...input, baseRevision: 1 })).rejects.toThrow()
  await service.invoke('cancelJob', { ...target, jobId: job.id })
  await expect(service.invoke('updateJob', input)).rejects.toThrow()
})

test('Given 镜头参考素材 When 转为媒体工具引用 Then 仅允许目标输出及正式绑定资产', async () => {
  const { projectRoot, target, job, media } = await loopFixture()
  let calls = 0
  const service = new VisualProductionService({ workspaceId: 'workspace', projectRoot, registerReference: async ({ media: item, bytes }) => {
    calls++; expect(bytes.length).toBe(item.byteSize)
    return { assetId: 'registered', revision: 1, hash: item.hash, mediaKind: item.kind }
  } })
  const input = { ...target, baseRevision: 2, jobId: job.id, mediaId: media[0]!.id }
  expect((await service.invoke('referenceMedia', input)).hash).toBe(media[0]!.hash)
  await service.invoke('referenceMedia', { ...input, mediaId: media[1]!.id })
  for (const mediaId of [media[2]!.id, media[3]!.id]) await expect(service.invoke('referenceMedia', { ...input, mediaId })).rejects.toThrow()
  await expect(service.invoke('referenceMedia', { ...input, sessionId: 'other' })).rejects.toThrow()
  await expect(service.invoke('referenceMedia', { ...input, baseRevision: 1 })).rejects.toThrow()
  expect(calls).toBe(2)
  await service.invoke('cancelJob', { ...target, jobId: job.id })
  await expect(service.invoke('referenceMedia', input)).rejects.toThrow()
})

test('Given 登记参考进行中 When 会话失效或宿主返回错误身份 Then 不返回可用引用', async () => {
  const { projectRoot, target, job, media } = await loopFixture()
  let current = true
  const service = new VisualProductionService({ workspaceId: 'workspace', projectRoot, assertCurrent: () => { if (!current) throw new Error('会话失效') }, registerReference: async ({ media: item }) => {
    current = false
    return { assetId: 'registered', revision: 1, hash: item.hash, mediaKind: item.kind }
  } })
  const input = { ...target, baseRevision: 2, jobId: job.id, mediaId: media[0]!.id }
  await expect(service.invoke('referenceMedia', input)).rejects.toThrow('会话失效')
  const mismatched = new VisualProductionService({ workspaceId: 'workspace', projectRoot, registerReference: async () => ({ assetId: 'registered', revision: 1, hash: '0'.repeat(64), mediaKind: 'video' }) })
  await expect(mismatched.invoke('referenceMedia', input)).rejects.toThrow()
})

for (const invalidation of ['cancel', 'revision'] as const) {
  test(`Given 登记参考进行中 When 磁盘任务发生 ${invalidation} Then 迟到引用不能返回`, async () => {
    const { projectRoot, target, job, media } = await loopFixture()
    const service = new VisualProductionService({ workspaceId: 'workspace', projectRoot, registerReference: async ({ media: item }) => {
      /** 模拟锁外进程破坏或恢复替换快照，确保异步返回仍复核最新任务。 */
      const path = join(projectRoot, '.proma', 'visual-production', 'projects', target.productionId, 'snapshot.json')
      const snapshot = JSON.parse(readFileSync(path, 'utf8'))
      if (invalidation === 'cancel') snapshot.jobs[0].status = 'cancelled'
      else snapshot.document.revision++
      writeFileSync(path, JSON.stringify(snapshot))
      return { assetId: 'registered', revision: 1, hash: item.hash, mediaKind: item.kind }
    } })
    await expect(service.invoke('referenceMedia', { ...target, baseRevision: 2, jobId: job.id, mediaId: media[0]!.id })).rejects.toThrow()
  })
}

test('Given 整作品任务 When 转换其他镜头正式媒体 Then 允许但拒绝未绑定素材', async () => {
  const { projectRoot, target, media, service: original } = await loopFixture()
  const job = await original.invoke('beginJob', { ...target, baseRevision: 2, instruction: '整片制作' })
  const service = new VisualProductionService({ workspaceId: 'workspace', projectRoot, registerReference: async ({ media: item }) => ({ assetId: 'registered', revision: 1, hash: item.hash, mediaKind: item.kind }) })
  const input = { ...target, baseRevision: 2, jobId: job.id, mediaId: media[2]!.id }
  expect((await service.invoke('referenceMedia', input)).hash).toBe(media[2]!.hash)
  await expect(service.invoke('referenceMedia', { ...input, mediaId: media[3]!.id })).rejects.toThrow()
  await service.invoke('failJob', { ...target, jobId: job.id, message: '模型失败' })
  await expect(service.invoke('updateJob', { ...target, baseRevision: 2, jobId: job.id, stage: 'generating' })).rejects.toThrow()
})

describe('Given 作品制作配置', () => {
  test('When 保存空范围 Then 独立递增配置版本并冻结到任务且拒绝旧配置版本', async () => {
    const { service, target } = await fixture()
    const saved = await service.invoke('saveMediaConfiguration', { ...target, expectedRevision: 0, entries: [], defaults: {} })
    expect(saved.document.revision).toBe(1)
    expect(saved.mediaConfiguration).toEqual({ revision: 1, entries: [], defaults: {} })
    const job = await service.invoke('beginJob', { ...target, baseRevision: 1, instruction: '制作' })
    await service.invoke('saveMediaConfiguration', { ...target, expectedRevision: 1, entries: [], defaults: {} })
    expect(job.mediaConfiguration?.revision).toBe(1)
    expect((await service.invoke('load', target)).jobs[0]?.status).toBe('running')
    await expect(service.invoke('saveMediaConfiguration', { ...target, expectedRevision: 0, entries: [], defaults: {} })).rejects.toThrow('CONFLICT')
  })
})

test('Given 制作目录 When 保存支持方案或失效项 Then 校验参数、默认和来源且允许保留失效原项', async () => {
  const { projectRoot, target } = await fixture()
  /** 隔离目录可切换可用性，不探测真实远程服务。 */
  let available = true
  const entry = { id: 'image-default', name: '图片模型', kind: 'image' as const, source: { type: 'model' as const, modelRef: 'profile:model' }, parameters: { size: '1024x1024' } }
  const service = new VisualProductionService({ workspaceId: 'workspace', projectRoot, listMediaOptions: async () => [{ ...entry, available, constraints: { parameters: [{ key: 'size', label: '尺寸', type: 'string', options: ['1024x1024'] }] } }] })
  expect(await service.invoke('mediaCatalog', target)).toHaveLength(1)
  await expect(service.invoke('saveMediaConfiguration', { ...target, expectedRevision: 0, entries: [{ ...entry, parameters: { secret: 'no' } }], defaults: {} })).rejects.toThrow('参数')
  await expect(service.invoke('saveMediaConfiguration', { ...target, expectedRevision: 0, entries: [entry], defaults: { video: entry.id } })).rejects.toThrow('默认')
  await service.invoke('saveMediaConfiguration', { ...target, expectedRevision: 0, entries: [entry], defaults: { image: entry.id } })
  available = false
  expect((await service.invoke('saveMediaConfiguration', { ...target, expectedRevision: 1, entries: [entry], defaults: {} })).mediaConfiguration?.revision).toBe(2)
  await expect(service.invoke('saveMediaConfiguration', { ...target, expectedRevision: 2, entries: [{ ...entry, name: '修改失效项' }], defaults: {} })).rejects.toThrow('不可用')
})

test('Given 冻结制作配置 When 宿主登记实际执行 Then 同身份幂等更新且拒绝未启用来源、跨会话和伪造字段', async () => {
  const { projectRoot, target } = await fixture()
  /** 模拟宿主可信回执，调用方只能提交运行身份。 */
  let modelRef = 'profile:model'
  let phase = 'prepared'
  const entry = { id: 'image-default', name: '图片模型', kind: 'image' as const, source: { type: 'model' as const, modelRef }, parameters: {} }
  const service = new VisualProductionService({ workspaceId: 'workspace', projectRoot, listMediaOptions: async () => [{ ...entry, available: true, constraints: {} }], readMediaExecution: async (_sessionId, runId, engine) => ({ runId, engine, name: '真实模型', kind: 'image', source: { type: 'model', modelRef }, parameters: {}, referenceAssets: [], phase, createdAt: 1 }) })
  await service.invoke('saveMediaConfiguration', { ...target, expectedRevision: 0, entries: [entry], defaults: {} })
  const job = await service.invoke('beginJob', { ...target, baseRevision: 1, instruction: '生成' })
  const request = { ...target, baseRevision: 1, jobId: job.id, runId: 'run', engine: 'model' as const }
  expect((await service.invoke('recordMediaExecution', request)).mediaExecutions?.[0]?.entryId).toBe(entry.id)
  phase = 'completed'
  expect((await service.invoke('recordMediaExecution', request)).mediaExecutions).toHaveLength(1)
  expect((await service.invoke('load', target)).jobs[0]?.mediaExecutions?.[0]?.phase).toBe('completed')
  await expect(service.invoke('recordMediaExecution', { ...request, sessionId: 'other' })).rejects.toThrow('会话')
  await expect(service.invoke('recordMediaExecution', { ...request, ...{ prompt: '伪造' } })).rejects.toThrow('字段')
  modelRef = 'unselected'
  await expect(service.invoke('recordMediaExecution', request)).rejects.toThrow('冻结范围')
})


test('Given 制作配置与运行记录 When 导出清单 Then 包含冻结参数和实际执行元数据', async () => {
  const { projectRoot, target } = await fixture()
  const entry = { id: 'model', name: '图片', kind: 'image' as const, source: { type: 'model' as const, modelRef: 'profile:model' }, parameters: { size: 'small' } }
  let available = true
  const service = new VisualProductionService({ workspaceId: 'workspace', projectRoot, listMediaOptions: async () => [{ ...entry, available, constraints: { parameters: [{ key: 'size', label: '尺寸', type: 'string' }] } }], readMediaExecution: async (_sessionId, runId, engine) => ({ runId, engine, name: '图片', kind: 'image', source: entry.source, parameters: { size: 'small' }, referenceAssets: [], phase: 'succeeded', createdAt: 1 }) })
  await service.invoke('saveMediaConfiguration', { ...target, expectedRevision: 0, entries: [entry], defaults: { image: entry.id } })
  const job = await service.invoke('beginJob', { ...target, baseRevision: 1, instruction: '生成' })
  await service.invoke('saveMediaConfiguration', { ...target, expectedRevision: 1, entries: [{ ...entry, parameters: { size: 'large' } }], defaults: { image: entry.id } })
  available = false
  const saved = await service.invoke('saveMediaConfiguration', { ...target, expectedRevision: 2, entries: [{ ...entry, parameters: { size: 'large' } }], defaults: { image: entry.id } })
  expect(saved.jobs[0]?.mediaConfiguration?.entries[0]?.parameters.size).toBe('small')
  expect(saved.mediaConfiguration?.defaults.image).toBe(entry.id)
  await service.invoke('recordMediaExecution', { ...target, baseRevision: 1, jobId: job.id, runId: 'run', engine: 'model' })
  const manifest = JSON.parse((await service.invoke('exportManifest', target)).json)
  expect(manifest.mediaConfiguration.entries[0].parameters.size).toBe('large')
  expect(manifest.jobs[0].mediaExecutions[0].parameters.size).toBe('small')
})

test('Given 作品启用 ComfyUI 服务 When Agent 选择工作流 Then 同服务允许、跨服务拒绝且记录保留精确执行来源', async () => {
  const { projectRoot, target } = await fixture()
  const entry = { id: 'comfy', name: 'Comfy服务', kind: 'image' as const, source: { type: 'connection' as const, connectionId: 'comfy.local' }, parameters: {} }
  let connectionId = 'comfy.local'
  const service = new VisualProductionService({ workspaceId: 'workspace', projectRoot, listMediaOptions: async () => [{ ...entry, available: true, constraints: {} }], readMediaExecution: async (_session, runId, engine) => ({ runId, engine, name: 'Agent选择的工作流', kind: 'image', source: { type: 'workflow', connectionId, workflowId: 'flow', workflowRevision: 3 }, parameters: { seed: 1 }, referenceAssets: [], phase: 'prepared', createdAt: 1 }) })
  await service.invoke('saveMediaConfiguration', { ...target, expectedRevision: 0, entries: [entry], defaults: { image: entry.id } })
  const job = await service.invoke('beginJob', { ...target, baseRevision: 1, instruction: 'Agent选择工作流' })
  const request = { ...target, baseRevision: 1, jobId: job.id, runId: 'run', engine: 'workflow' as const }
  const recorded = await service.invoke('recordMediaExecution', request)
  expect(recorded.mediaExecutions?.[0]?.entryId).toBe('comfy')
  expect(recorded.mediaExecutions?.[0]?.source).toMatchObject({ type: 'workflow', workflowId: 'flow', workflowRevision: 3 })
  connectionId = 'other'
  await expect(service.invoke('recordMediaExecution', request)).rejects.toThrow('冻结范围')
  await expect(service.invoke('saveMediaConfiguration', { ...target, expectedRevision: 1, entries: [{ ...entry, parameters: { seed: 3 } }], defaults: {} })).rejects.toThrow()
})

test('Given 旧作品精确工作流配置 When 查询目录 Then 只追加已保存历史版本并支持精确解析', async () => {
  const { projectRoot, target } = await fixture()
  const entry = { id: 'legacy', name: '旧工作流', kind: 'image' as const, source: { type: 'workflow' as const, connectionId: 'comfy', workflowId: 'flow', workflowRevision: 1 }, parameters: { seed: 1 } }
  const resolved: number[] = []
  let available = true
  const service = new VisualProductionService({ workspaceId: 'workspace', projectRoot, listMediaOptions: async () => [], resolveMediaWorkflow: async (source, kind) => { resolved.push(source.workflowRevision); if (!available) throw new Error('removed'); return { ...entry, source, kind, available: true, constraints: { parameters: [{ key: 'seed', label: '种子', type: 'number' }] } } } })
  expect(await service.invoke('mediaCatalog', target)).toEqual([])
  await service.invoke('saveMediaConfiguration', { ...target, expectedRevision: 0, entries: [entry], defaults: {} })
  expect((await service.invoke('mediaCatalog', target))[0]?.source).toEqual(entry.source)
  const option = await service.invoke('resolveMediaWorkflow', { ...target, source: { ...entry.source, workflowRevision: 2 }, kind: 'image' })
  expect(option.source).toMatchObject({ workflowRevision: 2 })
  expect(resolved).toEqual([1, 1, 2])
  available = false
  const invalid = await service.invoke('mediaCatalog', target)
  expect(invalid[0]?.id).toBe(entry.id)
  expect(invalid[0]?.available).toBe(false)
  await service.invoke('saveMediaConfiguration', { ...target, expectedRevision: 1, entries: [entry], defaults: {} })
})

test('Given 同时保存服务和精确工作流 When 登记执行 Then 优先匹配精确方案且拒绝未授权输出类别', async () => {
  const { projectRoot, target } = await fixture()
  const connection = { id: 'connection', name: '服务', kind: 'image' as const, source: { type: 'connection' as const, connectionId: 'comfy' }, parameters: {} }
  const workflow = { id: 'workflow', name: '精确工作流', kind: 'image' as const, source: { type: 'workflow' as const, connectionId: 'comfy', workflowId: 'flow', workflowRevision: 1 }, parameters: {} }
  let kind: 'image' | 'video' = 'image'
  const service = new VisualProductionService({ workspaceId: 'workspace', projectRoot, listMediaOptions: async () => [{ ...connection, available: true, constraints: {} }], resolveMediaWorkflow: async (source, outputKind) => ({ ...workflow, source, kind: outputKind, available: true, constraints: {} }), readMediaExecution: async (_session, runId, engine) => ({ runId, engine, name: '实际运行', kind, source: workflow.source, parameters: {}, referenceAssets: [], phase: 'prepared', createdAt: 1 }) })
  await service.invoke('saveMediaConfiguration', { ...target, expectedRevision: 0, entries: [connection, workflow], defaults: {} })
  const job = await service.invoke('beginJob', { ...target, baseRevision: 1, instruction: '生成' })
  const request = { ...target, baseRevision: 1, jobId: job.id, runId: 'run', engine: 'workflow' as const }
  expect((await service.invoke('recordMediaExecution', request)).mediaExecutions?.[0]?.entryId).toBe(workflow.id)
  kind = 'video'
  await expect(service.invoke('recordMediaExecution', request)).rejects.toThrow('冻结范围')
})
