import * as React from 'react'
import { ArrowUpRight, ChevronDown, Film, ImageIcon, Maximize2, Mic, Music2, Waves } from 'lucide-react'
import type { VisualMedia, VisualProductionSnapshot, VisualShot } from '@dutydeck/shared'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { VisualMediaView } from './VisualMediaView'
import { visualCandidateReviewState } from './model'
import { buildShotFrameSlots, buildShotMediaSlots, findRunningShotJob, SHOT_MEDIA_LABELS, visualJobActivityLabel, type ShotMediaSlot } from './shot-media-model'

/** 展示 Agent 的视频计划，使用户在生成前能核对制作方式。 */
const VIDEO_MODE_LABELS = { 'text-to-video': '文生视频', 'image-to-video': '当前画面驱动', 'first-last-frame': '首尾帧驱动' } as const
/** 转场是剪辑关系，和模型帧输入分开显示。 */
const TRANSITION_LABELS = { 'hard-cut': '硬切', 'match-cut': '匹配剪辑', dissolve: '叠化' } as const
/** 声音接续在主舞台明确展示，避免画面对齐但声音在切点突然断裂。 */
const AUDIO_TRANSITION_LABELS = { 'hard-cut': '声音同步切', 'carry-over': '声音延续', prelap: '声音先入', 'dialogue-carry': '对白跨切点' } as const

/** 分镜预览只读取素材；编辑、引用和采用均交给工作台的版本校验入口。 */
interface VisualShotMediaProps {
  /** 媒体授权范围、当前快照和镜头。 */
  sessionId: string
  snapshot: VisualProductionSnapshot
  shot: VisualShot
  /** 仅可见工作台拥有播放焦点。 */
  active: boolean
  playing: boolean
  /** 当前影片的读取、结束、错误及暂停事件。 */
  onEnded: () => void
  onError: () => void
  onPause: () => void
  /** 独立试听与图片放大先停止连续预演。 */
  onAudioPlay: () => void
  /** 打开已有候选详情，沿用统一采用流程。 */
  onPreviewCandidate: (candidateId: string) => void
  /** 声音设计使用可保存的镜头编辑器。 */
  onEditSound: () => void
}

/** 影片主舞台与下方画面参考、声音设计使用独立素材位。 */
export function VisualShotMedia({ sessionId, snapshot, shot, active, playing, onEnded, onError, onAudioPlay, onPause, onPreviewCandidate, onEditSound }: VisualShotMediaProps): React.ReactElement {
  /** 一次快照解析供影片、画面和声音共用，避免把静帧当影片。 */
  const slots = React.useMemo(() => buildShotMediaSlots(snapshot, shot), [snapshot, shot])
  /** 固定三槽顺序来自共享模型。 */
  const imageSlot = slots.find(slot => slot.kind === 'image')!
  const videoSlot = slots.find(slot => slot.kind === 'video')!
  const audioSlot = slots.find(slot => slot.kind === 'audio')!
  /** 当前镜头存在运行任务时直接展示真实阶段，不让用户去制作记录中寻找进度。 */
  const runningJob = findRunningShotJob(snapshot, shot.id)
  const runningLabel = runningJob ? visualJobActivityLabel(runningJob) : ''
  /** 视频计划声明的首尾帧作为独立制作依据展示，不能只保留文字说明。 */
  const frameSlots = React.useMemo(() => buildShotFrameSlots(snapshot, shot), [snapshot, shot])
  /** 首帧复用当前已采用画面时只显示一张卡，避免同一媒体在两个区域重复。 */
  const referenceItems = React.useMemo(() => {
    /** 合并后的引用卡统一保持同一结构，供缩略图和放大预览共用。 */
    const items: Array<{
      role: 'first' | 'last' | 'image'
      label: string
      sourceLabel: string
      state: 'ready' | 'missing'
      media?: VisualMedia
    }> = frameSlots.map(frame => ({
      role: frame.role,
      label: frame.label,
      sourceLabel: frame.sourceLabel,
      state: frame.state,
      media: frame.media,
    }))
    /** 首尾帧已覆盖同一媒体时不再追加普通画面引用。 */
    if (imageSlot.preview && !items.some(item => item.media?.id === imageSlot.preview?.id)) {
      items.push({
        role: 'image',
        label: imageSlot.adopted ? '已采用画面' : '画面候选',
        sourceLabel: imageSlot.adopted ? '镜头画面输出' : '待采用预览',
        state: 'ready',
        media: imageSlot.preview,
      })
    }
    /** 没有生成帧也没有画面输出时仍保留一个明确的空状态。 */
    if (!items.length) items.push({
      role: 'image',
      label: '画面',
      sourceLabel: '当前没有可用画面',
      state: 'missing',
      media: undefined,
    })
    return items
  }, [frameSlots, imageSlot.adopted, imageSlot.preview])
  /** 图片放大只改变本地预览，Radix 负责关闭后的焦点恢复。 */
  const [referencePreview, setReferencePreview] = React.useState<{ label: string; detail: string; media: VisualMedia } | null>(null)
  const imageOpen = referencePreview !== null
  /** 主舞台首条影片候选需要展示审核门禁，避免用户在记录页之外误采用。 */
  const videoCandidate = videoSlot.candidates[0]
  const videoReviewState = videoCandidate ? visualCandidateReviewState(videoCandidate) : 'legacy'
  const videoReviewLabel = videoReviewState === 'missing' ? '视频待审核' : videoReviewState === 'pending' ? '视频审核未完成' : videoReviewState === 'failed' ? '视频审核未通过' : videoReviewState === 'ready' ? '视频审核通过' : ''
  /** 三项均显示实际设计文字；未生成的独立音轨不伪造播放按钮。 */
  const soundRows = [
    { label: '对白 / 旁白', text: shot.dialogue, icon: Mic },
    { label: '环境 / 音效', text: shot.soundDesign?.effects, icon: Waves },
    { label: '配乐', text: shot.soundDesign?.music, icon: Music2 },
  ]
  /** 候选按媒体种类独立打开，多候选时用菜单保持工作台紧凑。 */
  const candidateButton = (slot: ShotMediaSlot): React.ReactNode => {
    if (!slot.candidates.length) return <span className="vp-muted">暂无{SHOT_MEDIA_LABELS[slot.kind]}候选</span>
    if (slot.candidates.length === 1) return <Button size="sm" variant="ghost" onClick={() => onPreviewCandidate(slot.candidates[0]!.id)}>查看{SHOT_MEDIA_LABELS[slot.kind]}候选 <ArrowUpRight size={13} /></Button>
    return <DropdownMenu><DropdownMenuTrigger asChild><Button size="sm" variant="ghost">{slot.candidates.length} 个{SHOT_MEDIA_LABELS[slot.kind]}候选 <ChevronDown size={13} /></Button></DropdownMenuTrigger><DropdownMenuContent align="end" className="max-w-80">{slot.candidates.map(candidate => <DropdownMenuItem key={candidate.id} className="whitespace-normal break-words" onSelect={() => onPreviewCandidate(candidate.id)}>{candidate.summary}</DropdownMenuItem>)}</DropdownMenuContent></DropdownMenu>
  }
  return <div className="vp-shot-media" aria-label="分镜素材">
    <section className="vp-film-section" data-output-kind="video" aria-label="影片主窗口">
      <div className="vp-shot-section-heading vp-film-heading"><h3><Film size={15} />影片 <span className="vp-muted">主预览</span></h3><span className="vp-output-status" data-adopted={!!videoSlot.adopted} data-running={!!runningJob}>{runningJob ? '生成中' : videoSlot.adopted ? '已采用' : videoSlot.preview ? '候选预览 · 待采用' : '待制作'}</span></div>
      <div className="vp-film-plan-bar"><span>生成设计</span><strong>{shot.videoPlan ? `${VIDEO_MODE_LABELS[shot.videoPlan.mode]} · 入场${TRANSITION_LABELS[shot.videoPlan.transitionIn]}` : '未设定，生成前需由 Agent 判断'}</strong>{shot.videoPlan && <span title={shot.videoPlan.rationale}>{shot.videoPlan.rationale}</span>}</div>
      {(shot.continuityPlan || shot.videoPlan) && <div className="vp-film-continuity-bar" data-ready={Boolean(shot.continuityPlan?.entryState.trim() && shot.continuityPlan.exitState.trim() && shot.continuityPlan.rationale.trim())} aria-label="分镜衔接设计">
        <span>衔接</span>
        {shot.continuityPlan
          ? <><span title={shot.continuityPlan.entryState}><b>入</b>{shot.continuityPlan.entryState}</span><span title={shot.continuityPlan.exitState}><b>出</b>{shot.continuityPlan.exitState}</span><span title={shot.continuityPlan.rationale}><b>声</b>{AUDIO_TRANSITION_LABELS[shot.continuityPlan.audioTransition]}{shot.continuityPlan.anchors.length ? ` · ${shot.continuityPlan.anchors.length} 个动作锚点` : ''}</span></>
          : <span className="vp-film-continuity-warning"><b>待补</b>入场、出场、动作锚点与声音接续</span>}
      </div>}
      <VisualMediaView key={`${shot.id}:${videoSlot.preview?.id ?? 'empty'}`} sessionId={sessionId} productionId={snapshot.document.id} media={videoSlot.preview} active={active && !imageOpen} playing={playing && !imageOpen} film={{ ratio: snapshot.document.ratio, duration: shot.duration }} onEnded={playing ? onEnded : undefined} onError={onError} onPause={onPause} />
      <div className="vp-film-candidates"><div><span className="vp-muted">影片候选 <b>{videoSlot.candidates.length}</b>{videoReviewLabel && <em data-review-state={videoReviewState}>{videoReviewLabel}</em>}</span><strong>{videoCandidate?.summary ?? (runningJob ? `${runningLabel} · 完成后自动显示为候选` : videoSlot.adopted ? '已采用影片，可继续制作新版本' : '等待本镜头的影片结果')}</strong></div>{candidateButton(videoSlot)}</div>
    </section>
    <div className="vp-shot-support-grid" aria-label="画面与声音设计">
      <section className="vp-shot-support" data-output-kind="image" aria-label="画面参考">
        <header className="vp-shot-section-heading"><h3><ImageIcon size={15} />画面参考 <span className="vp-muted">{referenceItems.length}</span></h3></header>
        <div className="vp-image-reference">
          <div className="vp-reference-gallery" aria-label="生成帧与画面引用">
            {referenceItems.map(item => <Button
              className="vp-reference-card"
              variant="ghost"
              disabled={!item.media}
              data-state={item.state}
              data-reference-role={item.role}
              key={item.role}
              aria-label={`放大${item.label}`}
              onClick={() => {
                if (!item.media) return
                onPause()
                setReferencePreview({ label: item.label, detail: item.sourceLabel, media: item.media })
              }}
            >
              <span className="vp-reference-card-heading"><b>{item.label}</b><span title={item.sourceLabel}>{item.sourceLabel}</span></span>
              <span className="vp-reference-card-media">
                {item.media
                  ? <VisualMediaView active={active && !imageOpen} sessionId={sessionId} productionId={snapshot.document.id} media={item.media} />
                  : <><ImageIcon size={18} /><span>尚未绑定可用图片</span></>}
                {item.media && <span className="vp-reference-card-zoom"><Maximize2 size={12} /></span>}
              </span>
            </Button>)}
          </div>
          <div className="vp-image-reference-copy"><span className="vp-output-status" data-adopted={!!imageSlot.adopted}>{imageSlot.adopted ? '已采用画面' : imageSlot.preview ? '候选预览 · 待采用' : '尚无画面'}</span><p>用于构图、关键帧和视觉参考。<br />与影片分别确认。</p>{candidateButton(imageSlot)}</div>
        </div>
      </section>
      <section className="vp-shot-support vp-sound-design" data-output-kind="audio" aria-label="声音设计">
        <header className="vp-shot-section-heading"><h3><Music2 size={15} />声音设计</h3><Button size="sm" variant="ghost" onClick={onEditSound}>编辑</Button></header>
        <div className="vp-sound-rows">{soundRows.map(row => <div className="vp-sound-row" key={row.label}><span className="vp-sound-icon"><row.icon size={13} /></span><div><h4>{row.label}</h4><p title={row.text}>{row.text || '尚未设置'}</p></div><span className="vp-muted">{row.text ? '已设定' : '待设计'}</span></div>)}</div>
        {audioSlot.preview && <div className="vp-sound-preview"><span className="vp-muted">独立音频 · {audioSlot.adopted ? '已采用' : '待采用预览'}</span><VisualMediaView key={`${shot.id}:${audioSlot.preview.id}`} active={active && !imageOpen} sessionId={sessionId} productionId={snapshot.document.id} media={audioSlot.preview} onPlay={onAudioPlay} /></div>}
        <div className="vp-sound-foot">{audioSlot.candidates.length ? candidateButton(audioSlot) : <span className="vp-muted">{audioSlot.preview ? '独立试听，播放时暂停影片。' : '声音设定与影片独立管理，音频生成后可在此试听。'}</span>}</div>
      </section>
    </div>
    <Dialog open={imageOpen && active} onOpenChange={open => { if (!open) setReferencePreview(null) }}><DialogContent className="vp-image-dialog sm:max-w-3xl"><DialogHeader><DialogTitle>画面参考 · {referencePreview?.label ?? shot.title}</DialogTitle><DialogDescription>{referencePreview?.detail ?? '当前镜头画面'}</DialogDescription></DialogHeader><VisualMediaView active={imageOpen && active} sessionId={sessionId} productionId={snapshot.document.id} media={referencePreview?.media} /></DialogContent></Dialog>
  </div>
}
