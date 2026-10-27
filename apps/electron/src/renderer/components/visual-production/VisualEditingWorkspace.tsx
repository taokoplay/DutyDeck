import * as React from 'react'
import { AlertTriangle, CheckCircle2, ChevronLeft, ChevronRight, Download, Film, Maximize2, RefreshCw, XCircle } from 'lucide-react'
import { applyVisualEditingOperations } from '@dutydeck/shared'
import type { VisualEditingClip, VisualEditingExportJob, VisualEditingExportSettings, VisualEditingOperation, VisualEditingTimelineSnapshot, VisualEditingTrack, VisualProductionSnapshot } from '@dutydeck/shared'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { VisualMediaView } from './VisualMediaView'
import { VisualEditingTimeline } from './VisualEditingTimeline'
import { VisualEditingInspector } from './VisualEditingInspector'
import { VisualEditingCandidates, VisualCandidatePlayback, VisualNativePreview } from './VisualEditingCandidates'
import { getNextVideoClipId } from './VisualEditingPlayback'
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
  const [inspectorOpen, setInspectorOpen] = React.useState(false)
  /** 当前预览的 Agent 候选；关闭弹窗不改变正式时间线。 */
  const [candidateId, setCandidateId] = React.useState<string | null>(null)
  /** 导出设置与精剪视图的弹窗状态。 */
  const [exportOpen, setExportOpen] = React.useState(false)
  const [refineOpen, setRefineOpen] = React.useState(false)
  /** 候选采用、导出和下载共用的前台忙碌状态。 */
  const [exportBusy, setExportBusy] = React.useState(false)
  /** 成片导出只提交显式设置，默认继承作品比例和帧率。 */
  const [exportSettings, setExportSettings] = React.useState<VisualEditingExportSettings>({ ratio: snapshot.document.ratio, fps: snapshot.document.fps, includeVoice: true, includeMusic: true, includeCaptions: true })
  const requestId = React.useRef(0)
  const selected = findClip(timelineSnapshot, selectedClipId)
  const selectedCandidate = timelineSnapshot?.candidates.find(item => item.id === candidateId) ?? null
  const selectedMedia = selected?.clip.source ? snapshot.media.find(item => item.id === selected.clip.source?.mediaId) : undefined
  const videoTrack = timelineSnapshot?.timeline?.tracks.find(track => track.kind === 'video')
  const selectedIndex = videoTrack && selected?.track.kind === 'video' ? videoTrack.clips.findIndex(item => item.id === selectedClipId) : -1
  /** 原生预览独立呈现，避免将待审产物混称为正式成片。 */
  const previewJob = timelineSnapshot?.exportJobs.filter(job => job.preview).sort((left, right) => right.createdAt - left.createdAt)[0]
  const formalExportJobs = timelineSnapshot?.exportJobs.filter(job => !job.preview) ?? []

  /** 播放结束后推进到下一个画面片段；到达末尾才停止。 */
  const advancePlayback = React.useCallback((): void => {
    if (!timelineSnapshot?.timeline) { setPlaying(false); return }
    const nextClipId = getNextVideoClipId(timelineSnapshot.timeline, selectedClipId)
    if (!nextClipId) { setPlaying(false); return }
    setSelectedClipId(nextClipId)
    setPlaying(true)
  }, [selectedClipId, timelineSnapshot])

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
  React.useEffect(() => {
    if (!active || !currentEpisodeId) return
    let cancelled = false
    /** 后台回执只更新任务快照，不重置用户的片段选择或播放。 */
    const refresh = async (): Promise<void> => {
      try {
        const next = await window.electronAPI.visualProduction.invoke('loadTimeline', { sessionId, productionId, episodeId: currentEpisodeId })
        if (!cancelled) setTimelineSnapshot(next)
      } catch (cause) { if (!cancelled) setError(String(cause)) }
    }
    void refresh()
    /** 仅可见且有活动预览任务时轮询，不为整个媒体库增加常驻开销。 */
    const timer = previewJob && ['queued', 'preparing', 'rendering'].includes(previewJob.status) ? window.setInterval(() => { void refresh() }, 2000) : undefined
    return () => { cancelled = true; if (timer !== undefined) window.clearInterval(timer) }
  }, [active, currentEpisodeId, productionId, sessionId, snapshot, previewJob?.id, previewJob?.status])
  React.useEffect(() => { if (!active) setPlaying(false) }, [active])
  React.useEffect(() => { setExportSettings(previous => ({ ...previous, ratio: snapshot.document.ratio, fps: snapshot.document.fps })) }, [snapshot.document.id, snapshot.document.ratio, snapshot.document.fps])
  React.useEffect(() => {
    if (!playing || !active || candidateId || selectedMedia?.kind !== 'image' || !selected) return
    /** 静帧没有原生 ended 事件，按片段时长推进并在清理时取消定时器。 */
    const timer = window.setTimeout(advancePlayback, Math.max(250, selected.clip.duration * 1000))
    return () => window.clearTimeout(timer)
  }, [active, candidateId, advancePlayback, playing, selected?.clip.duration, selected?.clip.id, selectedMedia?.kind])

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

  /** 应用用户片段设置并使用时间线 revision 做并发保护。 */
  const saveOperation = async (operation: VisualEditingOperation): Promise<void> => {
    if (!currentEpisodeId || !timelineSnapshot?.timeline || busy) return
    setBusy(true); setError('')
    try {
      const timeline = applyVisualEditingOperations(timelineSnapshot.timeline, [operation])
      timeline.revision = timelineSnapshot.timeline.revision + 1
      const next = await window.electronAPI.visualProduction.invoke('saveTimeline', { sessionId, productionId, episodeId: currentEpisodeId, expectedRevision: timelineSnapshot.timeline.revision, timeline })
      setTimelineSnapshot(next); setInspectorOpen(false); setNotice('片段设置已保存。')
    } catch (cause) { setError(String(cause)) }
    finally { setBusy(false) }
  }

  /** 采用 Agent 候选并刷新当前集，正式时间线只在用户确认后递增。 */
  const adoptCandidate = async (): Promise<void> => {
    if (!currentEpisodeId || !timelineSnapshot?.timeline || !selectedCandidate || exportBusy) return
    setExportBusy(true); setError('')
    try {
      const next = await window.electronAPI.visualProduction.invoke('adoptTimelineEdit', { sessionId, productionId, episodeId: currentEpisodeId, candidateId: selectedCandidate.id, expectedRevision: timelineSnapshot.timeline.revision })
      setTimelineSnapshot(next); setCandidateId(null); setNotice('候选已采用，正式时间线已更新。')
    } catch (cause) { setError(String(cause)) }
    finally { setExportBusy(false) }
  }

  /** 丢弃 Agent 候选但保留正式时间线和历史记录。 */
  const discardCandidate = async (): Promise<void> => {
    if (!currentEpisodeId || !selectedCandidate || exportBusy) return
    setExportBusy(true); setError('')
    try {
      const next = await window.electronAPI.visualProduction.invoke('discardTimelineEdit', { sessionId, productionId, episodeId: currentEpisodeId, candidateId: selectedCandidate.id })
      setTimelineSnapshot(next); setCandidateId(null); setNotice('候选已丢弃。')
    } catch (cause) { setError(String(cause)) }
    finally { setExportBusy(false) }
  }

  /** 提交冻结版本的成片导出任务，并立即读取任务状态。 */
  const requestExport = async (event: React.FormEvent): Promise<void> => {
    event.preventDefault()
    if (!currentEpisodeId || !timelineSnapshot?.timeline || exportBusy) return
    setExportBusy(true); setError('')
    try {
      const job = await window.electronAPI.visualProduction.invoke('requestExport', { sessionId, productionId, episodeId: currentEpisodeId, expectedTimelineRevision: timelineSnapshot.timeline.revision, settings: exportSettings })
      const next = await window.electronAPI.visualProduction.invoke('loadTimeline', { sessionId, productionId, episodeId: currentEpisodeId })
      setTimelineSnapshot(next); setExportOpen(false); setNotice(job.status === 'completed' ? '成片已生成。' : job.message ?? '成片导出任务已完成。')
    } catch (cause) { setError(String(cause)) }
    finally { setExportBusy(false) }
  }

  /** 取消仍可中断的本机导出任务。 */
  const cancelExport = async (job: VisualEditingExportJob): Promise<void> => {
    if (!currentEpisodeId || exportBusy) return
    setExportBusy(true); setError('')
    try {
      const cancelled = await window.electronAPI.visualProduction.invoke('cancelExport', { sessionId, productionId, episodeId: currentEpisodeId, exportJobId: job.id })
      setTimelineSnapshot(previous => previous ? { ...previous, exportJobs: previous.exportJobs.map(item => item.id === cancelled.id ? cancelled : item) } : previous); setNotice('已取消成片导出。')
    } catch (cause) { setError(String(cause)) }
    finally { setExportBusy(false) }
  }

  /** 下载已登记的成片媒体，下载前再次由主进程校验作品与媒体身份。 */
  const downloadExport = async (job: VisualEditingExportJob): Promise<void> => {
    if (!job.artifactMediaId || exportBusy) return
    setExportBusy(true); setError('')
    try {
      const media = await window.electronAPI.visualProduction.invoke('mediaContent', { sessionId, productionId, mediaId: job.artifactMediaId })
      const url = URL.createObjectURL(new Blob([new Uint8Array(media.bytes)], { type: media.mime }))
      const anchor = window.document.createElement('a'); anchor.href = url; anchor.download = `${productionId}-${currentEpisodeId}-v${job.timelineRevision}.mp4`; anchor.click(); window.setTimeout(() => URL.revokeObjectURL(url), 1000)
    } catch (cause) { setError(String(cause)) }
    finally { setExportBusy(false) }
  }

  /** 将导出任务状态映射为用户可读状态，并保留失败原因。 */
  const exportJobLabel = (job: VisualEditingExportJob): string => {
    if (job.status === 'completed') return '已完成'
    if (job.status === 'failed') return job.message ?? '导出失败'
    if (job.status === 'cancelled') return '已取消'
    if (job.status === 'rendering') return '编码中'
    if (job.status === 'preparing') return '准备中'
    return '排队中'
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
      <Button size="sm" variant="outline" disabled={!timelineSnapshot?.timeline} onClick={() => setRefineOpen(true)}><Maximize2 size={14} />展开精剪</Button>
      <Button size="sm" variant="default" disabled={!timelineSnapshot?.timeline || exportBusy} onClick={() => setExportOpen(true)}><Download size={14} />导出成片</Button>
    </header>
    {error && <div className="vp-error" role="alert"><span>{error}</span><Button size="sm" variant="ghost" onClick={() => { void load() }}>重新读取</Button></div>}
    {notice && <div className="vp-toolbar vp-muted" role="status">{notice}</div>}
    {previewJob && <VisualNativePreview key={previewJob.id} job={previewJob} media={snapshot.media} sessionId={sessionId} productionId={productionId} active={active && !candidateId} />}
    {loading ? <div className="vp-editing-loading">读取当前集剪辑…</div> : !timelineSnapshot?.timeline ? <div className="vp-editing-empty"><Film size={30} /><strong>从分镜开始你的剪辑</strong><span className="vp-muted">当前集的已采用镜头会按顺序成为可编辑片段。</span><Button disabled={busy} onClick={() => { void createRoughCut() }}>按分镜创建剪辑</Button></div> : <>
      <section className="vp-editing-preview-card" aria-label="正式时间线片段预演">
        <div className="vp-editing-preview-heading"><strong>正式时间线片段预演</strong><span className="vp-muted">源画面与源声音，非完整混音 · {timelineSnapshot.timeline.duration.toFixed(1)} 秒</span></div>
        <div className="vp-editing-preview-player">
          {selected?.clip.source ? <VisualMediaView key={selected.clip.id} active={active && !candidateId} sessionId={sessionId} productionId={productionId} media={selectedMedia} range={{ start: selected.clip.sourceIn, end: selected.clip.sourceOut }} playing={playing && active && !candidateId} controls onPlay={() => setPlaying(true)} onPause={() => setPlaying(false)} onEnded={advancePlayback} onError={() => setPlaying(false)} /> : <div className="vp-player-empty">选择画面片段查看预览</div>}
          {selected && <span className="vp-editing-preview-index">{selected.track.kind === 'video' && selectedIndex >= 0 ? `${selectedIndex + 1} / ${videoTrack?.clips.length ?? 0}` : selected.track.kind}</span>}
        </div>
        <div className="vp-editing-preview-controls">
          <Button size="sm" variant="outline" disabled={selectedIndex <= 0} aria-label="上一个片段" onClick={() => moveSelection(-1)}><ChevronLeft size={14} /></Button>
          <Button size="sm" disabled={!selectedMedia || (selectedMedia.kind !== 'video' && selectedMedia.kind !== 'image')} onClick={() => setPlaying(value => !value)}>{playing ? '暂停' : '播放片段'}</Button>
          <Button size="sm" variant="outline" disabled={selectedIndex < 0 || selectedIndex >= (videoTrack?.clips.length ?? 0) - 1} aria-label="下一个片段" onClick={() => moveSelection(1)}><ChevronRight size={14} /></Button>
          <span className="vp-muted">{selected?.clip.label || '未选择片段'} · {selected?.clip.duration.toFixed(1) ?? '0.0'} 秒</span>
          <span className="vp-editing-toolbar-spacer" />
          {selected && timelineSnapshot.needsReplacementClipIds.includes(selected.clip.id) && <span className="vp-editing-warning">源镜头有新版本，可替换</span>}
        </div>
      </section>
      <VisualEditingTimeline timeline={timelineSnapshot.timeline} selectedClipId={selectedClipId} needsReplacementClipIds={timelineSnapshot.needsReplacementClipIds} onSelect={(track, clip) => { setSelectedClipId(clip.id); setPlaying(false); setNotice(`${track.kind === 'caption' ? '字幕' : '片段'}已选中，可在展开精剪中继续调整。`) }} />
      <VisualEditingCandidates candidates={timelineSnapshot.candidates} currentRevision={timelineSnapshot.timeline.revision} onPreview={setCandidateId} />
      {formalExportJobs.length > 0 && <section className="vp-editing-exports" aria-label="成片导出任务"><header className="vp-editing-candidates-header"><div><strong>成片导出</strong><span className="vp-muted">导出冻结了时间线版本和素材 hash</span></div><span className="vp-muted">{formalExportJobs.length} 条</span></header>{formalExportJobs.slice().reverse().map(job => <div className="vp-editing-export-job" key={job.id}><div className="vp-editing-export-job-main"><strong>{job.status === 'completed' ? <CheckCircle2 size={14} /> : job.status === 'failed' ? <XCircle size={14} /> : job.status === 'cancelled' ? <AlertTriangle size={14} /> : <Download size={14} />}时间线 v{job.timelineRevision} · {job.settings.ratio} · {job.settings.fps}</strong><span className={`vp-muted vp-editing-export-status is-${job.status}`}>{exportJobLabel(job)}</span></div><div className="flex shrink-0 items-center gap-1">{job.status === 'completed' && <Button size="sm" variant="outline" disabled={exportBusy} onClick={() => { void downloadExport(job) }}>下载</Button>}{(job.status === 'queued' || job.status === 'preparing') && <Button size="sm" variant="ghost" disabled={exportBusy} onClick={() => { void cancelExport(job) }}>取消</Button>}</div></div>)}</section>}
      {selected && <section className="vp-editing-inspector-summary"><div><strong>当前片段</strong><span className="vp-muted">{selected.clip.label || '未命名片段'}</span></div><div><span className="vp-muted">入点</span><strong>{selected.clip.sourceIn.toFixed(1)}s</strong></div><div><span className="vp-muted">时长</span><strong>{selected.clip.duration.toFixed(1)}s</strong></div><div><span className="vp-muted">来源</span><strong>{selected.clip.source?.shotId ?? '字幕轨'}</strong></div><Button size="sm" variant="outline" disabled={busy} onClick={() => setInspectorOpen(true)}>设置片段</Button></section>}
      <VisualEditingInspector open={inspectorOpen} track={selected?.track ?? null} clip={selected?.clip ?? null} busy={busy} onOpenChange={setInspectorOpen} onSave={saveOperation} />
      <Dialog open={!!selectedCandidate} onOpenChange={open => { if (!open && !exportBusy) setCandidateId(null) }}>
        <DialogContent className="vp-dialog vp-editing-candidate-dialog">
          <DialogHeader><DialogTitle>预览候选修改</DialogTitle><DialogDescription>{selectedCandidate?.summary} · 基于时间线 v{selectedCandidate?.baseRevision}</DialogDescription></DialogHeader>
          {selectedCandidate && <><VisualCandidatePlayback key={selectedCandidate.id} candidate={selectedCandidate} media={snapshot.media} sessionId={sessionId} productionId={productionId} active={active} /><div className="vp-editing-candidate-preview"><VisualEditingTimeline timeline={selectedCandidate.timeline} selectedClipId={null} needsReplacementClipIds={[]} onSelect={() => undefined} /></div><p className="vp-muted">候选包含 {selectedCandidate.operations.length} 项操作，采用后会创建时间线 v{(timelineSnapshot?.timeline?.revision ?? 0) + 1}。</p><footer className="vp-form-footer"><Button variant="outline" disabled={exportBusy} onClick={() => { void discardCandidate() }}>丢弃候选</Button><Button disabled={exportBusy || selectedCandidate.status !== 'ready' || selectedCandidate.baseRevision !== timelineSnapshot?.timeline?.revision} onClick={() => { void adoptCandidate() }}>采用候选</Button></footer></>}
        </DialogContent>
      </Dialog>
      <Dialog open={refineOpen} onOpenChange={open => { if (!exportBusy) setRefineOpen(open) }}>
        <DialogContent className="vp-dialog vp-editing-refine-dialog">
          <DialogHeader><DialogTitle>精剪时间线</DialogTitle><DialogDescription>在更大的工作区查看轨道，点击片段后打开设置。</DialogDescription></DialogHeader>
          <div className="vp-editing-refine-body">{timelineSnapshot?.timeline && <VisualEditingTimeline timeline={timelineSnapshot.timeline} selectedClipId={selectedClipId} needsReplacementClipIds={timelineSnapshot.needsReplacementClipIds} onSelect={(track, clip) => { setSelectedClipId(clip.id); setInspectorOpen(true); setPlaying(false) }} />}</div>
        </DialogContent>
      </Dialog>
      <Dialog open={exportOpen} onOpenChange={open => { if (!exportBusy) setExportOpen(open) }}>
        <DialogContent className="vp-dialog vp-editing-export-dialog">
          <DialogHeader><DialogTitle>导出成片</DialogTitle><DialogDescription>导出会固定当前时间线 v{timelineSnapshot?.timeline?.revision} 和引用素材版本。</DialogDescription></DialogHeader>
          <form className="vp-form" onSubmit={event => { void requestExport(event) }}><div className="vp-form-body"><label>输出比例<Select value={exportSettings.ratio} onValueChange={value => setExportSettings(previous => ({ ...previous, ratio: value }))}><SelectTrigger aria-label="输出比例"><SelectValue /></SelectTrigger><SelectContent>{['16:9', '9:16', '1:1', '4:3', '3:4'].map(value => <SelectItem key={value} value={value}>{value}</SelectItem>)}</SelectContent></Select></label><label>帧率<Select value={String(exportSettings.fps)} onValueChange={value => setExportSettings(previous => ({ ...previous, fps: Number(value) }))}><SelectTrigger aria-label="输出帧率"><SelectValue /></SelectTrigger><SelectContent>{[24, 25, 30, 50, 60].map(value => <SelectItem key={value} value={String(value)}>{value} fps</SelectItem>)}</SelectContent></Select></label><label className="vp-check"><input type="checkbox" className="vp-themed-checkbox" checked={exportSettings.includeVoice} onChange={event => setExportSettings(previous => ({ ...previous, includeVoice: event.target.checked }))} />包含旁白轨</label><label className="vp-check"><input type="checkbox" className="vp-themed-checkbox" checked={exportSettings.includeMusic} onChange={event => setExportSettings(previous => ({ ...previous, includeMusic: event.target.checked }))} />包含音乐轨</label><label className="vp-check"><input type="checkbox" className="vp-themed-checkbox" checked={exportSettings.includeCaptions} onChange={event => setExportSettings(previous => ({ ...previous, includeCaptions: event.target.checked }))} />烧录字幕</label></div><footer className="vp-form-footer"><Button type="button" variant="outline" disabled={exportBusy} onClick={() => setExportOpen(false)}>取消</Button><Button type="submit" disabled={exportBusy}>开始导出</Button></footer></form>
        </DialogContent>
      </Dialog>
    </>}
  </div>
}
