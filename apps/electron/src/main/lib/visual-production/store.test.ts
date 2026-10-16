import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync, symlinkSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { VisualProductionDraft } from '@proma/shared'
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
