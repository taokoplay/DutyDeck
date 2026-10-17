import * as React from 'react'
import type { VisualMedia } from '@proma/shared'

/** 每个预览只在进入视口后读取媒体；释放时回收 Blob URL，避免整库驻留。 */
export function VisualMediaView({ sessionId, productionId, media, active = true, playing = false, controls = false, onEnded, onError, onReady, className = '' }: { sessionId: string; productionId: string; media?: VisualMedia; active?: boolean; playing?: boolean; controls?: boolean; onEnded?: () => void; onError?: () => void; onReady?: () => void; className?: string }): React.ReactElement {
  const host = React.useRef<HTMLDivElement>(null)
  const audio = React.useRef<HTMLAudioElement>(null)
  const video = React.useRef<HTMLVideoElement>(null)
  const [visible, setVisible] = React.useState(false)
  const [url, setUrl] = React.useState('')
  const [error, setError] = React.useState('')
  React.useEffect(() => {
    const observer = new IntersectionObserver(entries => setVisible(entries.some(entry => entry.isIntersecting)))
    if (host.current) observer.observe(host.current)
    return () => observer.disconnect()
  }, [])
  React.useEffect(() => {
    let cancelled = false
    let resource = ''
    setUrl(''); setError('')
    if (visible && media) {
      void window.electronAPI.visualProduction.invoke('mediaContent', { sessionId, productionId, mediaId: media.id }).then(content => {
        if (cancelled) return
        resource = URL.createObjectURL(new Blob([new Uint8Array(content.bytes)], { type: content.mime }))
        setUrl(resource); if (media.kind === 'audio') onReady?.()
      }).catch(cause => { if (!cancelled) { setError(String(cause)); onError?.() } })
    }
    return () => { cancelled = true; if (resource) URL.revokeObjectURL(resource) }
  }, [sessionId, productionId, media?.id, visible])
  React.useEffect(() => {
    if (!video.current) return
    if (playing && active) void video.current.play().catch(() => onError?.())
    else video.current.pause()
  }, [playing, active, url, onError])
  React.useEffect(() => {
    if (!active) audio.current?.pause()
    const hide = (): void => { if (document.hidden) { audio.current?.pause(); video.current?.pause() } }
    document.addEventListener('visibilitychange', hide)
    return () => document.removeEventListener('visibilitychange', hide)
  }, [active])
  return <div ref={host} className={`vp-media ${className}`}>
    {!media ? <span>尚无画面</span> : error ? <span role="alert">媒体读取失败</span> : !url ? <span>加载素材…</span> : media.kind === 'video' ? <video ref={video} src={url} controls={controls} playsInline onLoadedData={onReady} onEnded={onEnded} onError={onError} /> : media.kind === 'image' ? <img src={url} alt={media.name} onLoad={onReady} onError={() => { setError('无法解码图片'); onError?.() }} /> : <audio ref={audio} src={url} controls />}
  </div>
}
