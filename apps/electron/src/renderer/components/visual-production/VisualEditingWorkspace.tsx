import * as React from 'react'
import { ChevronLeft, ChevronRight, Film, Maximize2, RefreshCw } from 'lucide-react'
import type { VisualEditingClip, VisualEditingTimelineSnapshot, VisualEditingTrack, VisualProductionSnapshot } from '@dutydeck/shared'
import { Button } from '@/components/ui/button'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { VisualMediaView } from './VisualMediaView'
import { VisualEditingTimeline } from './VisualEditingTimeline'
import './visual-editing.css'

/** 剪辑工作台只接受影像作品正式快照，时间线正文由主进程单独读取。 */
export interface VisualEditingWorkspaceProps {
  /** 当前 Agent 会话。 */
  sessionId: string
  /** 当前影像作品身份。 */
  productionId: string
  /** 作品正式数据和媒体索引。 */
  snapshot: VisualProductionSnapshot
  /** 当前集数身份。 */
  episodeId: string | null
  /** 面板是否可见；隐藏时停止视频播放。 */
  active: boolean
  /** 集数切换回工作台视图。 */
  onEpisodeChange: (episodeId: string) => void
}

/** 找到当前时间线片段，避免 UI 依赖数组位置。 */
function findClip(snapshot: VisualEditingTimelineSnapshot | null, clipId: string | null): { track: VisualEditingTrack; clip: VisualEditingClip } | null {
  if (!snapshot?.timeline || !clipId) return null
  for (const track of snapshot.timeline.tracks) {
    const clip = track.clips.find(item => item.id === clipId)
    if (clip) return { track, clip }
  }
  return null
}

/** 按集加载、预演和创建粗剪的首版工作台。 */
export function VisualEditingWorkspace({ sessionId, productionId, snapshot, episodeId, active, onEpisodeChange }: VisualEditingWorkspaceProps): React.ReactElement {
  const currentEpisodeId = episodeId ?? snapshot.document.episodes[0]?.id ?? null
  const [timelineSnapshot, setTimelineSnapshot] = React.useState<VisualEditingTimelineSnapshot | null>(null)
  const [selectedClipId, setSelectedClipId] = React.useState<string | null>(null)
  const [playing, setPlaying] = React.useState(false)
  const [loading, setLoading] = React.useState(false)
  const [busy, setBusy] = React.useState(false)
  const [error, setError] = React.useState('')
  const [notice, setNotice] = React.useState('')
  const requestId = React.useRef(0)
  const selected = findClip(timelineSnapshot, selectedClipId)
  const selectedMedia = selected?.clip.source ? snapshot.media.find(item => item.id === selected.clip.source?.mediaId) : undefined
  const videoTrack = timelineSnapshot?.timeline?.tracks.find(track => track.kind === 'video')
  const selectedIndex = videoTrack && selected?.track.kind === 'video' ? videoTrack.clips.findIndex(item => item.id === selectedClipId) : -1

  /** 加载当前集时间线，迟到响应不得覆盖新集。 */
  const load = React.useCallback(async (): Promise<void> => {
    if (!currentEpisodeId) { setTimelineSnapshot(null); return }
    const id = ++requestId.current
    setLoading(true); setError(''); setPlaying(false)
    try {
      const next = await window.electronAPI.visualProduction.invoke('loadTimeline', { sessionId, productionId, episodeId: currentEpisodeId })
      if (id === requestId.current) { setTimelineSnapshot(next); setSelectedClipId(next.timeline?.tracks.find(track => track.kind === 'video')?.clips[0]?.id ?? null) }
    } catch (cause) { if (id === requestId.current) setError(String(cause)) }
    finally { if (id === requestId.current) setLoading(false) }
  }, [currentEpisodeId, productionId, sessionId])

  React.useEffect(() => { void load(); return () => { requestId.current += 1 } }, [load])
  React.useEffect(() => { if (!active) setPlaying(false) }, [active])

  /** 按当前作品 revision 创建初始时间线。 */
  const createRoughCut = async (): Promise<void> => {
    if (!currentEpisodeId || busy) return
    setBusy(true); setError(''); setNotice('')
    try {
      const next = await window.electronAPI.visualProduction.invoke('createRoughCut', { sessionId, productionId, episodeId: currentEpisodeId, baseProductionRevision: snapshot.document.revision })
      setTimelineSnapshot(next); setSelectedClipId(next.timeline?.tracks.find(track => track.kind === 'video')?.clips[0]?.id ?? null); setNotice('已按分镜顺序建立剪辑草稿。')
    } catch (cause) { setError(String(cause)) }
    finally { setBusy(false) }
  }

  /** 在同一轨道内切换当前预览片段。 */
  const moveSelection = (direction: -1 | 1): void => {
    if (!videoTrack || selectedIndex < 0) return
    const next = videoTrack.clips[selectedIndex + direction]
    if (next) { setSelectedClipId(next.id); setPlaying(false) }
  }

  if (!currentEpisodeId) return <div className="vp-editing-empty"><Film size={28} /><strong>先新增集数，再开始剪辑</strong><span className="vp-muted">剪辑时间线按集独立保存。</span></div>
  return <div className="vp-editing-workspace">
    <header className="vp-editing-toolbar">
      <div className="vp-editing-episode">
        <span className="vp-muted">剪辑集数</span>
        <Select value={currentEpisodeId} onValueChange={value => { setPlaying(false); onEpisodeChange(value) }}>
          <SelectTrigger aria-label="剪辑集数"><SelectValue /></SelectTrigger>
          <SelectContent>{snapshot.document.episodes.map(episode => <SelectItem key={episode.id} value={episode.id}>{episode.title}</SelectItem>)}</SelectContent>
        </Select>
      </div>
      <span className="vp-badge">{timelineSnapshot?.timeline ? `时间线 v${timelineSnapshot.timeline.revision}` : '尚未建立剪辑'}</span>
      <div className="vp-editing-toolbar-spacer" />
      <Button size="sm" variant="ghost" disabled={loading || busy} onClick={() => { void load() }}><RefreshCw size={14} />刷新</Button>
      <Button size="sm" variant="outline" disabled={loading || busy || !!timelineSnapshot?.timeline} onClick={() => { void createRoughCut() }}><Film size={14} />按分镜创建剪辑</Button>
      <Button size="sm" variant="outline" disabled={!timelineSnapshot?.timeline}><Maximize2 size={14} />展开精剪</Button>
    </header>
    {error && <div className="vp-error" role="alert"><span>{error}</span><Button size="sm" variant="ghost" onClick={() => { void load() }}>重新读取</Button></div>}
    {notice && <div className="vp-toolbar vp-muted" role="status">{notice}</div>}
    {loading ? <div className="vp-editing-loading">读取当前集剪辑…</div> : !timelineSnapshot?.timeline ? <div className="vp-editing-empty"><Film size={30} /><strong>从分镜开始你的剪辑</strong><span className="vp-muted">当前集的已采用镜头会按顺序成为可编辑片段。</span><Button disabled={busy} onClick={() => { void createRoughCut() }}>按分镜创建剪辑</Button></div> : <>
      <section className="vp-editing-preview-card" aria-label="成片预览">
        <div className="vp-editing-preview-heading"><strong>成片预览</strong><span className="vp-muted">点击播放器按片段预演 · {timelineSnapshot.timeline.duration.toFixed(1)} 秒</span></div>
        <div className="vp-editing-preview-player" onClick={() => { if (selectedMedia?.kind === 'video') setPlaying(value => !value) }}>
          {selected?.clip.source ? <VisualMediaView active={active} sessionId={sessionId} productionId={productionId} media={selectedMedia} playing={playing && active} controls onEnded={() => setPlaying(false)} onError={() => setPlaying(false)} /> : <div className="vp-player-empty">选择画面片段查看预览</div>}
          {selected && <span className="vp-editing-preview-index">{selected.track.kind === 'video' && selectedIndex >= 0 ? `${selectedIndex + 1} / ${videoTrack?.clips.length ?? 0}` : selected.track.kind}</span>}
        </div>
        <div className="vp-editing-preview-controls">
          <Button size="sm" variant="outline" disabled={selectedIndex <= 0} aria-label="上一个片段" onClick={() => moveSelection(-1)}><ChevronLeft size={14} /></Button>
          <Button size="sm" disabled={!selectedMedia || selectedMedia.kind !== 'video'} onClick={() => setPlaying(value => !value)}>{playing ? '暂停' : '播放片段'}</Button>
          <Button size="sm" variant="outline" disabled={selectedIndex < 0 || selectedIndex >= (videoTrack?.clips.length ?? 0) - 1} aria-label="下一个片段" onClick={() => moveSelection(1)}><ChevronRight size={14} /></Button>
          <span className="vp-muted">{selected?.clip.label || '未选择片段'} · {selected?.clip.duration.toFixed(1) ?? '0.0'} 秒</span>
          <span className="vp-editing-toolbar-spacer" />
          {selected && timelineSnapshot.needsReplacementClipIds.includes(selected.clip.id) && <span className="vp-editing-warning">源镜头有新版本，可替换</span>}
        </div>
      </section>
      <VisualEditingTimeline timeline={timelineSnapshot.timeline} selectedClipId={selectedClipId} needsReplacementClipIds={timelineSnapshot.needsReplacementClipIds} onSelect={(track, clip) => { setSelectedClipId(clip.id); setPlaying(false); setNotice(`${track.kind === 'caption' ? '字幕' : '片段'}已选中，可在展开精剪中继续调整。`) }} />
      {selected && <section className="vp-editing-inspector-summary"><div><strong>当前片段</strong><span className="vp-muted">{selected.clip.label || '未命名片段'}</span></div><div><span className="vp-muted">入点</span><strong>{selected.clip.sourceIn.toFixed(1)}s</strong></div><div><span className="vp-muted">时长</span><strong>{selected.clip.duration.toFixed(1)}s</strong></div><div><span className="vp-muted">来源</span><strong>{selected.clip.source?.shotId ?? '字幕轨'}</strong></div></section>}
    </>}
  </div>
}
