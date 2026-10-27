import { describe, expect, it } from 'bun:test'
import type { VisualEditingDocument, VisualMedia, VisualProductionInputs, VisualProductionSnapshot } from '@dutydeck/shared'
import { buildVisualEditingPreview, selectVisualPreviewOutputs } from './editing-preview'

/** 纯数据夹具不读真实作品；两个镜头保留原源剪点和绝对音频位置。 */
function fixture() {
  /** 模拟已登记的正式画面与待审独立声音、静帧。 */
  const media: VisualMedia[] = ['old', 'new-image', 'new-audio'].map((id, index) => ({ id, hash: String(index + 1).repeat(64), kind: index === 2 ? 'audio' : 'image', mime: index === 2 ? 'audio/mpeg' : 'image/png', name: id, byteSize: 16, createdAt: 1 }))
  /** 完整快照由最小结构化数据提供，其他字段不参与预览。 */
  const snapshot: VisualProductionSnapshot = {
    document: { schemaVersion: 1, id: 'production', revision: 3, title: '预览', kind: 'film', brief: '', ratio: '9:16', fps: 24, voice: '', music: '', episodes: [{ id: 'episode', title: '第一集' }], assets: [], shots: ['shot-1', 'shot-2'].map(id => ({ id, episodeId: 'episode', title: id, duration: 4, scene: '', motion: '', dialogue: '', assetIds: [], mediaId: 'old' })), createdAt: 1, updatedAt: 1 },
    media, candidates: [], jobs: [], shotStates: {}, assetVersions: {},
  }
  for (const [index, kind] of (['image', 'audio'] as const).entries()) {
    /** 两个候选的审核结论允许失败；预览不能解除采用门禁。 */
    const draft = structuredClone(snapshot.document)
    draft.shots[1]!.outputs = { image: kind === 'image' ? 'new-image' : 'old', video: null, audio: kind === 'audio' ? 'new-audio' : null }
    snapshot.jobs.push({ id: `job-${index}`, shotId: 'shot-2', sessionId: 'session', baseRevision: 3, instruction: '调试', status: 'candidate', createdAt: 1 })
    snapshot.candidates.push({ id: `candidate-${index}`, baseRevision: 3, jobId: `job-${index}`, draft, summary: '待审素材', status: 'ready', reviewRequired: true, createdAt: 1 })
  }
  /** 模拟正式时间线源入点不为零，预览裁切不能丢失其偏移。 */
  const timeline: VisualEditingDocument = { schemaVersion: 1, id: 'timeline', productionId: 'production', episodeId: 'episode', revision: 2, baseProductionRevision: 3, duration: 8, createdAt: 1, updatedAt: 1, tracks: [{ id: 'video', kind: 'video', clips: ['shot-1', 'shot-2'].map((shotId, index) => ({ id: `clip-${index}`, source: { type: 'shot-media', shotId, mediaId: 'old', mediaHash: media[0]!.hash, shotOutputVersion: 0 }, start: index * 4, duration: 4, sourceIn: 1, sourceOut: 5, label: shotId })) }] }
  /** 请求完整四秒区间内的第二镜头两类候选。 */
  const input: VisualProductionInputs['requestPreview'] = { sessionId: 'session', productionId: 'production', episodeId: 'episode', baseRevision: 3, expectedTimelineRevision: 2, candidateIds: ['candidate-0', 'candidate-1'], range: { start: 2, end: 7 }, settings: { ratio: '9:16', fps: 24, includeVoice: true, includeMusic: false, includeCaptions: false } }
  return { snapshot, timeline, input }
}

describe('影像模块待审预览构建', () => {
  it('Given 未采用候选 When 组合范围预览 Then 替换静帧并按真实时长补声且正式版本不变', () => {
    const { snapshot, timeline, input } = fixture()
    const before = structuredClone({ snapshot, timeline })
    const selections = selectVisualPreviewOutputs(snapshot, timeline, input)
    const preview = buildVisualEditingPreview(timeline, selections, new Map([['new-audio', 1.5]]), input.range)
    expect(preview.duration).toBe(5)
    expect(preview.tracks[0]!.clips[0]).toMatchObject({ start: 0, sourceIn: 3, sourceOut: 5, duration: 2 })
    expect(preview.tracks[0]!.clips[1]).toMatchObject({ start: 2, sourceIn: 0, sourceOut: 3, duration: 3, source: { mediaId: 'new-image' } })
    expect(preview.tracks.find(track => track.kind === 'voice')!.clips[0]).toMatchObject({ start: 2, duration: 1.5, sourceIn: 0, sourceOut: 1.5, source: { mediaId: 'new-audio' } })
    expect({ snapshot, timeline }).toEqual(before)
  })

  it.each(['session', 'episode', 'revision', 'discarded', 'ambiguous', 'voice-disabled'] as const)('Given %s 越界候选 When 选择来源 Then 拒绝进入编码', reason => {
    const { snapshot, timeline, input } = fixture()
    if (reason === 'session') input.sessionId = 'other'
    if (reason === 'episode') snapshot.document.shots[1]!.episodeId = 'other'
    if (reason === 'revision') snapshot.candidates[0]!.baseRevision++
    if (reason === 'discarded') snapshot.candidates[0]!.status = 'discarded'
    if (reason === 'ambiguous') { snapshot.candidates.push({ ...snapshot.candidates[0]!, id: 'duplicate' }); input.candidateIds.push('duplicate') }
    if (reason === 'voice-disabled') input.settings.includeVoice = false
    expect(() => selectVisualPreviewOutputs(snapshot, timeline, input)).toThrow()
  })

  it('Given 带绝对偏移的声音 When 预览从声音中间开始 Then 源入点及剩余时长一并裁切', () => {
    const { snapshot, timeline, input } = fixture()
    input.range = { start: 4.5, end: 7 }
    const preview = buildVisualEditingPreview(timeline, selectVisualPreviewOutputs(snapshot, timeline, input), new Map([['new-audio', 1.5]]), input.range)
    expect(preview.tracks.find(track => track.kind === 'voice')!.clips[0]).toMatchObject({ start: 0, duration: 1, sourceIn: 0.5, sourceOut: 1.5 })
  })

  it('Given 声音过长或画面有空档 When 构建预览 Then 明确拒绝而非截断台词或错移画面', () => {
    const { snapshot, timeline, input } = fixture()
    const selections = selectVisualPreviewOutputs(snapshot, timeline, input)
    expect(() => buildVisualEditingPreview(timeline, selections, new Map([['new-audio', 5]]), input.range)).toThrow('声音长于')
    timeline.tracks[0]!.clips[1]!.start = 4.5
    expect(() => buildVisualEditingPreview(timeline, selections, new Map([['new-audio', 1]]), input.range)).toThrow('空档')
  })
})
