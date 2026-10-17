import * as React from 'react'
import type { VisualEditingClip, VisualEditingDocument, VisualEditingTrack } from '@dutydeck/shared'

/** 时间线轨道的展示名称，保持用户可理解的业务语言。 */
const TRACK_LABELS: Record<VisualEditingTrack['kind'], string> = { video: '画面', voice: '旁白', music: '音乐', caption: '字幕' }

/** 时间线片段点击事件和当前失效提示由工作台统一处理。 */
export function VisualEditingTimeline({ timeline, selectedClipId, needsReplacementClipIds, onSelect }: { timeline: VisualEditingDocument; selectedClipId: string | null; needsReplacementClipIds: string[]; onSelect: (track: VisualEditingTrack, clip: VisualEditingClip) => void }): React.ReactElement {
  const replacementIds = new Set(needsReplacementClipIds)
  const scale = Math.max(24, Math.min(120, 720 / Math.max(timeline.duration, 1)))
  return <section className="vp-editing-timeline" aria-label="剪辑时间线">
    <header className="vp-editing-timeline-header">
      <strong>时间线</strong>
      <span className="vp-muted">{timeline.tracks.reduce((count, track) => count + track.clips.length, 0)} 个片段 · {timeline.duration.toFixed(1)} 秒</span>
      <span className="vp-muted">版本 v{timeline.revision}</span>
    </header>
    <div className="vp-editing-timeline-scroll" tabIndex={0}>
      <div className="vp-editing-ruler" style={{ width: `${Math.max(100, timeline.duration * scale)}px` }}>
        {Array.from({ length: Math.max(2, Math.ceil(timeline.duration / 5) + 1) }, (_, index) => <span key={index} style={{ left: `${index * 5 * scale}px` }}>{index * 5}s</span>)}
      </div>
      {timeline.tracks.map(track => <div className="vp-editing-track" key={track.id}>
        <div className="vp-editing-track-label"><strong>{TRACK_LABELS[track.kind]}</strong><span>{track.clips.length}</span></div>
        <div className="vp-editing-track-content" style={{ width: `${Math.max(100, timeline.duration * scale)}px` }}>
          {track.clips.map(clip => <button key={clip.id} type="button" className={`vp-editing-clip vp-editing-clip-${track.kind}${selectedClipId === clip.id ? ' is-selected' : ''}${replacementIds.has(clip.id) ? ' needs-replacement' : ''}`} style={{ left: `${clip.start * scale}px`, width: `${Math.max(36, clip.duration * scale)}px` }} onClick={() => onSelect(track, clip)} aria-label={`${TRACK_LABELS[track.kind]}：${clip.label || '未命名片段'}${replacementIds.has(clip.id) ? '，源镜头有新版本' : ''}`}>
            <span className="vp-editing-clip-title">{clip.label || '未命名片段'}</span>
            {replacementIds.has(clip.id) && <span className="vp-editing-clip-badge">需替换</span>}
          </button>)}
        </div>
      </div>)}
    </div>
  </section>
}
