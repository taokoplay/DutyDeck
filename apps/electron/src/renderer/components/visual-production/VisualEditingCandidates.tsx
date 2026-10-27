import * as React from 'react'
import type { VisualEditingExportJob, VisualEditingTimelineCandidate, VisualMedia } from '@dutydeck/shared'
import { Button } from '@/components/ui/button'
import { VisualMediaView } from './VisualMediaView'

/** 只读预览的共有媒体上下文，不包含采用或写正式时间线的入口。 */
interface PlaybackContext {
  /** 当前会话与作品身份。 */
  sessionId: string
  productionId: string
  /** 已由主进程验证的媒体索引。 */
  media: VisualMedia[]
  /** 面板可见时才加载和播放。 */
  active: boolean
}

/** 按候选自己的时间线逐片段播放；不会从正式镜头重新推导来源。 */
export function VisualCandidatePlayback({ candidate, media, sessionId, productionId, active }: PlaybackContext & { candidate: VisualEditingTimelineCandidate }): React.ReactElement {
  /** 候选内独立选择和播放状态，不与正式时间线共享。 */
  const [index, setIndex] = React.useState(0)
  const [playing, setPlaying] = React.useState(false)
  /** 只顺序演示候选画面，混音须查看原生声画预览。 */
  const clips = candidate.timeline.tracks.find(track => track.kind === 'video')?.clips ?? []
  const clip = clips[index]
  const selectedMedia = media.find(item => item.id === clip?.source?.mediaId)
  /** 只在用户已经开启预演时连播，末尾停止并保留最后一帧。 */
  const advance = React.useCallback((): void => {
    if (!playing) return
    if (index + 1 < clips.length) setIndex(index + 1)
    else setPlaying(false)
  }, [playing, index, clips.length])
  React.useEffect(() => {
    if (!playing || !active || selectedMedia?.kind !== 'image' || !clip) return
    const timer = window.setTimeout(advance, clip.duration * 1000)
    return () => window.clearTimeout(timer)
  }, [playing, active, selectedMedia?.kind, clip, advance])
  React.useEffect(() => { if (!active) setPlaying(false) }, [active])
  return <section className="vp-editing-preview-card" aria-label="候选逐片段预演">
    <div className="vp-editing-preview-heading"><strong>逐片段预演</strong><span className="vp-muted">候选画面与源声音；完整混音请看待审声画预览</span></div>
    <div className="vp-editing-preview-player">{clip ? <VisualMediaView key={clip.id} sessionId={sessionId} productionId={productionId} media={selectedMedia} range={{ start: clip.sourceIn, end: clip.sourceOut }} active={active} playing={playing} controls onPlay={() => setPlaying(true)} onPause={() => setPlaying(false)} onEnded={advance} onError={() => setPlaying(false)} /> : <span>候选没有画面片段</span>}</div>
    <div className="vp-editing-preview-controls"><Button size="sm" variant="outline" disabled={index === 0} onClick={() => { setIndex(index - 1); setPlaying(false) }}>上一段</Button><Button size="sm" disabled={!selectedMedia} onClick={() => setPlaying(value => !value)}>{playing ? '暂停' : '播放候选'}</Button><Button size="sm" variant="outline" disabled={index + 1 >= clips.length} onClick={() => { setIndex(index + 1); setPlaying(false) }}>下一段</Button><span className="vp-muted">{clip?.label} · 源区间 {clip?.sourceIn.toFixed(2)}–{clip?.sourceOut.toFixed(2)} 秒</span></div>
  </section>
}

/** 播放本机编码器登记的待审成片；未完成或索引缺失时绝不伪造可播放产物。 */
export function VisualNativePreview({ job, media, sessionId, productionId, active }: PlaybackContext & { job: VisualEditingExportJob }): React.ReactElement | null {
  /** 新登记媒体可能晚于时间线回执，补读真实作品快照。 */
  const [loadedMedia, setLoadedMedia] = React.useState<VisualMedia>()
  const [loadError, setLoadError] = React.useState('')
  const indexedMedia = media.find(item => item.id === job.artifactMediaId)
  const artifact = indexedMedia ?? (loadedMedia?.id === job.artifactMediaId ? loadedMedia : undefined)
  React.useEffect(() => {
    let cancelled = false
    setLoadError('')
    if (!active || job.status !== 'completed' || !job.artifactMediaId || indexedMedia) return
    void window.electronAPI.visualProduction.invoke('load', { sessionId, productionId }).then(snapshot => {
      if (cancelled) return
      const found = snapshot.media.find(item => item.id === job.artifactMediaId)
      if (!found) setLoadError('预览媒体索引尚未就绪，请刷新')
      else setLoadedMedia(found)
    }).catch(cause => { if (!cancelled) setLoadError(String(cause)) })
    return () => { cancelled = true }
  }, [active, sessionId, productionId, job.id, job.status, job.artifactMediaId, indexedMedia])
  if (!job.preview) return null
  return <section className="vp-editing-preview-card" aria-label="待审声画预览">
    <div className="vp-editing-preview-heading"><strong>待审声画预览</strong><span className="vp-badge">非正式 · 未自动采用</span></div>
    <p className="vp-muted">冻结作品 v{job.preview.productionRevision} · 时间线 v{job.timelineRevision} · {job.preview.range.start.toFixed(2)}–{job.preview.range.end.toFixed(2)} 秒 · {job.preview.candidateIds.length} 个候选</p>
    {job.status === 'completed' ? artifact?.kind === 'video' ? <div className="vp-editing-preview-player"><VisualMediaView sessionId={sessionId} productionId={productionId} media={artifact} active={active} controls /></div> : <p role="status">{loadError || '正在读取已登记预览媒体…'}</p> : <p role={job.status === 'failed' ? 'alert' : 'status'}>{job.message ?? (job.status === 'failed' ? '预览生成失败' : job.status === 'cancelled' ? '预览已取消' : '正在生成声画预览…')}</p>}
    <p className="vp-muted">此预览可能包含静帧和待审声音，播放成功不代表审核通过；正式时间线需另行采用。</p>
  </section>
}

/** 将候选状态转换为用户可理解的文案，过期候选不能继续采用。 */
function statusLabel(candidate: VisualEditingTimelineCandidate, currentRevision: number): string {
  if (candidate.status === 'ready' && candidate.baseRevision !== currentRevision) return '已过期'
  if (candidate.status === 'ready') return '待审阅'
  if (candidate.status === 'adopted') return '已采用'
  if (candidate.status === 'discarded') return '已丢弃'
  return '已过期'
}

/** Agent 剪辑候选摘要；完整时间线只在用户点击预览时打开。 */
export function VisualEditingCandidates({ candidates, currentRevision, onPreview }: { candidates: VisualEditingTimelineCandidate[]; currentRevision: number; onPreview: (candidateId: string) => void }): React.ReactElement | null {
  if (!candidates.length) return null
  return <section className="vp-editing-candidates" aria-label="剪辑候选修改">
    <header className="vp-editing-candidates-header"><div><strong>候选修改</strong><span className="vp-muted">Agent 提交的时间线建议，采用后才会进入正式版本</span></div><span className="vp-muted">{candidates.length} 条</span></header>
    <div className="vp-editing-candidate-list">
      {candidates.map(candidate => <article className={`vp-editing-candidate vp-editing-candidate-${candidate.status}`} key={candidate.id}>
        <div className="vp-editing-candidate-main"><div className="vp-editing-candidate-title"><strong>{candidate.summary || '未命名修改'}</strong><span className="vp-badge">{statusLabel(candidate, currentRevision)}</span></div><span className="vp-muted">基于时间线 v{candidate.baseRevision} · {candidate.operations.length} 项操作 · {candidate.timeline.duration.toFixed(1)} 秒</span></div>
        <Button size="sm" variant="outline" onClick={() => onPreview(candidate.id)}>预览候选</Button>
      </article>)}
    </div>
  </section>
}
