import { describe, expect, it } from 'bun:test'
import type { VisualCandidate, VisualMedia, VisualProductionSnapshot, VisualShot } from '@dutydeck/shared'
import { buildShotMediaSlots } from './shot-media-model'

/** 最小镜头资料，用于验证旧数据与三类候选的展示边界。 */
const shot: VisualShot = { id: 'shot', episodeId: 'episode', title: '镜头', duration: 3, scene: '', motion: '', dialogue: '', assetIds: [], mediaId: 'image' }
/** 媒体只使用元数据，不读取真实文件。 */
const media: VisualMedia[] = (['image', 'video', 'audio'] as const).map(kind => ({ id: kind, kind, name: `${kind}素材`, hash: kind, mime: `${kind}/test`, byteSize: 1, createdAt: 1 }))
/** 创建同一版本的旧格式候选，保留真实整份草稿结构。 */
function fixture(): VisualProductionSnapshot {
  return { document: { schemaVersion: 1, id: 'production', revision: 2, createdAt: 1, updatedAt: 1, title: '作品', kind: 'film', brief: '', ratio: '16:9', fps: 24, voice: '', music: '', episodes: [{ id: 'episode', title: '一' }], assets: [], shots: [shot] }, media, shotStates: {}, assetVersions: {}, candidates: [], jobs: [] }
}
/** 候选来自指定镜头，正式输出不会随预览变化。 */
function candidate(snapshot: VisualProductionSnapshot, kind: 'video' | 'audio', patch: Partial<VisualCandidate> = {}): VisualCandidate {
  return { id: kind, baseRevision: 2, draft: { ...snapshot.document, shots: [kind === 'audio' ? { ...shot, outputs: { image: 'image', video: null, audio: 'audio' } } : { ...shot, mediaId: kind }] }, summary: `${kind}结果`, status: 'ready', jobId: `job-${kind}`, createdAt: 2, ...patch }
}

describe('分镜独立素材位', () => {
  it('Given 旧画面和待采用影片音频 When 展示 Then 三类位置齐全且候选不冒充正式素材', () => {
    const snapshot = fixture()
    snapshot.candidates = [candidate(snapshot, 'video'), candidate(snapshot, 'audio')]
    const slots = buildShotMediaSlots(snapshot, shot)
    expect(slots.map(slot => slot.kind)).toEqual(['image', 'video', 'audio'])
    expect(slots[0]!.adopted?.id).toBe('image')
    expect(slots[1]!.adopted).toBeUndefined()
    expect(slots[1]!.preview?.id).toBe('video')
    expect(slots[1]!.candidates.map(item => item.id)).toEqual(['video'])
    expect(slots[2]!.preview?.id).toBe('audio')
    expect(snapshot.document.shots[0]!.mediaId).toBe('image')
  })
  it('Given 过期、跨镜头和未改变输出的候选 When 展示 Then 不标成可采用的新素材', () => {
    const snapshot = fixture()
    snapshot.candidates = [candidate(snapshot, 'video', { status: 'stale' }), candidate(snapshot, 'audio', { baseRevision: 1 }), candidate(snapshot, 'video', { draft: { ...snapshot.document, shots: [{ ...shot, id: 'other', mediaId: 'video' }] } })]
    expect(buildShotMediaSlots(snapshot, shot).map(slot => slot.candidates.length)).toEqual([0, 0, 0])
  })
  it('Given 已采用三类素材和新影片候选 When 展示 Then 保留正式预览并只为变化的影片计数', () => {
    const snapshot = fixture()
    const current = { ...shot, mediaId: 'video', outputs: { image: 'image', video: 'video', audio: 'audio' } }
    snapshot.document.shots = [current]
    snapshot.media.push({ ...media[1]!, id: 'video-new' })
    snapshot.candidates = [candidate(snapshot, 'video', { draft: { ...snapshot.document, shots: [{ ...current, mediaId: 'video-new', outputs: { ...current.outputs, video: 'video-new' } }] } })]
    const slots = buildShotMediaSlots(snapshot, current)
    expect(slots.map(slot => slot.adopted?.id)).toEqual(['image', 'video', 'audio'])
    expect(slots.map(slot => slot.candidates.length)).toEqual([0, 1, 0])
    expect(slots[1]!.preview?.id).toBe('video')
  })
})
