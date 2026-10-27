import type { VisualEditingDocument } from '@dutydeck/shared'

/** 剪辑使用源媒体的半开时间区间，单位为秒。 */
export interface ClipPlaybackRange { start: number; end: number }

/** 为单次片段播放维护结束去重；输入原生媒体事件，返回是否应推进下一片段。 */
export function createClipRangePlayback(range?: ClipPlaybackRange): {
  readonly finished: boolean
  handle: (event: 'ready' | 'play' | 'seeking' | 'timeupdate' | 'ended', media: Pick<HTMLMediaElement, 'currentTime' | 'duration' | 'paused' | 'pause'>) => boolean
} {
  /** 当前片段是否已经报告结束，暂停事件必须据此避免打断连续播放。 */
  let finished = false
  return {
    get finished() { return finished },
    handle(event, media) {
      /** 真实媒体时长优先，避免越过文件结尾。 */
      const end = range ? Math.min(range.end, Number.isFinite(media.duration) ? media.duration : range.end) : media.duration
      /** 入点同样受真实时长限制。 */
      const start = range ? Math.min(Math.max(0, range.start), end) : 0
      if (event === 'ready') { finished = false; if (range) media.currentTime = start; return false }
      if (event === 'play') {
        if (range && (media.currentTime < start || media.currentTime >= end)) media.currentTime = start
        finished = false
        return false
      }
      if (event === 'seeking') {
        if (range && media.currentTime < start) media.currentTime = start
        if (range && media.currentTime > end) media.currentTime = end
        return false
      }
      if (!finished && (event === 'ended' || (range && !media.paused && media.currentTime >= end))) {
        finished = true
        if (range) { media.pause(); media.currentTime = end }
        return true
      }
      return false
    },
  }
}

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
