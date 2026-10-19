import * as React from 'react'
import { AlertCircle, CheckCircle2, Clock3, Loader2, X } from 'lucide-react'
import type { AgentModuleCommand, AgentModuleCommandStatus } from '@dutydeck/shared'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import { createModuleReceiptPoller } from './module-receipt-poller'

interface AgentModuleCommandReceiptProps {
  sessionId: string
}

/** 模块命令状态的用户可读文案，错误只展示安全错误码。 */
export function moduleCommandStatusLabel(status: AgentModuleCommandStatus): string {
  if (status === 'queued') return '已排队，等待 Agent 接管'
  if (status === 'running') return '正在执行'
  if (status === 'applied') return '已完成'
  if (status === 'canceled') return '已取消'
  if (status === 'expired') return '已过期'
  if (status === 'failed') return '执行失败'
  return '草稿'
}

/**
 * 展示当前 Session 最近一次模块命令的权威回执。
 * 当前挂载会话在页面可见时低频刷新，空列表也继续发现后续新命令。
 */
export function AgentModuleCommandReceipt({ sessionId }: AgentModuleCommandReceiptProps): React.ReactElement | null {
  return <SessionModuleCommandReceipt key={sessionId} sessionId={sessionId} />
}

/** key 隔离会话状态，切换时不会短暂显示上一会话的回执。 */
function SessionModuleCommandReceipt({ sessionId }: AgentModuleCommandReceiptProps): React.ReactElement | null {
  const [commands, setCommands] = React.useState<AgentModuleCommand[]>([])
  const [error, setError] = React.useState<string | null>(null)

  /** 取消错误独立于读取错误，后台成功刷新不会擦掉操作失败。 */
  const [cancelError, setCancelError] = React.useState<string | null>(null)
  const [canceling, setCanceling] = React.useState(false)
  /** 重试与卸载保护引用，不依赖消息 token。 */
  const refreshRef = React.useRef<(() => void) | null>(null)
  const activeRef = React.useRef(false)

  React.useEffect(() => {
    activeRef.current = true
    const poller = createModuleReceiptPoller({
      isVisible: () => document.visibilityState !== 'hidden',
      subscribeVisibility: (callback) => {
        document.addEventListener('visibilitychange', callback)
        return () => document.removeEventListener('visibilitychange', callback)
      },
      schedule: (callback, delay) => {
        const timer = setTimeout(callback, delay)
        return () => clearTimeout(timer)
      },
      load: async (isCurrent) => {
        try {
          const next = await window.electronAPI.getAgentModuleCommands({ sessionId })
          if (!isCurrent()) return
          setCommands(next)
          setError(null)
        } catch (cause) {
          if (isCurrent()) setError(cause instanceof Error ? cause.message : String(cause))
        }
      },
    })
    refreshRef.current = poller.refresh
    return () => { activeRef.current = false; refreshRef.current = null; poller.dispose() }
  }, [sessionId])

  /** 取消只更新已返回的权威命令；失败保留回执并可再次点击取消。 */
  const cancelCommand = async (commandId: string): Promise<void> => {
    if (canceling) return
    setCanceling(true)
    setCancelError(null)
    try {
      const next = await window.electronAPI.cancelAgentModuleCommand({ sessionId, commandId })
      if (activeRef.current) setCommands((current) => current.map((command) => command.commandId === next.commandId ? next : command))
    } catch (cause) {
      if (activeRef.current) setCancelError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      if (activeRef.current) setCanceling(false)
    }
  }

  /** 最新提交的命令优先，文件修复后的数组顺序不影响回执选择。 */
  const latest = commands.reduce<AgentModuleCommand | undefined>((selected, command) => !selected || command.createdAt >= selected.createdAt ? command : selected, undefined)
  React.useEffect(() => { setCancelError(null) }, [latest?.commandId, latest?.status])
  if (!latest && !error) return null
  if (!latest) return <div className="px-3 py-1 text-[11px] text-destructive" role="status" data-testid="agent-module-command-receipt-error">模块命令回执不可用 <Button type="button" size="sm" variant="ghost" onClick={() => refreshRef.current?.()}>重新读取回执</Button></div>

  const Icon = latest.status === 'running' ? Loader2
    : latest.status === 'failed' ? AlertCircle
      : latest.status === 'applied' ? CheckCircle2
        : latest.status === 'canceled' ? X
          : Clock3
  /** 运行中命令由 Agent 状态条的“停止”动作控制，避免只改回执而留下真实 Pi 运行。 */
  const active = latest.status === 'queued'
  return (
    <div className={cn('mx-3 mb-2 flex flex-wrap items-center gap-2 rounded-md border px-3 py-1.5 text-[11px]', latest.status === 'failed' && 'border-destructive/30 bg-destructive/5 text-destructive')} role="status" data-testid="agent-module-command-receipt">
      <Icon className={cn('size-3.5 shrink-0', latest.status === 'running' && 'animate-spin')} />
      <span className="font-medium">{latest.moduleId}</span>
      <span className="text-muted-foreground">{moduleCommandStatusLabel(latest.status)}</span>
      <span className="min-w-0 max-w-48 truncate text-muted-foreground" title={latest.requestSummary}>{latest.requestSummary}</span>
      {latest.status === 'failed' && latest.errorCode && <code className="ml-auto max-w-[16rem] truncate text-[10px]">{latest.errorCode}</code>}
      {(error || cancelError) && <span className="text-destructive" data-testid="agent-module-command-error">
        {cancelError ? '取消失败' : '回执刷新失败'}
        {cancelError && active
          ? <Button type="button" size="sm" variant="ghost" disabled={canceling} onClick={() => void cancelCommand(latest.commandId)}>重试取消</Button>
          : <Button type="button" size="sm" variant="ghost" onClick={() => refreshRef.current?.()}>重新读取回执</Button>}
      </span>}
      {active && (
        <Button
          type="button"
          size="icon"
          variant="ghost"
          className="ml-auto size-6"
          aria-label="取消模块命令"
          disabled={canceling}
          onClick={() => void cancelCommand(latest.commandId)}
        >
          <X className="size-3.5" />
        </Button>
      )}
    </div>
  )
}
