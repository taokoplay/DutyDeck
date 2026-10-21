import { afterEach, describe, expect, it } from 'bun:test'
import { createHash } from 'node:crypto'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { VisualProductionDraft } from '@dutydeck/shared'
import { VisualProductionService } from './store'
import { VisualEditingStore } from './editing-store'

/** 每个用例使用独立临时项目，避免读取真实用户数据。 */
const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })

/** 取出作品正式文档允许编辑的字段。 */
function editable(document: VisualProductionDraft): VisualProductionDraft {
  const { title, kind, brief, ratio, fps, voice, music, episodes, assets, shots } = document
  return { title, kind, brief, ratio, fps, voice, music, episodes, assets, shots }
}

/** 创建带一个已采用图片镜头的影像作品。 */
async function fixture() {
  const projectRoot = mkdtempSync(join(tmpdir(), 'visual-editing-'))
  roots.push(projectRoot)
  const service = new VisualProductionService({ workspaceId: 'workspace', projectRoot })
  const created = await service.invoke('create', { sessionId: 'session', title: '剪辑测试', kind: 'film' })
  const target = { sessionId: 'session', productionId: created.document.id }
  writeFileSync(join(projectRoot, 'shot.png'), Buffer.from('89504e470d0a1a0a00000000', 'hex'))
  const media = await service.invoke('importFile', { ...target, relativePath: 'shot.png' })
  const episodeId = created.document.episodes[0]!.id
  const draft = { ...editable(created.document), assets: [{ id: 'asset-1', name: '产品', type: '产品', description: '', locked: false, mediaId: media.id }], shots: [{ id: 'shot-1', episodeId, title: '开场镜头', duration: 4, scene: '', motion: '', dialogue: '', assetIds: ['asset-1'], mediaId: media.id }] }
  const saved = await service.invoke('save', { ...target, baseRevision: 1, draft })
  return { service, target, episodeId, snapshot: saved, projectRoot }
}

describe('影像剪辑时间线存储', () => {
  it('Given 独立画面影片音频 When 粗剪与后续音频更新 Then 音画对齐且只标记音频过期', async () => {
    const { snapshot, projectRoot, episodeId } = await fixture()
    const image = snapshot.media[0]!
    snapshot.media.push({ ...image, id: 'video', kind: 'video', mime: 'video/mp4' }, { ...image, id: 'audio', kind: 'audio', mime: 'audio/wav' }, { ...image, id: 'audio-next', kind: 'audio', mime: 'audio/wav' })
    snapshot.document.shots[0]!.outputs = { image: image.id, video: 'video', audio: 'audio' }
    snapshot.document.shots.unshift({ ...snapshot.document.shots[0]!, id: 'silent-intro', outputs: { image: image.id, video: null, audio: null } })
    const store = new VisualEditingStore({ projectRoot })
    const initial = store.createRoughCut(snapshot, episodeId)
    expect(initial.timeline!.tracks.map(track => track.kind)).toEqual(['video', 'voice'])
    expect(initial.timeline!.tracks[0]!.clips[1]!.source!.mediaId).toBe('video')
    expect(initial.timeline!.tracks[1]!.clips[0]).toMatchObject({ start: 4, duration: 4, source: { mediaId: 'audio' } })
    snapshot.document.shots[1]!.outputs!.audio = 'audio-next'
    snapshot.shotStates['shot-1']!.outputVersion++
    expect(store.load(snapshot, episodeId).needsReplacementClipIds).toEqual([initial.timeline!.tracks[1]!.clips[0]!.id])
  })
  it('Given 已采用镜头 When 建立粗剪 Then 只创建有媒体的连续画面片段', async () => {
    const { service, target, episodeId } = await fixture()
    const result = await service.invoke('createRoughCut', { ...target, episodeId, baseProductionRevision: 2 })
    expect(result.timeline?.tracks[0]?.clips).toHaveLength(1)
    expect(result.timeline?.tracks[0]?.clips[0]?.source?.shotId).toBe('shot-1')
    expect(result.timeline?.duration).toBe(4)
  })

  it('Given 时间线已保存 When 使用旧 revision 保存 Then 拒绝覆盖并保留正式版本', async () => {
    const { service, target, episodeId } = await fixture()
    const initial = await service.invoke('createRoughCut', { ...target, episodeId, baseProductionRevision: 2 })
    const next = structuredClone(initial.timeline!)
    next.revision = 2
    next.duration = 3
    next.tracks[0]!.clips[0]!.duration = 3
    next.tracks[0]!.clips[0]!.sourceOut = 3
    const saved = await service.invoke('saveTimeline', { ...target, episodeId, expectedRevision: 1, timeline: next })
    expect(saved.timeline?.revision).toBe(2)
    const stale = structuredClone(next)
    stale.revision = 2
    await expect(service.invoke('saveTimeline', { ...target, episodeId, expectedRevision: 1, timeline: stale })).rejects.toThrow('CONFLICT')
    expect((await service.invoke('loadTimeline', { ...target, episodeId })).timeline?.revision).toBe(2)
  })

  it('Given 镜头输出换成新媒体 When 读取旧时间线 Then 标记需要替换但保留旧片段', async () => {
    const { service, target, episodeId, snapshot } = await fixture()
    const initial = await service.invoke('createRoughCut', { ...target, episodeId, baseProductionRevision: 2 })
    const nextMediaBytes = Buffer.from('89504e470d0a1a0a00000001', 'hex')
    writeFileSync(join(roots[0]!, 'shot-2.png'), nextMediaBytes)
    const nextMedia = await service.invoke('importFile', { ...target, relativePath: 'shot-2.png' })
    const nextDraft = { ...editable(snapshot.document), shots: [{ ...snapshot.document.shots[0]!, mediaId: nextMedia.id }] }
    await service.invoke('save', { ...target, baseRevision: snapshot.document.revision, draft: nextDraft })
    const loaded = await service.invoke('loadTimeline', { ...target, episodeId })
    expect(loaded.timeline?.revision).toBe(initial.timeline?.revision)
    expect(loaded.needsReplacementClipIds).toHaveLength(1)
  })

  it('Given Agent 提交时间线操作 When 预览并采用候选 Then 正式时间线只在采用后递增', async () => {
    const { service, target, episodeId } = await fixture()
    const initial = await service.invoke('createRoughCut', { ...target, episodeId, baseProductionRevision: 2 })
    const candidate = await service.invoke('proposeTimelineEdit', { ...target, episodeId, expectedRevision: initial.timeline!.revision, operations: [{ type: 'trimClip', trackId: 'video', clipId: initial.timeline!.tracks[0]!.clips[0]!.id, sourceIn: 1, sourceOut: 3 }], summary: '缩短开场' })
    expect(candidate.status).toBe('ready')
    expect((await service.invoke('loadTimeline', { ...target, episodeId })).timeline?.revision).toBe(1)
    const adopted = await service.invoke('adoptTimelineEdit', { ...target, episodeId, candidateId: candidate.id, expectedRevision: 1 })
    expect(adopted.timeline?.revision).toBe(2)
    expect(adopted.timeline?.tracks[0]?.clips[0]?.sourceIn).toBe(1)
    expect(adopted.candidates[0]?.status).toBe('adopted')
  })

  it('Given 已过期候选 When 采用 Then 拒绝并保留当前时间线', async () => {
    const { service, target, episodeId } = await fixture()
    const initial = await service.invoke('createRoughCut', { ...target, episodeId, baseProductionRevision: 2 })
    const candidate = await service.invoke('proposeTimelineEdit', { ...target, episodeId, expectedRevision: initial.timeline!.revision, operations: [{ type: 'removeClip', trackId: 'video', clipId: initial.timeline!.tracks[0]!.clips[0]!.id }], summary: '删除镜头' })
    const updated = structuredClone(initial.timeline!)
    updated.revision = 2
    updated.duration = 3
    updated.tracks[0]!.clips[0]!.duration = 3
    updated.tracks[0]!.clips[0]!.sourceOut = 3
    await service.invoke('saveTimeline', { ...target, episodeId, expectedRevision: 1, timeline: updated })
    await expect(service.invoke('adoptTimelineEdit', { ...target, episodeId, candidateId: candidate.id, expectedRevision: 2 })).rejects.toThrow()
    expect((await service.invoke('loadTimeline', { ...target, episodeId })).timeline?.revision).toBe(2)
  })

  it('Given 候选基于旧时间线 When 正式时间线保存新版本 Then 读取候选显示为过期', async () => {
    const { service, target, episodeId } = await fixture()
    const initial = await service.invoke('createRoughCut', { ...target, episodeId, baseProductionRevision: 2 })
    const candidate = await service.invoke('proposeTimelineEdit', { ...target, episodeId, expectedRevision: initial.timeline!.revision, operations: [{ type: 'trimClip', trackId: 'video', clipId: initial.timeline!.tracks[0]!.clips[0]!.id, sourceIn: 1, sourceOut: 3 }], summary: '缩短开场' })
    const updated = structuredClone(initial.timeline!)
    updated.revision = 2
    updated.duration = 3
    updated.tracks[0]!.clips[0]!.duration = 3
    updated.tracks[0]!.clips[0]!.sourceOut = 3
    await service.invoke('saveTimeline', { ...target, episodeId, expectedRevision: 1, timeline: updated })
    const loaded = await service.invoke('loadTimeline', { ...target, episodeId })
    expect(loaded.candidates.find(item => item.id === candidate.id)?.status).toBe('stale')
  })

  it('Given 本机没有可用编码器 When 请求成片导出 Then 返回失败任务且没有伪造媒体', async () => {
    const { service, target, episodeId } = await fixture()
    const initial = await service.invoke('createRoughCut', { ...target, episodeId, baseProductionRevision: 2 })
    const job = await service.invoke('requestExport', { ...target, episodeId, expectedTimelineRevision: initial.timeline!.revision, settings: { ratio: '16:9', fps: 24, includeVoice: true, includeMusic: true, includeCaptions: true } })
    expect(job.status).toBe('failed')
    expect(job.artifactMediaId).toBeUndefined()
    expect(job.message).toContain('编码器')
    expect((await service.invoke('listExportJobs', { ...target, episodeId }))[0]?.status).toBe('failed')
  })

  it('Given 编码器返回真实 MP4 When 请求成片导出 Then 成片登记到影像媒体库并可读取', async () => {
    const base = await fixture()
    const bytes = Buffer.from('0000ftypisom')
    const digest = createHash('sha256').update(bytes).digest('hex')
    const service = new VisualProductionService({ projectRoot: base.projectRoot, workspaceId: 'workspace', renderExport: async () => ({ encoderId: 'test-ffmpeg', artifactMedia: { id: digest, name: '成片.mp4', hash: digest, mime: 'video/mp4', kind: 'video', byteSize: bytes.length, createdAt: 1 }, artifactBytes: bytes }) })
    const initial = await service.invoke('createRoughCut', { ...base.target, episodeId: base.episodeId, baseProductionRevision: 2 })
    const job = await service.invoke('requestExport', { ...base.target, episodeId: base.episodeId, expectedTimelineRevision: initial.timeline!.revision, settings: { ratio: '16:9', fps: 24, includeVoice: false, includeMusic: false, includeCaptions: false } })
    expect(job.status).toBe('completed')
    expect(job.artifactMediaId).toBe(digest)
    expect(Buffer.from((await service.invoke('mediaContent', { ...base.target, mediaId: digest })).bytes)).toEqual(bytes)
  })
})
