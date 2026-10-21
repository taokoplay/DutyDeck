import * as React from 'react'
import { Film, ImageIcon, Music2 } from 'lucide-react'
import type { VisualProductionSnapshot, VisualShot } from '@dutydeck/shared'
import { Button } from '@/components/ui/button'
import { VisualMediaView } from './VisualMediaView'
import { buildShotMediaSlots, SHOT_MEDIA_LABELS } from './shot-media-model'

/** 分镜素材预览与采用入口；写入仍由工作台的版本校验处理。 */
interface VisualShotMediaProps {
  /** 媒体读取权限和正式镜头来源。 */
  sessionId: string
  snapshot: VisualProductionSnapshot
  shot: VisualShot
  /** 面板与弹窗切换时停止播放并释放预览。 */
  active: boolean
  /** 连续预演驱动主窗口；待采用候选只改变本地预览，不改变正式绑定。 */
  playing: boolean
  /** 对主视觉加载、结束和失败的回调。 */
  onReady: () => void
  onEnded: () => void
  onError: () => void
  /** 单独试听时退出连续预演，避免同时出声。 */
  onAudioPlay: () => void
  /** 原生影片暂停时同步停止主工作台的连播计时。 */
  onPause: () => void
  /** 在统一制作记录弹窗打开准确候选。 */
  onPreviewCandidate: (candidateId: string) => void
}

/** 影片固定作为主窗口，画面放在下方，音频保持独立试听位。 */
export function VisualShotMedia({ sessionId, snapshot, shot, active, playing, onReady, onEnded, onError, onAudioPlay, onPause, onPreviewCandidate }: VisualShotMediaProps): React.ReactElement {
  /** 三类输出固定从同一份快照解析，避免候选预览与正式绑定出现不同结果。 */
  const slots = React.useMemo(() => buildShotMediaSlots(snapshot, shot), [snapshot, shot])
  /** 影片始终是主舞台；画面与音频属于辅助输出区。 */
  const videoSlot = slots.find(slot => slot.kind === 'video')!
  const supportSlots = slots.filter(slot => slot.kind !== 'video')
  /** 将待采用候选集中到对应输出区域，点击只打开分组预览，不改变正式绑定。 */
  const renderCandidateActions = (slot: typeof videoSlot): React.ReactElement | null => slot.candidates.length ? <div className="vp-output-candidates"><span className="vp-muted">{slot.candidates.length} 个待采用{SHOT_MEDIA_LABELS[slot.kind]}</span>{slot.candidates.map(candidate => <Button key={candidate.id} size="sm" variant="outline" aria-label={`预览待采用${SHOT_MEDIA_LABELS[slot.kind]}：${candidate.summary}`} onClick={() => onPreviewCandidate(candidate.id)}>预览候选{slot.candidates.length > 1 ? `：${candidate.summary}` : ''}</Button>)}</div> : null
  /** 使用项目比例限制影片内框，保证主窗口优先占据可用空间且不裁切内容。 */
  const frameStyle = { aspectRatio: snapshot.document.ratio.replace(':', '/'), width: `min(100%, calc(var(--vp-preview-height) * ${snapshot.document.ratio.replace(':', ' / ')}))`, height: 'auto' }
  return <div className="vp-shot-media" aria-label="分镜素材">
    <section className="vp-card vp-output-slot vp-output-video vp-shot-hero" data-output-kind="video" aria-label="影片主窗口">
      <div className="vp-output-heading"><div><h3><Film size={16} />影片主窗口</h3><p className="vp-muted">当前镜头的主要观看和连续预演区域</p></div><span className="vp-badge">{videoSlot.adopted ? '已采用' : videoSlot.preview ? '待采用预览' : '待制作'}</span></div>
      <div className="vp-output-preview vp-shot-hero-preview">
        <div className="vp-output-frame vp-player" style={frameStyle}>
          {videoSlot.preview ? <VisualMediaView key={`${shot.id}:${videoSlot.preview.id}`} active={active} sessionId={sessionId} productionId={snapshot.document.id} media={videoSlot.preview} controls playing={playing} onReady={onReady} onEnded={playing ? onEnded : undefined} onError={onError} onPause={onPause} />
            : <div className="vp-output-empty"><span>尚未采用影片</span><span className="vp-muted">生成或采用影片后，会在这里作为主窗口播放</span></div>}
        </div>
      </div>
      {videoSlot.preview && <p className="vp-muted vp-output-name" title={videoSlot.preview.name}>{videoSlot.preview.name}</p>}
      {renderCandidateActions(videoSlot)}
    </section>
    <div className="vp-shot-support-grid" aria-label="画面与音频输出">
      {supportSlots.map(slot => {
        /** 画面和音频共享辅助卡片结构，但各自保留独立播放控制。 */
        const label = SHOT_MEDIA_LABELS[slot.kind]
        const isAudio = slot.kind === 'audio'
        return <section className={`vp-card vp-output-slot vp-output-${slot.kind}`} data-output-kind={slot.kind} key={slot.kind} aria-label={`${label}素材`}>
          <div className="vp-output-heading"><div><h3>{slot.kind === 'image' ? <ImageIcon size={16} /> : <Music2 size={16} />}{label}</h3><p className="vp-muted">{isAudio ? '独立试听，不混入影片主声道' : '保留构图、关键帧和视觉参考'}</p></div><span className="vp-badge">{slot.adopted ? '已采用' : slot.preview ? '待采用预览' : '待制作'}</span></div>
          <div className="vp-output-preview">
            <div className="vp-output-frame" style={isAudio ? { width: '100%' } : frameStyle}>
              {slot.preview ? <VisualMediaView key={`${shot.id}:${slot.preview.id}`} active={active} sessionId={sessionId} productionId={snapshot.document.id} media={slot.preview} controls={isAudio} onPlay={isAudio ? onAudioPlay : undefined} />
                : <div className="vp-output-empty"><span>尚未采用{label}</span><span className="vp-muted">{isAudio ? '可独立试听配音、对白或音效' : '影片主窗口会继续保持独立'}</span></div>}
            </div>
          </div>
          {slot.preview && <p className="vp-muted vp-output-name" title={slot.preview.name}>{slot.preview.name}</p>}
          {isAudio && <p className="vp-muted">{shot.dialogue ? `旁白 / 对白：${shot.dialogue}` : '可在镜头设置中填写旁白或对白，并选择独立音频。'}</p>}
          {renderCandidateActions(slot)}
        </section>
      })}
    </div>
  </div>
}
