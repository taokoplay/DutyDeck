import { describe, expect, test } from 'bun:test'
import type { VisualMedia, VisualShot } from '../types/visual-production'
import { mergeLegacyVisualShotOutputs, resolveVisualShotOutputs, withVisualShotOutput } from './visual-shot-outputs'
/** 按真实媒体种类建立兼容测试索引。 */
const media = new Map(['image', 'video', 'audio'].map(kind => [kind, { id: kind, kind } as VisualMedia]))
/** 旧镜头只有单一媒体引用。 */
const shot = { id: 'shot', mediaId: 'image' } as VisualShot
describe('分镜独立输出', () => {
  test('Given 旧图片 When 采用影片和音频 Then 三种素材均保留', () => {
    const result = withVisualShotOutput(withVisualShotOutput(shot, 'video', 'video', media), 'audio', 'audio', media)
    expect(resolveVisualShotOutputs(result, media)).toEqual({ image: 'image', video: 'video', audio: 'audio' })
    expect(result.mediaId).toBe('video')
  })
  test('Given 旧影片 When 解析 Then 按登记类型归类', () => {
    expect(resolveVisualShotOutputs({ ...shot, mediaId: 'video' }, media)).toEqual({ image: null, video: 'video', audio: null })
  })
})

 test('Given 旧空引用与显式清空 When 合并候选 Then 仅显式三槽清空删除输出', () => {
  const current = withVisualShotOutput(shot, 'video', 'video', media)
  expect(mergeLegacyVisualShotOutputs({ ...shot, mediaId: null }, current, media).outputs).toEqual(current.outputs)
  const explicit = { ...shot, mediaId: null, outputs: { image: null, video: null, audio: null } }
  expect(mergeLegacyVisualShotOutputs(explicit, current, media)).toEqual(explicit)
  expect(mergeLegacyVisualShotOutputs({ ...shot, mediaId: 'video' }, undefined, media).outputs).toEqual({ image: null, video: 'video', audio: null })
})
