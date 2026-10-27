import { describe, expect, it } from 'bun:test'
import { applyVisualEditingOperations, parseVisualEditingDocument, parseVisualEditingExportSettings, parseVisualEditingOperation } from './visual-editing'
import type { VisualEditingDocument } from './visual-editing'

/** 构造包含画面和字幕的最小时间线，测试只关注合同边界。 */
const timeline = (): VisualEditingDocument => ({
  schemaVersion: 1,
  id: 'timeline-1',
  productionId: 'production-1',
  episodeId: 'episode-1',
  revision: 1,
  baseProductionRevision: 2,
  tracks: [
    { id: 'video', kind: 'video', clips: [{ id: 'clip-1', source: { type: 'shot-media', shotId: 'shot-1', mediaId: 'media-1', mediaHash: 'a'.repeat(64), shotOutputVersion: 1 }, start: 0, duration: 3, sourceIn: 0, sourceOut: 3, label: '开场' }, { id: 'clip-2', source: { type: 'shot-media', shotId: 'shot-2', mediaId: 'media-2', mediaHash: 'b'.repeat(64), shotOutputVersion: 1 }, start: 3, duration: 2, sourceIn: 0, sourceOut: 2, label: '转场' }] },
    { id: 'caption', kind: 'caption', clips: [{ id: 'caption-1', start: 0, duration: 2, sourceIn: 0, sourceOut: 2, label: '字幕', caption: { text: '光，陪你开始平凡的一天。' } }] },
  ],
  duration: 5,
  createdAt: 1,
  updatedAt: 2,
})

describe('影像剪辑时间线合同', () => {
  it('Given 已有剪点 When 替换来源 Then 仅更新指定片段来源且输入和其他轨道不变', () => {
    /** 原始时间线与可信来源合同。 */
    const original = timeline()
    const source = { type: 'shot-media' as const, shotId: 'shot-1', mediaId: 'video-new', mediaHash: 'c'.repeat(64), shotOutputVersion: 2 }
    const operation = parseVisualEditingOperation({ type: 'replaceClipSource', trackId: 'video', clipId: 'clip-1', source })
    const next = applyVisualEditingOperations(original, [operation])
    expect(next.tracks[0]!.clips[0]).toEqual({ ...original.tracks[0]!.clips[0]!, source })
    expect(next.tracks[0]!.clips[1]).toEqual(original.tracks[0]!.clips[1])
    expect(next.tracks[1]).toEqual(original.tracks[1])
    expect(original.tracks[0]!.clips[0]!.source!.mediaId).toBe('media-1')
    expect(() => parseVisualEditingOperation({ ...operation, source: { ...source, path: '/tmp/untrusted' } })).toThrow()
    expect(() => applyVisualEditingOperations(original, [{ ...operation, trackId: 'caption', clipId: 'caption-1' }])).toThrow()
  })
  it('Given 合法连续片段 When 解析时间线 Then 保留来源版本和轨道顺序', () => {
    const result = parseVisualEditingDocument(timeline())
    expect(result.tracks[0]?.clips.map(clip => clip.source?.shotId)).toEqual(['shot-1', 'shot-2'])
    expect(result.tracks[0]?.clips[0]?.source?.mediaHash).toBe('a'.repeat(64))
  })

  it('Given 视频轨片段重叠 When 解析时间线 Then 拒绝重叠', () => {
    const value = timeline()
    value.tracks[0]!.clips[1]!.start = 1
    expect(() => parseVisualEditingDocument(value)).toThrow('时间线片段重叠')
  })

  it('Given 字幕片段携带媒体来源 When 解析时间线 Then 拒绝轨道字段混用', () => {
    const value = timeline()
    value.tracks[1]!.clips[0]!.source = { type: 'shot-media', shotId: 'shot-1', mediaId: 'media-1', mediaHash: 'a'.repeat(64), shotOutputVersion: 1 }
    expect(() => parseVisualEditingDocument(value)).toThrow('字幕片段字段')
  })

  it('Given 时间线总时长不足 When 解析时间线 Then 拒绝越界片段', () => {
    const value = timeline()
    value.duration = 4
    expect(() => parseVisualEditingDocument(value)).toThrow('时间线时长不足')
  })

  it('Given Agent 编辑操作 When 解析 Then 只接受有限字段和范围', () => {
    expect(parseVisualEditingOperation({ type: 'setVolume', trackId: 'music', clipId: 'clip-1', volume: 0.25 })).toEqual({ type: 'setVolume', trackId: 'music', clipId: 'clip-1', volume: 0.25 })
    expect(() => parseVisualEditingOperation({ type: 'setVolume', trackId: 'music', clipId: 'clip-1', volume: 2 })).toThrow()
    expect(() => parseVisualEditingOperation({ type: 'moveClip', trackId: 'video', clipId: 'clip-1', toIndex: 0, path: '/tmp' })).toThrow()
  })

  it('Given 正式音频来源 When 插入音频片段 Then 保留绝对起点并创建指定音轨', () => {
    const original = timeline()
    const source = { type: 'shot-media' as const, shotId: 'shot-2', mediaId: 'audio-2', mediaHash: 'd'.repeat(64), shotOutputVersion: 3 }
    const operation = parseVisualEditingOperation({ type: 'insertAudioClip', trackId: 'voice', kind: 'voice', source, start: 2.5, sourceIn: 0.2, sourceOut: 1.7, volume: 0.8, label: '镜02对白' })
    const next = applyVisualEditingOperations(original, [operation])
    expect(next.tracks.map(track => track.kind)).toEqual(['video', 'caption', 'voice'])
    expect(next.tracks[2]!.clips[0]).toMatchObject({ start: 2.5, duration: 1.5, sourceIn: 0.2, sourceOut: 1.7, volume: 0.8, label: '镜02对白', source })
    expect(next.tracks[0]!.clips).toEqual(original.tracks[0]!.clips)
  })

  it('Given 已有绝对定位音频 When 裁切或删除 Then 不重排其余音频片段', () => {
    const original = timeline()
    original.tracks.push({ id: 'voice', kind: 'voice', clips: [
      { id: 'voice-1', start: 2, duration: 2, sourceIn: 0, sourceOut: 2, label: '一', source: { type: 'shot-media', shotId: 'shot-1', mediaId: 'audio-1', mediaHash: 'e'.repeat(64), shotOutputVersion: 1 } },
      { id: 'voice-2', start: 7, duration: 1, sourceIn: 0, sourceOut: 1, label: '二', source: { type: 'shot-media', shotId: 'shot-2', mediaId: 'audio-2', mediaHash: 'f'.repeat(64), shotOutputVersion: 1 } },
    ] })
    const next = applyVisualEditingOperations(original, [{ type: 'trimClip', trackId: 'voice', clipId: 'voice-1', sourceIn: 0.5, sourceOut: 1.5 }])
    expect(next.tracks.find(track => track.id === 'voice')!.clips.map(clip => clip.start)).toEqual([2, 7])
  })

  it('Given 非法音频插入操作 When 解析或应用 Then 拒绝轨道类型、范围和重复片段身份', () => {
    const source = { type: 'shot-media' as const, shotId: 'shot-1', mediaId: 'audio-1', mediaHash: 'a'.repeat(64), shotOutputVersion: 1 }
    expect(() => parseVisualEditingOperation({ type: 'insertAudioClip', trackId: 'video', kind: 'voice', source, start: 0, sourceIn: 2, sourceOut: 1, label: '错误' })).toThrow()
    const original = timeline()
    original.tracks.push({ id: 'voice', kind: 'voice', clips: [{ id: 'fixed', start: 0, duration: 1, sourceIn: 0, sourceOut: 1, label: '已有', source }] })
    expect(() => applyVisualEditingOperations(original, [{ type: 'insertAudioClip', trackId: 'voice', kind: 'music', clipId: 'fixed', source, start: 2, sourceIn: 0, sourceOut: 1, label: '重复' }])).toThrow()
  })

  it('Given 绝对定位音轨 When 移动片段 Then 明确拒绝无效的顺序移动', () => {
    const original = timeline()
    original.tracks.push({ id: 'voice', kind: 'voice', clips: [{ id: 'voice-1', start: 2, duration: 1, sourceIn: 0, sourceOut: 1, label: '对白', source: { type: 'shot-media', shotId: 'shot-1', mediaId: 'audio-1', mediaHash: 'a'.repeat(64), shotOutputVersion: 1 } }] })
    expect(() => applyVisualEditingOperations(original, [{ type: 'moveClip', trackId: 'voice', clipId: 'voice-1', toIndex: 0 }])).toThrow('音频片段不支持顺序移动')
  })

  it('Given 有效导出设置 When 解析 Then 保留轨道开关', () => {
    expect(parseVisualEditingExportSettings({ ratio: '16:9', fps: 24, includeVoice: true, includeMusic: false, includeCaptions: true })).toEqual({ ratio: '16:9', fps: 24, includeVoice: true, includeMusic: false, includeCaptions: true })
  })

  it('Given Agent 连续编辑操作 When 应用 Then 返回新时间线并保留输入不变', () => {
    const original = timeline()
    const next = applyVisualEditingOperations(original, [
      { type: 'trimClip', trackId: 'video', clipId: 'clip-1', sourceIn: 1, sourceOut: 3 },
      { type: 'splitClip', trackId: 'video', clipId: 'clip-2', at: 1 },
      { type: 'setCaption', trackId: 'caption', text: '新的字幕', start: 2, duration: 1 },
    ])
    expect(next).not.toBe(original)
    expect(original.tracks[0]!.clips).toHaveLength(2)
    expect(next.tracks[0]!.clips).toHaveLength(3)
    expect(next.tracks[0]!.clips[0]!.sourceIn).toBe(1)
    expect(next.tracks[1]!.clips).toHaveLength(2)
  })
})
