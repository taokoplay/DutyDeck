import * as React from 'react'
import { Film, Maximize, Pause, Play, Volume2, VolumeX } from 'lucide-react'
import type { VisualMedia } from '@dutydeck/shared'
import { Button } from '@/components/ui/button'

/** 同一工作台所有预览共享播放焦点，避免影片和音频同时出声。 */
const MEDIA_PLAY_EVENT = 'visual-production:media-play'

/** 将播放器秒数显示为分秒；非有限时长使用零值，避免未加载时出现 NaN。 */
function playbackTime(seconds: number): string {
  /** 展示秒数向下取整，与浏览器进度条保持一致。 */
  const value = Number.isFinite(seconds) ? Math.max(0, Math.floor(seconds)) : 0
  return `${Math.floor(value / 60).toString().padStart(2, '0')}:${(value % 60).toString().padStart(2, '0')}`
}

/** 每个预览只在进入视口后读取媒体；释放时回收 Blob URL，避免整库驻留。 */
export function VisualMediaView({ sessionId, productionId, media, active = true, playing = false, controls = false, film, onEnded, onError, onReady, onPlay, onPause, className = '' }: { sessionId: string; productionId: string; media?: VisualMedia; active?: boolean; playing?: boolean; controls?: boolean; /** 仅分镜主舞台启用宽幅播放器，其余媒体保留原有预览。 */ film?: { ratio: string; duration: number }; onEnded?: () => void; onError?: () => void; onReady?: () => void; onPlay?: () => void; onPause?: () => void; className?: string }): React.ReactElement {
  const host = React.useRef<HTMLDivElement>(null)
  const audio = React.useRef<HTMLAudioElement>(null)
  const video = React.useRef<HTMLVideoElement>(null)
  const [visible, setVisible] = React.useState(false)
  const [url, setUrl] = React.useState('')
  const [error, setError] = React.useState('')
  /** 主舞台控制条只跟踪当前影片，不改变正式镜头的时长或绑定。 */
  const [playback, setPlayback] = React.useState({ time: 0, duration: 0, playing: false, muted: false, ready: false })
  /** 全屏失败仅提示本地操作错误，不把可播放的影片标记为损坏。 */
  const [controlError, setControlError] = React.useState('')
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
    setPlayback({ time: 0, duration: 0, playing: false, muted: false, ready: false }); setControlError('')
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
    if (film) setPlayback(previous => ({ ...previous, playing: true }))
    callbacks.current.onPlay?.()
  }
  /** 手动暂停同步连续预演；自然结束由 ended 推进镜头，避免提前取消连播。 */
  const pausePlayback = (event: React.SyntheticEvent<HTMLMediaElement>): void => {
    if (film) setPlayback(previous => ({ ...previous, playing: false }))
    if (!event.currentTarget.ended) onPause?.()
  }
  /** 读取成功但解码失败时仍提供可见错误，不留下无法播放的空播放器。 */
  const decodeError = (): void => { setError('无法解码媒体'); callbacks.current.onError?.() }
  /** 从真实影片同步就绪与时长，不能拿分镜计划时长冒充文件时长。 */
  const readyVideo = (event: React.SyntheticEvent<HTMLVideoElement>): void => {
    if (film) { const duration = event.currentTarget.duration; setPlayback(previous => ({ ...previous, ready: true, duration: Number.isFinite(duration) ? duration : 0 })) }
    onReady?.()
  }
  /** 控制当前影片播放/暂停；连续预演状态仍由工作台维护。 */
  const togglePlayback = (): void => {
    if (!video.current || !active) return
    if (video.current.paused) void video.current.play().catch(() => { setControlError('暂时无法播放，请重试'); callbacks.current.onError?.() })
    else video.current.pause()
  }
  /** 全屏包含舞台与控制条，Escape 由浏览器原生退出。 */
  const toggleFullscreen = (): void => {
    if (document.fullscreenElement === host.current) void document.exitFullscreen().catch(() => setControlError('暂时无法退出全屏'))
    else void host.current?.requestFullscreen().catch(() => setControlError('暂时无法进入全屏'))
  }
  /** 主舞台与普通预览复用媒体读取、资源释放和播放焦点。 */
  const content = !media ? (film ? <div className="vp-film-empty"><Film size={30} /><h4>本镜头尚无影片</h4><p>生成影片后，在这里预览与确认</p><span>下方画面参考保留构图与视觉设定</span></div> : <span>尚无素材</span>) : error ? <span role="alert">媒体读取失败</span> : !url ? <span>{active ? '加载素材…' : '预览已暂停'}</span> : media.kind === 'video' ? <video ref={video} src={url} controls={controls && !film} playsInline onPlay={claimPlayback} onPause={pausePlayback} onLoadedData={readyVideo} onTimeUpdate={film ? event => { const time = event.currentTarget.currentTime; setPlayback(previous => ({ ...previous, time })) } : undefined} onVolumeChange={film ? event => { const muted = event.currentTarget.muted; setPlayback(previous => ({ ...previous, muted })) } : undefined} onEnded={onEnded} onError={decodeError} /> : media.kind === 'image' ? <img src={url} alt={media.name} onLoad={onReady} onError={decodeError} /> : <audio ref={audio} src={url} controls onPlay={claimPlayback} onPause={pausePlayback} onLoadedData={onReady} onEnded={onEnded} onError={decodeError} />
  return <div ref={host} className={`${film ? 'vp-film-player' : 'vp-media'} ${className}`}>
    {film ? <><div className="vp-film-theater"><div className="vp-film-meta"><span>{film.ratio} · {film.duration}s</span><span>影片主预览</span></div>{content}</div>
      <div className="vp-film-transport" aria-label="影片播放控制">
        <Button variant="ghost" size="icon-sm" disabled={!active || !playback.ready || !!error} aria-label={playback.playing ? '暂停影片' : '播放影片'} onClick={togglePlayback}>{playback.playing ? <Pause /> : <Play />}</Button>
        <time>{playbackTime(playback.time)}</time>
        <input type="range" aria-label="影片播放进度" min={0} max={playback.duration || 1} step={0.1} value={playback.time} disabled={!active || !playback.ready || !playback.duration || !!error} onChange={event => { if (video.current) video.current.currentTime = Number(event.target.value) }} />
        <time>{playbackTime(playback.duration)}</time>
        <Button variant="ghost" size="icon-sm" disabled={!active || !playback.ready || !!error} aria-label={playback.muted ? '取消静音' : '静音影片'} aria-pressed={playback.muted} onClick={() => { if (video.current) video.current.muted = !video.current.muted }}>{playback.muted ? <VolumeX /> : <Volume2 />}</Button>
        <Button variant="ghost" size="icon-sm" aria-label="影片全屏" disabled={!active} onClick={toggleFullscreen}><Maximize /></Button>
      </div>{controlError && <p className="vp-film-control-error" role="alert">{controlError}</p>}</> : content}
  </div>
}
