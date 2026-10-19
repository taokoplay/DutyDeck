import * as React from 'react'
import { Clock3, Loader2 } from 'lucide-react'
import { cn } from '@/lib/utils'
import { deriveAgentRunStatus, type AgentRunStatusInput } from '@/lib/agent-run-status'

/** 只补充缺少独立卡片的过渡状态，其他反馈由已有消息和输入控件负责。 */
const LABELS = {
  recovering: ['正在恢复会话历史', '请稍候'],
  background_waiting: ['后台任务等待中', '可以继续补充消息'],
  stopping: ['正在停止', '等待运行安全收尾'],
} as const

/** 根据会话状态补充必要提示；空闲及已有专属反馈的状态返回 null，不占布局空间。 */
export function AgentStatusBar(props: AgentRunStatusInput): React.ReactElement | null {
  /** 状态只用于展示，不改变 Agent 运行、发送准入或权限处理。 */
  const status = deriveAgentRunStatus(props)
  if (status !== 'recovering' && status !== 'stopping' && status !== 'background_waiting') return null
  /** 当前过渡状态对应的提示与图标。 */
  const [label, hint] = LABELS[status]
  const Icon = status === 'background_waiting' ? Clock3 : Loader2
  return (
    <div className="flex items-center gap-2 px-3 py-1.5 text-[11px] text-muted-foreground" role="status" data-agent-status={status}>
      <Icon className={cn('size-3.5 shrink-0', status !== 'background_waiting' && 'animate-spin')} />
      <span className="font-medium">{label}</span>
      <span className="text-muted-foreground">{hint}</span>
    </div>
  )
}
