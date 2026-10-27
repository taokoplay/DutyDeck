import * as React from 'react'
import type { NetworkDiagnosticsReport, NetworkRecoveryReason, NetworkRecoveryStatus } from '@dutydeck/shared'
import { Loader2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { SettingsCard, SettingsSection } from './primitives'

/** 用用户能理解的原因展示最近一次本机连接恢复。 */
const REASON_LABELS: Record<NetworkRecoveryReason, string> = {
  interface: '网络接口变化', resume: '电脑唤醒', online: '恢复在线', manual: '手动恢复', 'proxy-settings': '代理设置变化',
}

/** 连接恢复与本地脱敏报告；不向远端发起探测请求。 */
export function NetworkDiagnosticsSettings(): React.ReactElement {
  /** 最近恢复状态仅包含时间及原因，不包含代理或服务地址。 */
  const [status, setStatus] = React.useState<NetworkRecoveryStatus | null>(null)
  /** 用户实际预览的固定快照，导出时只传其 id。 */
  const [report, setReport] = React.useState<NetworkDiagnosticsReport | null>(null)
  /** 串行化按钮操作，避免重复保存对话框和恢复请求。 */
  const [pending, setPending] = React.useState<'status' | 'reconnect' | 'preview' | 'export' | null>('status')
  /** 错误仅展示固定本地文案，不能回显未知异常中的服务地址或凭据。 */
  const [error, setError] = React.useState<string | null>(null)
  /** 非错误操作反馈，取消保存也应让用户知道结果。 */
  const [message, setMessage] = React.useState<string | null>(null)

  React.useEffect(() => {
    /** 页面切走后不再提交异步状态。 */
    let active = true
    void window.electronAPI.network.getStatus().then(value => {
      if (active) setStatus(value)
    }).catch(() => {
      if (active) setError('读取网络恢复状态失败，请稍后重试。')
    }).finally(() => {
      if (active) setPending(null)
    })
    return () => { active = false }
  }, [])

  /** 执行固定操作；失败不展示原始错误，旧预览也不会被静默替换。 */
  const runAction = async (action: 'status' | 'reconnect' | 'preview' | 'export'): Promise<void> => {
    if (pending) return
    setPending(action)
    setError(null)
    setMessage(null)
    try {
      if (action === 'status') setStatus(await window.electronAPI.network.getStatus())
      if (action === 'reconnect') {
        /** 服务可能保留旧状态返回；比较代次，不能把解析失败显示为成功。 */
        const before = await window.electronAPI.network.getStatus()
        const recovered = await window.electronAPI.network.reconnect()
        setStatus(recovered)
        if (recovered.epoch <= before.epoch) throw new Error('恢复状态未更新')
        setMessage('已刷新本机连接状态。')
      }
      if (action === 'preview') setReport(await window.electronAPI.network.previewDiagnostics())
      if (action === 'export' && report) {
        /** 不能在导出前偷偷生成新报告，用户确认的是当前预览。 */
        const saved = await window.electronAPI.network.exportDiagnostics(report.id)
        setMessage(saved ? '已导出当前预览。' : '已取消导出。')
      }
    } catch {
      setError(action === 'export'
        ? '导出失败或预览已过期，请重新预览后再导出。'
        : '操作失败，请稍后重试。')
    } finally {
      setPending(null)
    }
  }

  return (
    <SettingsSection title="连接恢复与诊断" description="换网或唤醒后连接异常时，可手动刷新本机连接状态。">
      <SettingsCard divided={false}>
        <div className="space-y-3 p-4">
          <p className="text-sm text-muted-foreground" aria-live="polite">
            {status?.lastChangedAt !== undefined
              ? `最近恢复：${new Date(status.lastChangedAt).toLocaleString()}${status.reason ? ` · ${REASON_LABELS[status.reason]}` : ''}`
              : status ? '尚无网络恢复记录。' : pending === 'status' ? '正在读取恢复状态…' : '恢复状态暂不可用。'}
          </p>
          <div className="flex flex-wrap gap-2">
            <Button size="sm" variant="outline" disabled={pending !== null} onClick={() => void runAction('status')}>刷新状态</Button>
            <Button size="sm" variant="outline" disabled={pending !== null} onClick={() => void runAction('reconnect')}>恢复连接</Button>
            <Button size="sm" variant="outline" disabled={pending !== null} onClick={() => void runAction('preview')}>预览诊断</Button>
            <Button size="sm" variant="outline" disabled={pending !== null || !report} onClick={() => void runAction('export')}>导出本预览</Button>
            {pending && <span className="inline-flex items-center gap-1 text-xs text-muted-foreground" role="status"><Loader2 size={14} className="animate-spin" />处理中…</span>}
          </div>
          <p className="text-xs text-muted-foreground">诊断仅保留本次运行的故障分类、耗时、状态码和匿名来源标识。预览有效期为 5 分钟，最多保留最近 5 份。</p>
          {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
          {message && <p role="status" className="text-sm text-muted-foreground">{message}</p>}
          {report && <div className="space-y-2">
            <p className="text-xs text-muted-foreground">预览时间：{new Date(report.createdAt).toLocaleString()} · {report.events.length} 条事件</p>
            {report.events.length === 0 && <p className="text-sm text-muted-foreground">暂无可用诊断事件。</p>}
            <pre tabIndex={0} aria-label="脱敏网络诊断预览" className="max-h-72 overflow-auto rounded-md border border-border bg-muted/30 p-3 text-xs text-foreground">{JSON.stringify(report, null, 2)}</pre>
          </div>}
        </div>
      </SettingsCard>
    </SettingsSection>
  )
}
