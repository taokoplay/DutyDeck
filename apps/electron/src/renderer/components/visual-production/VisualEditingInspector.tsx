import * as React from 'react'
import type { VisualEditingClip, VisualEditingOperation, VisualEditingTrack } from '@dutydeck/shared'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'

/** 片段设置弹窗只编辑时间线，不修改源镜头或源媒体。 */
export function VisualEditingInspector({ open, track, clip, busy, onOpenChange, onSave }: { open: boolean; track: VisualEditingTrack | null; clip: VisualEditingClip | null; busy: boolean; onOpenChange: (open: boolean) => void; onSave: (operation: VisualEditingOperation) => Promise<void> }): React.ReactElement {
  /** 弹窗表单只保留当前片段的可编辑字段，保存时转换为有限时间线操作。 */
  const [sourceIn, setSourceIn] = React.useState('0')
  const [sourceOut, setSourceOut] = React.useState('0')
  const [volume, setVolume] = React.useState('1')
  const [caption, setCaption] = React.useState('')
  const [error, setError] = React.useState('')
  React.useEffect(() => {
    if (!clip) return
    setSourceIn(String(clip.sourceIn)); setSourceOut(String(clip.sourceOut)); setVolume(String(clip.volume ?? 1)); setCaption(clip.caption?.text ?? ''); setError('')
  }, [clip?.id, clip?.sourceIn, clip?.sourceOut, clip?.volume, clip?.caption?.text])
  const save = async (event: React.FormEvent): Promise<void> => {
    event.preventDefault()
    if (!track || !clip) return
    const nextIn = Number(sourceIn); const nextOut = Number(sourceOut); const nextVolume = Number(volume)
    if (track.kind === 'video' && (!Number.isFinite(nextIn) || !Number.isFinite(nextOut) || nextOut <= nextIn)) { setError('入点和出点必须组成有效范围'); return }
    if ((track.kind === 'voice' || track.kind === 'music') && (!Number.isFinite(nextVolume) || nextVolume < 0 || nextVolume > 1)) { setError('音量必须在 0 到 1 之间'); return }
    if (track.kind === 'caption' && caption.length > 4000) { setError('字幕不能超过 4000 个字符'); return }
    setError('')
    if (track.kind === 'video') await onSave({ type: 'trimClip', trackId: track.id, clipId: clip.id, sourceIn: nextIn, sourceOut: nextOut })
    else if (track.kind === 'voice' || track.kind === 'music') await onSave({ type: 'setVolume', trackId: track.id, clipId: clip.id, volume: nextVolume })
    else await onSave({ type: 'setCaption', trackId: track.id, clipId: clip.id, text: caption, start: clip.start, duration: clip.duration })
  }
  return <Dialog open={open && !!clip && !!track} onOpenChange={onOpenChange}>
    <DialogContent className="vp-dialog vp-editing-inspector-dialog">
      <DialogHeader>
        <DialogTitle>设置片段</DialogTitle>
        <DialogDescription>{track?.kind === 'caption' ? '字幕只作用于当前时间线。' : `${clip?.label || '未命名片段'} · 源文件保持不变。`}</DialogDescription>
      </DialogHeader>
      <form className="vp-form" onSubmit={event => { void save(event) }}>
        <div className="vp-form-body">
          {error && <p className="vp-error" role="alert">{error}</p>}
          {track?.kind === 'video' && <div className="vp-form-columns"><label>入点（秒）<Input type="number" min="0" step="0.1" value={sourceIn} onChange={event => setSourceIn(event.target.value)} disabled={busy} /></label><label>出点（秒）<Input type="number" min="0" step="0.1" value={sourceOut} onChange={event => setSourceOut(event.target.value)} disabled={busy} /></label></div>}
          {(track?.kind === 'voice' || track?.kind === 'music') && <label>音量（0–1）<Input type="number" min="0" max="1" step="0.05" value={volume} onChange={event => setVolume(event.target.value)} disabled={busy} /></label>}
          {track?.kind === 'caption' && <label>字幕内容<Textarea rows={4} maxLength={4000} value={caption} onChange={event => setCaption(event.target.value)} disabled={busy} /></label>}
        </div>
        <footer className="vp-form-footer"><Button type="button" variant="outline" disabled={busy} onClick={() => onOpenChange(false)}>取消</Button><Button type="submit" disabled={busy}>保存片段</Button></footer>
      </form>
    </DialogContent>
  </Dialog>
}
