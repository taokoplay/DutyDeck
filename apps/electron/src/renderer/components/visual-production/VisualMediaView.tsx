import * as React from 'react'
import type { VisualMedia } from '@dutydeck/shared'

/** 同一工作台所有预览共享播放焦点，避免影片和音频同时出声。 */
const MEDIA_PLAY_EVENT = 'visual-production:media-play'

/** 每个预览只在进入视口后读取媒体；释放时回收 Blob URL，避免整库驻留。 */
export function VisualMediaView({ sessionId, productionId, media, active = true, playing = false, controls = false, onEnded, onError, onReady, onPlay, onPause, className = '' }: { sessionId: string; productionId: string; media?: VisualMedia; active?: boolean; playing?: boolean; controls?: boolean; onEnded?: () => void; onError?: () => void; onReady?: () => void; onPlay?: () => void; onPause?: () => void; className?: string }): React.ReactElement {
  const host = React.useRef<HTMLDivElement>(null)
  const audio = React.useRef<HTMLAudioElement>(null)
  const video = React.useRef<HTMLVideoElement>(null)
  const [visible, setVisible] = React.useState(false)
  const [url, setUrl] = React.useState('')
  const [error, setError] = React.useState('')
  /** 回调使用最新闭包，父级状态刷新不能重新启动或暂停原生控制条。 */
  const callbacks = React.useRef({ onError, onPlay })
  callbacks.current = { onError, onPlay }
  React.useEffect(() => {
    const observer = new IntersectionObserver(entries => setVisible(entries.some(entry => entry.isIntersecting)))
    if (host.current) observer.observe(host.current)
    return () => observer.disconnect()
  }, [])
  React.useEffect(() => {
    let cancelled = false
    let resource = ''
    setUrl(''); setError('')
    if (visible && active && media) {
      void window.electronAPI.visualProduction.invoke('mediaContent', { sessionId, productionId, mediaId: media.id }).then(content => {
        if (cancelled) return
        resource = URL.createObjectURL(new Blob([new Uint8Array(content.bytes)], { type: content.mime }))
        setUrl(resource)
      }).catch(cause => { if (!cancelled) { setError(String(cause)); onError?.() } })
    }
    return () => { cancelled = true; if (resource) URL.revokeObjectURL(resource) }
  }, [sessionId, productionId, media?.id, visible, active])
  React.useEffect(() => {
    if (!video.current) return
    if (playing && active) void video.current.play().catch(() => callbacks.current.onError?.())
    else video.current.pause()
  }, [playing, active, url])
  React.useEffect(() => {
    if (!active) audio.current?.pause()
    const hide = (): void => { if (document.hidden) { audio.current?.pause(); video.current?.pause() } }
    document.addEventListener('visibilitychange', hide)
    return () => document.removeEventListener('visibilitychange', hide)
  }, [active])
  React.useEffect(() => {
    /** 收到另一个媒体取得焦点时立即暂停本实例；无需等待 React 重新渲染。 */
    const pauseOther = (event: Event): void => {
      const source = (event as CustomEvent<HTMLMediaElement>).detail
      if (source !== video.current) video.current?.pause()
      if (source !== audio.current) audio.current?.pause()
    }
    window.addEventListener(MEDIA_PLAY_EVENT, pauseOther)
    return () => window.removeEventListener(MEDIA_PLAY_EVENT, pauseOther)
  }, [])
  /** 原生控制条与连续预演均通过同一播放入口获取焦点。 */
  const claimPlayback = (event: React.SyntheticEvent<HTMLMediaElement>): void => {
    if (!active || document.hidden) { event.currentTarget.pause(); return }
    window.dispatchEvent(new CustomEvent(MEDIA_PLAY_EVENT, { detail: event.currentTarget }))
    callbacks.current.onPlay?.()
  }
  /** 手动暂停同步连续预演；自然结束由 ended 推进镜头，避免提前取消连播。 */
  const pausePlayback = (event: React.SyntheticEvent<HTMLMediaElement>): void => { if (!event.currentTarget.ended) onPause?.() }
  /** 读取成功但解码失败时仍提供可见错误，不留下无法播放的空播放器。 */
  const decodeError = (): void => { setError('无法解码媒体'); callbacks.current.onError?.() }
  return <div ref={host} className={`vp-media ${className}`}>
    {!media ? <span>尚无素材</span> : error ? <span role="alert">媒体读取失败</span> : !url ? <span>{active ? '加载素材…' : '预览已暂停'}</span> : media.kind === 'video' ? <video ref={video} src={url} controls={controls} playsInline onPlay={claimPlayback} onPause={pausePlayback} onLoadedData={onReady} onEnded={onEnded} onError={decodeError} /> : media.kind === 'image' ? <img src={url} alt={media.name} onLoad={onReady} onError={decodeError} /> : <audio ref={audio} src={url} controls onPlay={claimPlayback} onPause={pausePlayback} onLoadedData={onReady} onEnded={onEnded} onError={decodeError} />}
  </div>
}
