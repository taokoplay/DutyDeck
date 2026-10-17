import { describe, expect, it } from 'bun:test'
import { parseVisualEditingDocument, parseVisualEditingExportSettings, parseVisualEditingOperation } from './visual-editing'
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

  it('Given 有效导出设置 When 解析 Then 保留轨道开关', () => {
    expect(parseVisualEditingExportSettings({ ratio: '16:9', fps: 24, includeVoice: true, includeMusic: false, includeCaptions: true })).toEqual({ ratio: '16:9', fps: 24, includeVoice: true, includeMusic: false, includeCaptions: true })
  })
})
