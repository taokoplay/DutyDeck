import { afterEach, describe, expect, it } from 'bun:test'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { VisualEditingOperation, VisualProductionDraft } from '@dutydeck/shared'
import { VISUAL_PRODUCTION_LIMITS } from '@dutydeck/shared'
import { writeJsonFileAtomicSecure } from '../safe-file'
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
  it.each(['missing-encoder', 'bad-hash', 'concurrent-save'] as const)('Given %s When 候选预览编码 Then 真实记录终态且保留最新作品', async mode => {
    const { snapshot, projectRoot, episodeId } = await fixture()
    const draft = editable(structuredClone(snapshot.document))
    /** 同一受管不可变图片用不同媒体身份模拟候选；hash仍绑定真实字节。 */
    const image = { ...snapshot.media[0]!, id: 'candidate-image' }
    snapshot.media.push(image)
    draft.shots[0]!.outputs = { image: image.id, video: null, audio: null }
    draft.shots[0]!.mediaId = image.id
    snapshot.jobs.push({ id: 'job', sessionId: 'session', shotId: 'shot-1', baseRevision: snapshot.document.revision, instruction: '预览', status: 'candidate', createdAt: 1 })
    snapshot.candidates.push({ id: 'candidate', jobId: 'job', baseRevision: snapshot.document.revision, draft, summary: '预览', status: 'ready', createdAt: 1 })
    const bytes = Buffer.from('0000ftypisom-preview')
    const hash = createHash('sha256').update(bytes).digest('hex')
    let latest = structuredClone(snapshot)
    let savedTitle: string | undefined
    const store = new VisualEditingStore({ projectRoot, getCurrentSnapshot: () => latest,
      saveExportArtifact: (current) => { savedTitle = current.document.title },
      ...(mode === 'missing-encoder' ? {} : { renderExport: async () => {
        latest = structuredClone(snapshot)
        latest.document.title = '编码期间的新编辑'
        latest.document.revision++
        return { encoderId: 'test', artifactMedia: { id: hash, hash, name: 'preview.mp4', kind: 'video' as const, mime: 'video/mp4', byteSize: bytes.length, createdAt: 1 }, artifactBytes: mode === 'bad-hash' ? Buffer.from('0000ftypisom-tamper!') : bytes }
      } }),
    })
    const initial = store.createRoughCut(snapshot, episodeId)
    const job = await store.requestPreview(snapshot, { sessionId: 'session', productionId: snapshot.document.id, episodeId, baseRevision: snapshot.document.revision, expectedTimelineRevision: 1, candidateIds: ['candidate'], range: { start: 0, end: 4 }, settings: { ratio: '9:16', fps: 24, includeVoice: false, includeMusic: false, includeCaptions: false } })
    expect(job.status).toBe(mode === 'concurrent-save' ? 'completed' : 'failed')
    expect(savedTitle).toBe(mode === 'concurrent-save' ? '编码期间的新编辑' : undefined)
    expect(store.load(latest, episodeId).timeline).toEqual(initial.timeline)
    expect(store.listExportJobs(latest, episodeId)[0]).toEqual(job)
    if (mode !== 'concurrent-save') expect(job.artifactMediaId).toBeUndefined()
  })

  it('Given 未采用候选 When 原生审片 Then 登记真实产物且正式时间线与审核资格不变', async () => {
    const base = await fixture()
    /** 不依赖云端的已登记候选图片，使用不同内容验证实际来源。 */
    writeFileSync(join(base.projectRoot, 'candidate.png'), Buffer.from('89504e470d0a1a0a00000001', 'hex'))
    const media = await base.service.invoke('importFile', { ...base.target, relativePath: 'candidate.png' })
    const snapshot = await base.service.invoke('load', base.target)
    const draft = editable(structuredClone(snapshot.document))
    draft.shots[0]!.outputs = { image: media.id, video: null, audio: null }
    draft.shots[0]!.mediaId = media.id
    snapshot.jobs.push({ id: 'preview-job', sessionId: 'session', shotId: 'shot-1', baseRevision: snapshot.document.revision, instruction: '审片', status: 'candidate', createdAt: 1 })
    snapshot.candidates.push({ id: 'preview-candidate', jobId: 'preview-job', baseRevision: snapshot.document.revision, draft, summary: '待审', status: 'ready', reviewRequired: true, createdAt: 1 })
    /** 将合法候选快照原子保存，后续走真实服务路由及媒体登记。 */
    const snapshotPath = join(base.projectRoot, '.dutydeck', 'visual-production', 'projects', base.target.productionId, 'snapshot.json')
    writeJsonFileAtomicSecure(snapshotPath, snapshot)
    const bytes = Buffer.from('0000ftypisom-preview')
    const hash = createHash('sha256').update(bytes).digest('hex')
    let renderedMediaId = ''
    const service = new VisualProductionService({ workspaceId: 'workspace', projectRoot: base.projectRoot, renderExport: async input => {
      renderedMediaId = input.timeline.tracks[0]!.clips[0]!.source!.mediaId
      expect(input.readMedia(media.id).bytes).toEqual(Buffer.from('89504e470d0a1a0a00000001', 'hex'))
      return { encoderId: 'test', artifactMedia: { id: hash, hash, name: 'preview.mp4', kind: 'video', mime: 'video/mp4', byteSize: bytes.length, createdAt: 1 }, artifactBytes: bytes }
    } })
    const initial = await service.invoke('createRoughCut', { ...base.target, episodeId: base.episodeId, baseProductionRevision: snapshot.document.revision })
    const input = { ...base.target, episodeId: base.episodeId, baseRevision: snapshot.document.revision, expectedTimelineRevision: 1, candidateIds: ['preview-candidate'], range: { start: 1, end: 3 }, settings: { ratio: '9:16', fps: 24, includeVoice: false, includeMusic: false, includeCaptions: false } }
    const job = await service.invoke('requestPreview', input)
    expect(job).toMatchObject({ status: 'completed', artifactHash: hash, preview: { productionRevision: snapshot.document.revision, candidateIds: input.candidateIds, range: input.range } })
    expect(renderedMediaId).toBe(media.id)
    const after = await service.invoke('load', base.target)
    expect(after.document).toEqual(snapshot.document)
    expect(after.shotStates).toEqual(snapshot.shotStates)
    expect(after.candidates).toEqual(snapshot.candidates)
    expect((await service.invoke('loadTimeline', { ...base.target, episodeId: base.episodeId })).timeline).toEqual(initial.timeline)
    expect((await service.invoke('mediaContent', { ...base.target, mediaId: hash })).bytes).toEqual(bytes)
  })

  it('Given 探测期间正式版本变化 When 请求待审预览 Then 不编码也不登记任务', async () => {
    const { snapshot, projectRoot, episodeId } = await fixture()
    const draft = editable(structuredClone(snapshot.document))
    const audio = { ...snapshot.media[0]!, id: 'audio', kind: 'audio' as const, mime: 'audio/mpeg' }
    snapshot.media.push(audio)
    draft.shots[0]!.outputs = { image: snapshot.media[0]!.id, video: null, audio: audio.id }
    snapshot.jobs.push({ id: 'job', sessionId: 'session', shotId: 'shot-1', baseRevision: snapshot.document.revision, instruction: '声音', status: 'candidate', createdAt: 1 })
    snapshot.candidates.push({ id: 'candidate', jobId: 'job', baseRevision: snapshot.document.revision, draft, summary: '声音', status: 'ready', createdAt: 1 })
    let renders = 0
    const store = new VisualEditingStore({ projectRoot, getCurrentSnapshot: () => snapshot, probeDuration: async () => { snapshot.document.revision++; return 1 }, renderExport: async () => { renders++; throw new Error('不应执行') } })
    const initial = store.createRoughCut(snapshot, episodeId)
    await expect(store.requestPreview(snapshot, { sessionId: 'session', productionId: snapshot.document.id, episodeId, baseRevision: snapshot.document.revision, expectedTimelineRevision: 1, candidateIds: ['candidate'], range: { start: 0, end: 4 }, settings: { ratio: '9:16', fps: 24, includeVoice: true, includeMusic: false, includeCaptions: false } })).rejects.toThrow('版本已变化')
    expect(renders).toBe(0)
    expect(store.load(snapshot, episodeId).timeline).toEqual(initial.timeline)
    expect(store.load(snapshot, episodeId).exportJobs).toHaveLength(0)
  })

  it('Given 合法25MiB WAV副本 When 替换并探测 Then 接受base64膨胀但拒绝超预算与哈希篡改', async () => {
    /** 真实 PCM WAV，原字节合法但 JSON base64 超过旧 32MiB 读取上限。 */
    const { snapshot, projectRoot, episodeId, service, target } = await fixture()
    const bytes = Buffer.alloc(25 * 1024 * 1024)
    bytes.write('RIFF', 0); bytes.writeUInt32LE(bytes.length - 8, 4); bytes.write('WAVEfmt ', 8)
    bytes.writeUInt32LE(16, 16); bytes.writeUInt16LE(1, 20); bytes.writeUInt16LE(1, 22)
    bytes.writeUInt32LE(8000, 24); bytes.writeUInt32LE(16000, 28); bytes.writeUInt16LE(2, 32); bytes.writeUInt16LE(16, 34)
    bytes.write('data', 36); bytes.writeUInt32LE(bytes.length - 44, 40)
    writeFileSync(join(projectRoot, 'large.wav'), bytes)
    const media = await service.invoke('importFile', { ...target, relativePath: 'large.wav' })
    snapshot.media.push(media)
    snapshot.document.shots[0]!.outputs = { image: snapshot.media[0]!.id, video: null, audio: media.id }
    const store = new VisualEditingStore({ projectRoot })
    const initial = store.createRoughCut(snapshot, episodeId)
    const clip = initial.timeline!.tracks[1]!.clips[0]!
    const operation: VisualEditingOperation = { type: 'replaceClipSource', trackId: 'voice', clipId: clip.id, source: { ...clip.source! } }
    const candidate = await store.propose(snapshot, episodeId, 1, [operation], '大媒体探测', 'session')
    expect(candidate.status).toBe('ready')
    media.byteSize = VISUAL_PRODUCTION_LIMITS.mediaBytes + 1
    await expect(store.propose(snapshot, episodeId, 1, [operation], '超预算', 'session')).rejects.toThrow('预算')
    media.byteSize = bytes.length
    /** 同长度篡改仍须被真实内容 SHA-256 拦住。 */
    bytes[bytes.length - 1] = 1
    const path = join(projectRoot, '.dutydeck', 'visual-production', 'projects', snapshot.document.id, 'media', `${media.hash}.json`)
    writeJsonFileAtomicSecure(path, { hash: media.hash, data: bytes.toString('base64') })
    await expect(store.propose(snapshot, episodeId, 1, [operation], '篡改媒体', 'session')).rejects.toThrow('hash')
  })
  it('Given 毫秒精度媒体时长 When 使用24fps末帧边界 Then 允许亚毫秒舍入但拒绝多出一帧', async () => {
    /** 158 帧在 24fps 下的精确边界可能比毫秒元数据多 0.333ms。 */
    const { snapshot, projectRoot, episodeId } = await fixture()
    const store = new VisualEditingStore({ projectRoot, probeDuration: async () => 6.583 })
    const initial = store.createRoughCut(snapshot, episodeId)
    const clip = initial.timeline!.tracks[0]!.clips[0]!
    snapshot.media.push({ ...snapshot.media[0]!, id: 'video', kind: 'video', mime: 'video/mp4' })
    snapshot.document.shots[0]!.outputs = { image: null, video: 'video', audio: null }
    const operation: VisualEditingOperation = { type: 'replaceClipSource', trackId: 'video', clipId: clip.id, source: { ...clip.source!, mediaId: 'video' } }
    const candidate = await store.propose(snapshot, episodeId, 1, [operation, { type: 'trimClip', trackId: 'video', clipId: clip.id, sourceIn: 30 / 24, sourceOut: 158 / 24 }], '帧边界', 'session')
    expect(candidate.timeline.tracks[0]!.clips[0]!.sourceOut).toBe(158 / 24)
    await expect(store.propose(snapshot, episodeId, 1, [operation, { type: 'trimClip', trackId: 'video', clipId: clip.id, sourceIn: 0, sourceOut: 159 / 24 }], '越界一帧', 'session')).rejects.toThrow('时长不足')
  })
  it('Given 新视频短于旧剪点 When 替换及同批裁短 Then 越界拒绝且有效裁短可采用', async () => {
    /** 探测依赖返回真实流时长的测试替身，不增加持久化时长字段。 */
    const { snapshot, projectRoot, episodeId } = await fixture()
    let probes = 0
    const store = new VisualEditingStore({ projectRoot, probeDuration: async () => { probes++; return 2 } })
    const initial = store.createRoughCut(snapshot, episodeId)
    const clip = initial.timeline!.tracks[0]!.clips[0]!
    const video = { ...snapshot.media[0]!, id: 'new-video', kind: 'video' as const, mime: 'video/mp4' }
    snapshot.media.push(video)
    snapshot.document.shots[0]!.outputs = { image: snapshot.media[0]!.id, video: video.id, audio: null }
    snapshot.shotStates['shot-1']!.outputVersion++
    const operation: VisualEditingOperation = { type: 'replaceClipSource', trackId: 'video', clipId: clip.id, source: { ...clip.source!, mediaId: video.id, mediaHash: video.hash, shotOutputVersion: snapshot.shotStates['shot-1']!.outputVersion } }
    await expect(store.propose(snapshot, episodeId, 1, [operation], '短片替换', 'session')).rejects.toThrow('时长不足')
    expect(store.load(snapshot, episodeId).candidates).toHaveLength(0)
    const candidate = await store.propose(snapshot, episodeId, 1, [operation, { type: 'trimClip', trackId: 'video', clipId: clip.id, sourceIn: 0, sourceOut: 2 }], '显式裁短', 'session')
    const adopted = await store.adopt(snapshot, episodeId, candidate.id, 1)
    expect(adopted.timeline!.tracks[0]!.clips[0]).toMatchObject({ duration: 2, sourceOut: 2, source: { mediaId: video.id } })
    expect(probes).toBe(3)
    /** 视频已采用后，不允许退回同镜头静帧绕过画面优先级。 */
    await expect(store.propose(snapshot, episodeId, 2, [{ ...operation, source: { ...operation.source, mediaId: snapshot.media[0]!.id } }], '退回静帧', 'session')).rejects.toThrow('当前已采用')
  })

  it('Given 音轨当前正式音频 When 替换 Then 仅更新音轨并拒绝画面媒体和跨集来源', async () => {
    /** 独立音轨与画面共存，替换不能污染画面绑定。 */
    const { snapshot, projectRoot, episodeId } = await fixture()
    const image = snapshot.media[0]!
    snapshot.media.push({ ...image, id: 'audio-old', kind: 'audio', mime: 'audio/wav' }, { ...image, id: 'audio-new', kind: 'audio', mime: 'audio/wav' })
    snapshot.document.shots[0]!.outputs = { image: image.id, video: null, audio: 'audio-old' }
    const store = new VisualEditingStore({ projectRoot, probeDuration: async () => 6 })
    const initial = store.createRoughCut(snapshot, episodeId)
    const clip = initial.timeline!.tracks[1]!.clips[0]!
    snapshot.document.shots[0]!.outputs!.audio = 'audio-new'
    const operation: VisualEditingOperation = { type: 'replaceClipSource', trackId: 'voice', clipId: clip.id, source: { ...clip.source!, mediaId: 'audio-new' } }
    await expect(store.propose(snapshot, episodeId, 1, [{ ...operation, source: { ...operation.source, mediaId: image.id } }], '错误类别', 'session')).rejects.toThrow()
    const candidate = await store.propose(snapshot, episodeId, 1, [operation], '更新音轨', 'session')
    const adopted = await store.adopt(snapshot, episodeId, candidate.id, 1)
    expect(adopted.timeline!.tracks[0]).toEqual(initial.timeline!.tracks[0])
    expect(adopted.timeline!.tracks[1]!.clips[0]!.source!.mediaId).toBe('audio-new')
    snapshot.document.shots[0]!.episodeId = 'other-episode'
    await expect(store.propose(snapshot, episodeId, 2, [operation], '跨集来源', 'session')).rejects.toThrow()
  })

  it('Given 当前集已采用音频 When 插入带偏移的音频片段 Then 只新增音轨片段并保留视频剪点', async () => {
    const { snapshot, projectRoot, episodeId } = await fixture()
    const image = snapshot.media[0]!
    const audio = { ...image, id: 'audio-insert', kind: 'audio' as const, mime: 'audio/wav' }
    snapshot.media.push(audio)
    snapshot.document.shots[0]!.outputs = { image: image.id, video: null, audio: audio.id }
    const store = new VisualEditingStore({ projectRoot, probeDuration: async () => 4 })
    const initial = store.createRoughCut(snapshot, episodeId)
    const videoBefore = structuredClone(initial.timeline!.tracks[0]!.clips)
    const source = { type: 'shot-media' as const, shotId: 'shot-1', mediaId: audio.id, mediaHash: audio.hash, shotOutputVersion: snapshot.shotStates['shot-1']!.outputVersion }
    const candidate = await store.propose(snapshot, episodeId, 1, [{ type: 'insertAudioClip', trackId: 'music', kind: 'music', source, start: 2.25, sourceIn: 0.5, sourceOut: 2, label: '苏醒环境声' }], '插入环境声', 'session')
    expect(candidate.timeline.tracks[0]!.clips).toEqual(videoBefore)
    expect(candidate.timeline.tracks.find(track => track.kind === 'music')!.clips[0]).toMatchObject({ start: 2.25, duration: 1.5, source })
  })

  it.each(['propose', 'adopt'] as const)('Given 探测期间正式输出变化 When %s Then 拒绝竞态并保留旧时间线', async phase => {
    /** 重读依赖模拟另一运行已经采用新来源。 */
    const { snapshot, projectRoot, episodeId } = await fixture()
    let changeDuringProbe = false
    const store = new VisualEditingStore({ projectRoot, getCurrentSnapshot: () => snapshot, probeDuration: async () => { if (changeDuringProbe) snapshot.shotStates['shot-1']!.outputVersion++; return 6 } })
    const initial = store.createRoughCut(snapshot, episodeId)
    const clip = initial.timeline!.tracks[0]!.clips[0]!
    snapshot.media.push({ ...snapshot.media[0]!, id: 'video', kind: 'video', mime: 'video/mp4' })
    snapshot.document.shots[0]!.outputs = { image: null, video: 'video', audio: null }
    const operation: VisualEditingOperation = { type: 'replaceClipSource', trackId: 'video', clipId: clip.id, source: { ...clip.source!, mediaId: 'video' } }
    if (phase === 'propose') {
      changeDuringProbe = true
      await expect(store.propose(snapshot, episodeId, 1, [operation], '替换', 'session')).rejects.toThrow('过期')
    } else {
      const candidate = await store.propose(snapshot, episodeId, 1, [operation], '替换', 'session')
      changeDuringProbe = true
      await expect(store.adopt(snapshot, episodeId, candidate.id, 1)).rejects.toThrow('过期')
    }
    expect(store.load(snapshot, episodeId).timeline).toEqual(initial.timeline)
  })

  it('Given 探测期间时间线更新 When 提案提交 Then CAS拒绝且保留并发修改', async () => {
    /** store直接调用绕过service锁，以验证最终原子CAS仍有效。 */
    const { snapshot, projectRoot, episodeId } = await fixture()
    const store = new VisualEditingStore({ projectRoot, probeDuration: async () => {
      const current = store.load(snapshot, episodeId).timeline!
      store.save(snapshot, episodeId, 1, { ...current, revision: 2 })
      return 6
    } })
    const initial = store.createRoughCut(snapshot, episodeId)
    const clip = initial.timeline!.tracks[0]!.clips[0]!
    snapshot.media.push({ ...snapshot.media[0]!, id: 'video', kind: 'video', mime: 'video/mp4' })
    snapshot.document.shots[0]!.outputs = { image: null, video: 'video', audio: null }
    await expect(store.propose(snapshot, episodeId, 1, [{ type: 'replaceClipSource', trackId: 'video', clipId: clip.id, source: { ...clip.source!, mediaId: 'video' } }], '替换', 'session')).rejects.toThrow()
    expect(store.load(snapshot, episodeId).timeline!.revision).toBe(2)
    expect(store.load(snapshot, episodeId).candidates).toHaveLength(0)
  })
  it('Given 同镜头采用新图片 When 提案再采用替换 Then 保留剪点其他镜头和候选历史', async () => {
    /** 真实磁盘时间线；新来源只能由当前正式镜头输出提供。 */
    const { snapshot, projectRoot, episodeId } = await fixture()
    snapshot.document.shots.push({ ...snapshot.document.shots[0]!, id: 'shot-2' })
    const store = new VisualEditingStore({ projectRoot })
    const initial = store.createRoughCut(snapshot, episodeId)
    const clip = initial.timeline!.tracks[0]!.clips[0]!
    const media = { ...snapshot.media[0]!, id: 'new-image', hash: 'b'.repeat(64) }
    snapshot.media.push(media)
    snapshot.document.shots[0]!.outputs = { image: media.id, video: null, audio: null }
    snapshot.shotStates['shot-1']!.outputVersion++
    const operation: VisualEditingOperation = { type: 'replaceClipSource', trackId: 'video', clipId: clip.id, source: { ...clip.source!, mediaId: media.id, mediaHash: media.hash, shotOutputVersion: snapshot.shotStates['shot-1']!.outputVersion } }
    const candidate = await store.propose(snapshot, episodeId, 1, [operation], '更新正式来源', 'session')
    expect(store.load(snapshot, episodeId).timeline).toEqual(initial.timeline)
    const adopted = await store.adopt(snapshot, episodeId, candidate.id, 1)
    expect(adopted.timeline!.tracks[0]!.clips[0]).toEqual({ ...clip, source: operation.source })
    expect(adopted.timeline!.tracks[0]!.clips[1]).toEqual(initial.timeline!.tracks[0]!.clips[1])
    expect(adopted.candidates[0]!.status).toBe('adopted')
    await expect(async () => await store.adopt(snapshot, episodeId, candidate.id, 1)).toThrow()
  })

  it('Given 替换来源伪造未采用或过时 When 提案及采用 Then 拒绝且正式绑定不变', async () => {
    /** 候选媒体登记不等于已采用输出。 */
    const { snapshot, projectRoot, episodeId } = await fixture()
    const store = new VisualEditingStore({ projectRoot })
    const initial = store.createRoughCut(snapshot, episodeId)
    const clip = initial.timeline!.tracks[0]!.clips[0]!
    const source = { ...clip.source! }
    snapshot.media.push({ ...snapshot.media[0]!, id: 'candidate-only' })
    for (const replacement of [{ ...source, mediaHash: 'f'.repeat(64) }, { ...source, mediaId: 'candidate-only' }, { ...source, shotOutputVersion: source.shotOutputVersion + 1 }, { ...source, shotId: 'another-shot' }]) {
      await expect(async () => await store.propose(snapshot, episodeId, 1, [{ type: 'replaceClipSource', trackId: 'video', clipId: clip.id, source: replacement }], '非法替换', 'session')).toThrow()
    }
    const candidate = await store.propose(snapshot, episodeId, 1, [{ type: 'replaceClipSource', trackId: 'video', clipId: clip.id, source }], '合法来源', 'session')
    snapshot.shotStates['shot-1']!.outputVersion++
    await expect(async () => await store.adopt(snapshot, episodeId, candidate.id, 1)).toThrow()
    expect(store.load(snapshot, episodeId).timeline).toEqual(initial.timeline)
  })
  it('Given 新旧项目均无作品 When 列表读取 Then 返回空且不创建当前目录', async () => {
    /** 两种空态分别覆盖全新项目与只有旧模块目录的项目。 */
    for (const legacy of [false, true]) {
      /** 隔离项目根只允许测试创建旧目录，不提前创建任何作品。 */
      const projectRoot = mkdtempSync(join(tmpdir(), 'visual-empty-'))
      roots.push(projectRoot)
      if (legacy) mkdirSync(join(projectRoot, '.proma', 'visual-production'), { recursive: true })
      /** 真实服务读取应保持无副作用。 */
      const service = new VisualProductionService({ workspaceId: 'workspace', projectRoot })
      expect(await service.invoke('list', { sessionId: 'session' })).toEqual([])
      expect(existsSync(join(projectRoot, '.dutydeck'))).toBe(false)
    }
  })

  it('Given 旧目录保存作品媒体和时间线 When 重建服务并继续编辑导出 Then 全链路使用旧目录且不双写', async () => {
    /** 先生成真实持久化快照和时间线，再按历史项目的目录布局重新打开。 */
    const base = await fixture()
    await base.service.invoke('createRoughCut', { ...base.target, episodeId: base.episodeId, baseProductionRevision: 2 })
    expect(existsSync(join(base.projectRoot, '.dutydeck', 'visual-production'))).toBe(true)
    renameSync(join(base.projectRoot, '.dutydeck'), join(base.projectRoot, '.proma'))
    /** 模拟编码器，同时真实读取剪辑存储提供的旧媒体字节。 */
    const bytes = Buffer.from('0000ftypisom')
    const digest = createHash('sha256').update(bytes).digest('hex')
    const service = new VisualProductionService({
      workspaceId: 'workspace', projectRoot: base.projectRoot,
      renderExport: async ({ readMedia }) => {
        expect(Buffer.from(readMedia(base.snapshot.media[0]!.id).bytes)).toEqual(Buffer.from('89504e470d0a1a0a00000000', 'hex'))
        return { encoderId: 'test-ffmpeg', artifactMedia: { id: digest, name: '成片.mp4', hash: digest, mime: 'video/mp4', kind: 'video', byteSize: bytes.length, createdAt: 1 }, artifactBytes: bytes }
      },
    })
    expect(await service.invoke('list', { sessionId: 'session' })).toMatchObject([{ id: base.target.productionId }])
    expect((await service.invoke('load', base.target)).document.revision).toBe(2)
    await service.invoke('save', { ...base.target, baseRevision: 2, draft: { ...editable(base.snapshot.document), brief: '旧项目继续编辑' } })
    expect((await service.invoke('load', base.target)).document.brief).toBe('旧项目继续编辑')
    /** 旧时间线必须被读到，否则编辑保存或导出都无法继续。 */
    const timeline = (await service.invoke('loadTimeline', { ...base.target, episodeId: base.episodeId })).timeline!
    expect(timeline.revision).toBe(1)
    await service.invoke('saveTimeline', { ...base.target, episodeId: base.episodeId, expectedRevision: 1, timeline: { ...timeline, revision: 2 } })
    const job = await service.invoke('requestExport', { ...base.target, episodeId: base.episodeId, expectedTimelineRevision: 2, settings: { ratio: '16:9', fps: 24, includeVoice: false, includeMusic: false, includeCaptions: false } })
    expect(job.status).toBe('completed')
    expect(Buffer.from((await service.invoke('mediaContent', { ...base.target, mediaId: digest })).bytes)).toEqual(bytes)
    expect(existsSync(join(base.projectRoot, '.proma', 'visual-production', 'projects', base.target.productionId, 'media', `${digest}.json`))).toBe(true)
    expect(existsSync(join(base.projectRoot, '.dutydeck'))).toBe(false)
  })

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
