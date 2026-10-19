import * as React from 'react'
import { AlertCircle, CheckCircle2, Clock3, Loader2, MessageCircleQuestion, ShieldAlert } from 'lucide-react'
import { cn } from '@/lib/utils'
import { deriveAgentRunStatus, type AgentRunStatusInput } from '@/lib/agent-run-status'

interface AgentStatusBarProps extends AgentRunStatusInput {
  onAction?: () => void
}

const LABELS = {
  recovering: ['正在恢复会话历史', '请稍候'],
  queued: ['消息已排队', '等待当前运行完成'],
  running: ['Agent 正在处理', '可继续观察实时进度'],
  waiting_permission: ['等待权限确认', '处理授权卡片后继续'],
  waiting_answer: ['等待你的回答', '打开问答卡片继续'],
  background_waiting: ['后台任务等待中', '可以继续补充消息'],
  completed: ['已完成', '可以继续发送'],
  failed: ['需要处理', '检查模型、渠道或错误信息'],
  stopping: ['正在停止', '等待运行安全收尾'],
} as const

/** 会话状态条只提供一个可理解的下一步提示，不再让输入框静默消失。 */
export function AgentStatusBar(props: AgentStatusBarProps): React.ReactElement {
  const { onAction } = props
  const status = deriveAgentRunStatus(props)
  const [label, hint] = LABELS[status]
  const Icon = status === 'running' || status === 'recovering' || status === 'stopping' ? Loader2
    : status === 'waiting_permission' ? ShieldAlert
      : status === 'waiting_answer' ? MessageCircleQuestion
        : status === 'failed' ? AlertCircle
          : status === 'completed' ? CheckCircle2
            : Clock3
  return (
    <div className={cn('flex items-center gap-2 border-y border-border/40 px-3 py-1.5 text-[11px]', status === 'failed' && 'bg-destructive/5 text-destructive', status === 'waiting_permission' && 'bg-amber-500/5 text-amber-700 dark:text-amber-300')} role="status" data-agent-status={status}>
      <Icon className={cn('size-3.5 shrink-0', (status === 'running' || status === 'recovering' || status === 'stopping') && 'animate-spin')} />
      <span className="font-medium">{label}</span>
      <span className="text-muted-foreground">{hint}</span>
      {onAction && (status === 'failed' || status === 'waiting_permission' || status === 'waiting_answer') && <button type="button" className="ml-auto underline underline-offset-2" onClick={onAction}>查看</button>}
    </div>
  )
}
