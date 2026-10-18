import { describe, expect, it } from 'bun:test'
import type { VisualEditingDocument } from '@dutydeck/shared'
import { getNextVideoClipId } from './VisualEditingPlayback'

/** 连续播放测试使用的最小时间线，包含非画面轨道以验证只沿视频轨推进。 */
const timeline: VisualEditingDocument = {
  schemaVersion: 1,
  id: 'timeline',
  productionId: 'production',
  episodeId: 'episode',
  revision: 1,
  baseProductionRevision: 1,
  tracks: [
    { id: 'caption', kind: 'caption', clips: [{ id: 'caption-1', start: 0, duration: 2, sourceIn: 0, sourceOut: 2, label: '字幕', caption: { text: '字幕' } }] },
    { id: 'video', kind: 'video', clips: [
      { id: 'clip-a', start: 0, duration: 2, sourceIn: 0, sourceOut: 2, label: '第一镜头', source: { type: 'shot-media', shotId: 'shot-a', mediaId: 'media-a', mediaHash: 'a'.repeat(64), shotOutputVersion: 1 } },
      { id: 'clip-b', start: 2, duration: 3, sourceIn: 0, sourceOut: 3, label: '第二镜头', source: { type: 'shot-media', shotId: 'shot-b', mediaId: 'media-b', mediaHash: 'b'.repeat(64), shotOutputVersion: 1 } },
    ] },
  ],
  duration: 5,
  createdAt: 1,
  updatedAt: 1,
}

describe('影像剪辑连续播放', () => {
  it('Given 当前画面片段 When 播放结束 Then 返回下一个画面片段并在末尾停止', () => {
    expect(getNextVideoClipId(timeline, null)).toBe('clip-a')
    expect(getNextVideoClipId(timeline, 'clip-a')).toBe('clip-b')
    expect(getNextVideoClipId(timeline, 'clip-b')).toBeNull()
  })

  it('Given 当前选中的是字幕或未知片段 When 开始播放 Then 从第一个画面片段开始', () => {
    expect(getNextVideoClipId(timeline, 'caption-1')).toBe('clip-a')
    expect(getNextVideoClipId(timeline, 'missing')).toBe('clip-a')
  })
})
