import type { VisualEditingDocument } from '@dutydeck/shared'

/**
 * 根据当前选择找到下一个画面片段。
 * @param timeline 当前集正式时间线
 * @param selectedClipId 当前选择的片段身份，可为空或落在其他轨道
 * @returns 下一个画面片段身份；已到末尾或没有画面时返回 null
 */
export function getNextVideoClipId(timeline: VisualEditingDocument, selectedClipId: string | null): string | null {
  const videoTrack = timeline.tracks.find(track => track.kind === 'video')
  if (!videoTrack || videoTrack.clips.length === 0) return null
  const selectedIndex = selectedClipId ? videoTrack.clips.findIndex(clip => clip.id === selectedClipId) : -1
  return videoTrack.clips[selectedIndex + 1]?.id ?? null
}
