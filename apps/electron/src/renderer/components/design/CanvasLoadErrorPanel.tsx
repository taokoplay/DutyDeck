import { useState } from 'react'
import { formatCanvasErrorDiagnostic } from '@proma/shared'
import type { CanvasPublicError } from '@proma/shared'
import { Button } from '@/components/ui/button'
import { copyTextToClipboard } from '@/lib/clipboard'

/** 只接收经过 IPC 边界净化的公开错误与重试回调。 */
interface CanvasLoadErrorPanelProps {
  error: CanvasPublicError
  onRetry: () => void
}

/** 将公开错误整理为可复制诊断；不会读取磁盘或原始异常。 */
export function formatCanvasLoadError(error: CanvasPublicError): string {
  return [error.message, `错误码：${error.code}`,
    error.diagnostic ? formatCanvasErrorDiagnostic(error.diagnostic) : '暂无详细诊断，请重试或查看应用日志。',
  ].join('\n')
}

/** 加载失败统一面板：完整换行、可复制诊断、明确重试与复制失败反馈。 */
export function CanvasLoadErrorPanel({ error, onRetry }: CanvasLoadErrorPanelProps): React.ReactElement {
  /** 复制反馈绑定当前诊断，错误变化后自动隐藏旧反馈。 */
  const [copyResult, setCopyResult] = useState<{ text: string; message: string } | null>(null)
  /** 供界面和剪贴板共用的公开诊断。 */
  const text = formatCanvasLoadError(error)
  return (
    <section role="alert" aria-label="画布加载失败" className="w-full min-w-0 max-w-xl rounded-lg border border-destructive/30 bg-background p-4 text-foreground shadow-sm">
      <h3 className="text-sm font-medium text-destructive">画布加载失败</h3>
      <pre className="my-3 max-h-64 overflow-auto whitespace-pre-wrap break-all font-sans text-xs leading-relaxed select-text">{text}</pre>
      <div className="flex flex-wrap items-center gap-2">
        <Button size="sm" variant="outline" onClick={() => {
          void copyTextToClipboard(text).then(() => setCopyResult({ text, message: '诊断信息已复制' }))
            .catch(() => setCopyResult({ text, message: '复制失败，请选中上方诊断信息手动复制。' }))
        }}>复制诊断信息</Button>
        <Button size="sm" variant="outline" onClick={onRetry}>重试</Button>
        {copyResult?.text === text ? <span role="status" className="text-xs text-muted-foreground">{copyResult.message}</span> : null}
      </div>
    </section>
  )
}
