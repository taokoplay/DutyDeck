import { afterEach, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { parseVisualProductionDraft, resolveVisualShotOutputs } from '@dutydeck/shared'
import type { VisualProductionDraft } from '@dutydeck/shared'
import { VisualProductionService } from './store'
/** 临时项目不触及用户数据。 */
const roots: string[] = []
afterEach(() => roots.splice(0).forEach(root => rmSync(root, { recursive: true, force: true })))
/** 去除宿主身份与时间，得到合法可编辑草稿。 */
function draftOf(value: VisualProductionDraft): VisualProductionDraft {
  const { title, kind, brief, ratio, fps, voice, music, episodes, assets, shots } = value
  return { title, kind, brief, ratio, fps, voice, music, episodes, assets, shots }
}
/** 登记不同种类的真实最小媒体副本，创建已有旧图片的镜头。 */
async function fixture() {
  const root = mkdtempSync('/private/tmp/shot-independent-'); roots.push(root)
  const service = new VisualProductionService({ projectRoot: root, workspaceId: 'workspace' })
  const created = await service.invoke('create', { sessionId: 'session', title: '独立输出', kind: 'film' })
  const target = { sessionId: 'session', productionId: created.document.id }
  const media = []
  for (const [name, bytes] of [['image.png', Buffer.from('89504e470d0a1a0a00000000', 'hex')], ['video.mp4', Buffer.from('000000186674797069736f6d', 'hex')], ['audio.mp3', Buffer.from('ID3sample')], ['other.png', Buffer.from('89504e470d0a1a0a0000000001', 'hex')]] as const) {
    writeFileSync(join(root, name), bytes)
    media.push(await service.invoke('importFile', { ...target, relativePath: name }))
  }
  const draft = { ...draftOf(created.document), shots: [{ id: 'shot', episodeId: created.document.episodes[0]!.id, title: '镜头', duration: 5, scene: '', motion: '', dialogue: '', assetIds: [], mediaId: media[0]!.id }] }
  const saved = await service.invoke('save', { ...target, baseRevision: 1, draft })
  return { service, target, media, saved, draft }
}
/** 新影片候选在采用前完成最小技术与内容审核。 */
async function reviewVideo(service: VisualProductionService, target: { sessionId: string; productionId: string }, baseRevision: number, candidateId: string): Promise<void> {
  await service.invoke('reviewCandidate', { ...target, baseRevision, candidateId, review: { technical: 'passed', motion: 'passed', continuity: 'passed', conclusion: '测试影片审核通过', unchecked: ['未听完整音轨'], issues: [] } })
}

test('Given 旧图片和并行三种候选 When 依次采用影片音频画面 Then 独立合并且版本各增一次', async () => {
  const f = await fixture()
  const candidates = []
  for (const index of [1, 2, 3]) {
    const job = await f.service.invoke('beginJob', { ...f.target, baseRevision: 2, shotId: 'shot', instruction: '制作' })
    candidates.push(await f.service.invoke('proposeShot', { ...f.target, baseRevision: 2, jobId: job.id, shotId: 'shot', mediaId: f.media[index]!.id, summary: '候选' }))
  }
  await reviewVideo(f.service, f.target, 2, candidates[0]!.id)
  for (let index = 0; index < candidates.length; index++) {
    const saved = await f.service.invoke('adopt', { ...f.target, baseRevision: 2 + index, candidateId: candidates[index]!.id })
    expect(saved.shotStates.shot!.outputVersion).toBe(2 + index)
    expect(saved.document.shots[0]!.outputs?.video).toBe(f.media[1]!.id)
  }
  const result = await f.service.invoke('load', f.target)
  expect(result.document.shots[0]!.outputs).toEqual({ image: f.media[3]!.id, video: f.media[1]!.id, audio: f.media[2]!.id })
  expect(result.document.shots[0]!.mediaId).toBe(f.media[1]!.id)
})

test('Given 旧版完整影片候选 When 采用 Then 保留已有静态画面', async () => {
  const f = await fixture()
  const job = await f.service.invoke('beginJob', { ...f.target, baseRevision: 2, instruction: '影片' })
  const candidate = await f.service.invoke('propose', { ...f.target, baseRevision: 2, jobId: job.id, summary: '旧候选', draft: { ...f.draft, shots: f.draft.shots.map(shot => ({ ...shot, mediaId: f.media[1]!.id })) } })
  await reviewVideo(f.service, f.target, 2, candidate.id)
  const result = await f.service.invoke('adopt', { ...f.target, baseRevision: 2, candidateId: candidate.id })
  expect(resolveVisualShotOutputs(result.document.shots[0]!, new Map(result.media.map(media => [media.id, media])))).toEqual({ image: f.media[0]!.id, video: f.media[1]!.id, audio: null })
})

test('Given 过时画面 When 只采用音频 Then 保持需要更新状态', async () => {
  const f = await fixture()
  await f.service.invoke('save', { ...f.target, baseRevision: 2, draft: { ...f.draft, shots: f.draft.shots.map(shot => ({ ...shot, scene: '新画面设定' })) } })
  const job = await f.service.invoke('beginJob', { ...f.target, baseRevision: 3, shotId: 'shot', instruction: '配音' })
  const candidate = await f.service.invoke('proposeShot', { ...f.target, baseRevision: 3, jobId: job.id, shotId: 'shot', mediaId: f.media[2]!.id, summary: '配音' })
  const result = await f.service.invoke('adopt', { ...f.target, baseRevision: 3, candidateId: candidate.id })
  expect(result.shotStates.shot!.needsUpdate).toBe(true)
})

test('Given 独立输出 When 类型错误或跨作品引用 Then 保存拒绝且原版不变', async () => {
  const f = await fixture()
  for (const image of [f.media[1]!.id, 'foreign-media']) {
    await expect(f.service.invoke('save', { ...f.target, baseRevision: 2, draft: { ...f.draft, shots: f.draft.shots.map(shot => ({ ...shot, mediaId: image, outputs: { image, video: null, audio: null } })) } })).rejects.toThrow()
  }
  expect((await f.service.invoke('load', f.target)).document.revision).toBe(2)
  expect(() => parseVisualProductionDraft({ ...f.draft, shots: f.draft.shots.map(shot => ({ ...shot, outputs: { image: null, video: null, audio: null, extra: null } })) })).toThrow()
})

test('Given 空镜头 When 返回音频或影片 Then 始终等待采用且不自动提交', async () => {
  const f = await fixture()
  await f.service.invoke('save', { ...f.target, baseRevision: 2, draft: { ...f.draft, shots: f.draft.shots.map(shot => ({ ...shot, mediaId: null })) } })
  for (const index of [1, 2]) {
    const job = await f.service.invoke('beginJob', { ...f.target, baseRevision: 3, shotId: 'shot', instruction: '制作' })
    const candidate = await f.service.invoke('proposeShot', { ...f.target, baseRevision: 3, jobId: job.id, shotId: 'shot', mediaId: f.media[index]!.id, summary: '候选' })
    expect(candidate.status).toBe('ready')
  }
  const result = await f.service.invoke('load', f.target)
  expect(result.document.revision).toBe(3)
  expect(result.document.shots[0]!.mediaId).toBeNull()
})

test('Given 图片作品 When 独立音频槽有素材 Then 拒绝非图片输出', async () => {
  const f = await fixture()
  await expect(f.service.invoke('save', { ...f.target, baseRevision: 2, draft: { ...f.draft, kind: 'image', shots: f.draft.shots.map(shot => ({ ...shot, outputs: { image: shot.mediaId, video: null, audio: f.media[2]!.id } })) } })).rejects.toThrow('镜头媒体类型与作品不匹配')
})

test('Given 正式三槽 When 旧完整候选同时改设定和影片 Then 保留未声明画面音频', async () => {
  const f = await fixture()
  /** 正式三槽模拟已完成的镜头，不通过真实用户项目写入。 */
  const shot = { ...f.draft.shots[0]!, mediaId: f.media[1]!.id, outputs: { image: f.media[0]!.id, video: f.media[1]!.id, audio: f.media[2]!.id } }
  await f.service.invoke('save', { ...f.target, baseRevision: 2, draft: { ...f.draft, shots: [shot] } })
  /** 旧 Agent 草稿没有 outputs，但同时改动标题和画面设定。 */
  const job = await f.service.invoke('beginJob', { ...f.target, baseRevision: 3, instruction: '调整设定' })
  const legacy = { ...f.draft.shots[0]!, title: '新标题', scene: '新设定', mediaId: f.media[1]!.id }
  const candidate = await f.service.invoke('propose', { ...f.target, baseRevision: 3, jobId: job.id, summary: '旧完整草稿', draft: { ...f.draft, shots: [legacy] } })
  await reviewVideo(f.service, f.target, 3, candidate.id)
  const result = await f.service.invoke('adopt', { ...f.target, baseRevision: 3, candidateId: candidate.id })
  expect(result.document.shots[0]).toMatchObject({ title: '新标题', scene: '新设定', outputs: shot.outputs, mediaId: f.media[1]!.id })
})

test('Given 影片设定已过时 When 只更换静态画面 Then 主影片仍需更新', async () => {
  const f = await fixture()
  /** 影片是首选视觉，静态画面同时保留。 */
  const shot = { ...f.draft.shots[0]!, mediaId: f.media[1]!.id, outputs: { image: f.media[0]!.id, video: f.media[1]!.id, audio: null } }
  await f.service.invoke('save', { ...f.target, baseRevision: 2, draft: { ...f.draft, shots: [shot] } })
  await f.service.invoke('save', { ...f.target, baseRevision: 3, draft: { ...f.draft, shots: [{ ...shot, scene: '更新场景' }] } })
  const job = await f.service.invoke('beginJob', { ...f.target, baseRevision: 4, shotId: 'shot', instruction: '重画图片' })
  const candidate = await f.service.invoke('proposeShot', { ...f.target, baseRevision: 4, jobId: job.id, shotId: 'shot', mediaId: f.media[3]!.id, summary: '新图片' })
  const result = await f.service.invoke('adopt', { ...f.target, baseRevision: 4, candidateId: candidate.id })
  expect(result.shotStates.shot!.needsUpdate).toBe(true)
  expect(result.document.shots[0]!.outputs?.video).toBe(f.media[1]!.id)
})
