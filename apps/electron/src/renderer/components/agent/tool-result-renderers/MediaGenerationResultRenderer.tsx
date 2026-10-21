import * as React from 'react'
import type { MediaGenerationPreview, MediaKind, MediaPreloadApi } from '@dutydeck/shared'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'

/** 只从工具回执提取定位信息，不接受其中的资产路径、URL 或媒体字节。 */
interface MediaResultSummary { runId: string; phase: string; mediaKind: MediaKind; outputKeys: string[] }
/** 预览桥接仅暴露读与释放。 */
type PreviewApi = Pick<MediaPreloadApi, 'mediaGenerationReadPreview' | 'mediaGenerationReleasePreview'>
/** 预览始终绑定消息所属会话。 */
type PreviewTarget = Parameters<PreviewApi['mediaGenerationReadPreview']>[0]

/** 有界标识用于定位任务和产物，不具有授权含义。 */
function isId(value: unknown): value is string { return typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,255}$/.test(value) }
/** 判断结构化对象，排除空值和数组。 */
function isRecord(value: unknown): value is Record<string, unknown> { return !!value && typeof value === 'object' && !Array.isArray(value) }

/** 支持直接 JSON 与 runtime details 包装；仅投影非敏感展示字段。 */
export function parseMediaGenerationResult(result: string): MediaResultSummary | null {
  try {
    const parsed: unknown = JSON.parse(result)
    const value = isRecord(parsed) && isRecord(parsed.details) ? parsed.details : parsed
    if (!isRecord(value) || !isId(value.id) || typeof value.phase !== 'string'
      || !['image', 'audio', 'video'].includes(String(value.mediaKind)) || !Array.isArray(value.outputs)) return null
    const outputKeys = value.outputs.slice(0, 32).flatMap((output: unknown) => isRecord(output) && isId(output.outputKey) ? [output.outputKey] : [])
    return { runId: value.id, phase: value.phase, mediaKind: value.mediaKind as MediaKind, outputKeys: [...new Set(outputKeys)] }
  } catch { return null }
}

/** 已审核错误码对应固定中文，不回显供应商正文、URL 或凭据。 */
const MEDIA_ERROR_LABELS: Readonly<Record<string, string>> = {
  MEDIA_ADAPTER_AUTH_FAILED: '鉴权失败，请检查媒体模型凭据。',
  MEDIA_ADAPTER_QUOTA_EXCEEDED: '额度不足，请检查供应商余额或配额。',
  MEDIA_ADAPTER_RATE_LIMITED: '请求过于频繁，请稍后重试。',
  MEDIA_GENERATION_PARAMETER_UNSUPPORTED: '参数不支持，请调整生成参数。',
  MEDIA_GENERATION_PARAMETER_INVALID: '参数无效，请检查生成参数。',
  MEDIA_GENERATION_REFERENCE_UNSUPPORTED: '该模型不支持参考素材。',
  MEDIA_GENERATION_MULTIPLE_REFERENCES_UNSUPPORTED: '该模型不支持多个参考素材。',
  MEDIA_MODEL_UNAVAILABLE: '模型不可用，请检查媒体生成配置。',
  MEDIA_GENERATION_OUTCOME_UNKNOWN: '提交结果未知，请查询原任务，避免重复生成。',
  MEDIA_GENERATION_PERSISTENCE_FAILED: '提交结果未知，任务记录保存失败，请勿重复生成。',
}

/** 仅从明确错误字段或纯文本错误前缀提取白名单码，忽略其后的任意正文。 */
function mediaErrorLabel(result: string): string | null {
  let candidate: unknown = result
  try {
    const parsed: unknown = JSON.parse(result)
    const value = isRecord(parsed) && isRecord(parsed.details) ? parsed.details : parsed
    candidate = isRecord(value) ? value.error ?? value.code : value
    if (isRecord(candidate)) candidate = candidate.code ?? candidate.message
  } catch { /* 兼容 runtime 返回的纯文本错误。 */ }
  if (typeof candidate !== 'string') return null
  const code = /^(?:Error: )?(MEDIA_[A-Z_]+)(?::|\s|$)/.exec(candidate.trim())?.[1]
  return code ? MEDIA_ERROR_LABELS[code] ?? null : null
}

/** 生命周期所有者隔离异步响应；卸载后的迟到租约立刻归还原会话。 */
export class MediaPreviewOwner {
  /** 卸载状态禁止迟到响应更新界面。 */
  private disposed = false
  /** 当前租约只由本实例释放。 */
  private current: MediaGenerationPreview | null = null
  /** 请求序号使重复点击的过期响应自动失效。 */
  private sequence = 0
  constructor(private readonly api: PreviewApi, private readonly target: PreviewTarget, private readonly onPreview: (preview: MediaGenerationPreview) => void) {}
  /** 释放失败不重新展示旧 URL；窗口销毁仍由主进程兜底清理。 */
  private release(preview: MediaGenerationPreview): void {
    void this.api.mediaGenerationReleasePreview({ sessionId: this.target.sessionId, leaseId: preview.leaseId }).catch(() => {})
  }
  /** 只向主进程提交消息会话与任务产物标识。 */
  async open(): Promise<void> {
    if (this.disposed || this.current) return
    const sequence = ++this.sequence
    const preview = await this.api.mediaGenerationReadPreview(this.target)
    if (this.disposed || sequence !== this.sequence) { this.release(preview); return }
    if (!preview.mediaUrl.startsWith('proma-file://')) { this.release(preview); throw new Error('MEDIA_PREVIEW_URL_INVALID') }
    this.current = preview
    this.onPreview(preview)
  }
  /** 清理组件拥有的授权；可在重复卸载时安全调用。 */
  dispose(): void {
    this.disposed = true
    if (this.current) this.release(this.current)
    this.current = null
  }
}

/** 受管媒体显示组件；音视频只读取元数据，不自动播放。 */
export function MediaPreviewContent({ preview }: { preview: MediaGenerationPreview }): React.ReactElement {
  /** 播放或解码失败时保留明确提示。 */
  const [failed, setFailed] = React.useState(false)
  if (failed) return <p role="status" className="text-muted-foreground">媒体暂时无法播放或预览</p>
  if (preview.mediaKind === 'image') return <img src={preview.mediaUrl} alt={preview.filename} loading="lazy" className="max-h-80 max-w-full rounded object-contain" onError={() => setFailed(true)} />
  if (preview.mediaKind === 'audio') return <audio src={preview.mediaUrl} aria-label={preview.filename} controls preload="metadata" className="w-full" onError={() => setFailed(true)} />
  return <video src={preview.mediaUrl} aria-label={preview.filename} controls preload="metadata" className="max-h-80 w-full rounded" onError={() => setFailed(true)} />
}

/** 按需加载单个产物；父级 key 包含会话、任务、产物，切换时重新建立所有者。 */
function MediaOutputPreview({ target }: { target: PreviewTarget }): React.ReactElement {
  /** 当前主进程核验过的预览。 */
  const [preview, setPreview] = React.useState<MediaGenerationPreview | null>(null)
  /** 加载与错误只属于当前组件实例。 */
  const [status, setStatus] = React.useState<'idle' | 'loading' | 'failed'>('idle')
  /** effect 管理所有者，兼容 StrictMode 的建立/清理循环。 */
  const owner = React.useRef<MediaPreviewOwner | null>(null)
  React.useEffect(() => {
    const current = new MediaPreviewOwner(window.electronAPI, target, setPreview)
    owner.current = current
    return () => { current.dispose(); owner.current = null }
  }, [target.sessionId, target.runId, target.outputKey])
  /** 用户点击后才创建文件授权，历史快照不会自动占用播放资源。 */
  const open = async (): Promise<void> => {
    const current = owner.current
    if (!current) return
    setStatus('loading')
    try { await current.open(); if (owner.current === current) setStatus('idle') }
    catch { if (owner.current === current) setStatus('failed') }
  }
  return <div className="mt-2 space-y-2">
    {preview ? <MediaPreviewContent preview={preview} /> : <Button type="button" variant="outline" size="sm" disabled={status === 'loading'} onClick={() => { void open() }}>{status === 'loading' ? '正在加载预览…' : '预览产物'}</Button>}
    {status === 'failed' && <p role="status" className="text-muted-foreground">预览不可用，请确认任务和项目仍可访问后重试。</p>}
  </div>
}

/** 统一媒体工具结果卡，不把不可信 JSON 原样展示成媒体。 */
export function MediaGenerationResultRenderer({ result, isError, sessionId }: { result: string; isError: boolean; sessionId?: string }): React.ReactElement {
  /** 只读运行摘要，真正授权在点击预览时重新读取。 */
  const summary = parseMediaGenerationResult(result)
  /** 显式未知状态不能伪装失败或完成。 */
  const labels: Record<string, string> = { prepared: '已准备，等待执行', queued: '已排队', running: '生成中', succeeded: '生成完成', failed: '生成失败', cancelled: '已取消', unknown: '结果未知，请查询任务状态' }
  /** 固定文案避免工具返回的路径或上游凭据错误原样外露。 */
  const label = isError ? '媒体操作失败，请查看任务状态' : summary ? labels[summary.phase] ?? '结果未知，请查询任务状态' : '暂时无法读取媒体任务结果'
  /** 错误解释只显示白名单中文，不替换运行状态。 */
  const errorLabel = (isError || summary?.phase === 'failed' || summary?.phase === 'unknown') ? mediaErrorLabel(result) : null
  return <div className="max-w-2xl rounded-md border border-border/50 bg-muted/[0.16] p-3 text-xs">
    <div className="flex items-center gap-2"><Badge variant="outline">{summary?.mediaKind === 'audio' ? '音频' : summary?.mediaKind === 'video' ? '视频' : '图片'}生成</Badge><span role="status">{label}</span></div>
    {errorLabel && <p className="mt-2 text-muted-foreground">{errorLabel}</p>}
    {summary && !isError && summary.phase === 'succeeded' && (sessionId
      ? summary.outputKeys.map((outputKey) => <MediaOutputPreview key={JSON.stringify([sessionId, summary.runId, outputKey])} target={{ sessionId, runId: summary.runId, outputKey }} />)
      : <p className="mt-2 text-muted-foreground">缺少消息会话，无法安全预览。</p>)}
  </div>
}
