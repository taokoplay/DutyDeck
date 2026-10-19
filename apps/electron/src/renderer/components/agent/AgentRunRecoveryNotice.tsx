import * as React from 'react'
import { AlertTriangle, Loader2, ShieldCheck } from 'lucide-react'
import type { AgentRunRecoveryPlan, AgentRunRecoveryOperation } from '@dutydeck/shared'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'

interface AgentRunRecoveryNoticeProps {
  sessionId: string
  /** 当前运行是否仍在进行；运行结束后重新读取 Journal 终态。 */
  running?: boolean
}

/** 展示崩溃或进程重启后发现的未完成运行，避免非幂等工具被静默重放。 */
export function AgentRunRecoveryNotice({ sessionId, running = false }: AgentRunRecoveryNoticeProps): React.ReactElement | null {
  if (running) return null
  return <SessionRunRecoveryNotice key={sessionId} sessionId={sessionId} />
}

/** 先核验运行记录；仅宿主允许的动作可按精确 run 身份提交。 */
function SessionRunRecoveryNotice({ sessionId }: { sessionId: string }): React.ReactElement | null {
  const [plans, setPlans] = React.useState<AgentRunRecoveryPlan[]>([])
  const [loading, setLoading] = React.useState(true)

  /** 读取失败必须可见；重试只递增读取轮次。 */
  const [error, setError] = React.useState<string | null>(null)
  const [readVersion, setReadVersion] = React.useState(0)
  /** 异步动作绑定本会话挂载，切换后丢弃迟到结果。 */
  const alive = React.useRef(true)
  const [applyingRunId, setApplyingRunId] = React.useState<string | null>(null)
  const [confirmAbandonRunId, setConfirmAbandonRunId] = React.useState<string | null>(null)
  const [actionError, setActionError] = React.useState<string | null>(null)
  React.useEffect(() => { alive.current = true; return () => { alive.current = false } }, [])

  /** 宿主重新执行 CAS 与权限检查；UI 不读取路径，不重新发送历史消息。 */
  const perform = async (plan: AgentRunRecoveryPlan, operation: AgentRunRecoveryOperation): Promise<void> => {
    if (applyingRunId) return
    setApplyingRunId(plan.runId)
    setActionError(null)
    try {
      await window.electronAPI.applyAgentRunRecovery({ sessionId, runId: plan.runId, branchId: plan.branchId, lastSequence: plan.lastSequence, operation })
      if (alive.current) {
        setPlans((current) => current.filter((item) => item.runId !== plan.runId))
        setConfirmAbandonRunId(null)
      }
    } catch {
      if (alive.current) setActionError('操作未完成，运行可能已经变化；请重新检查记录后再操作。')
    } finally { if (alive.current) setApplyingRunId(null) }
  }

  React.useEffect(() => {
    let disposed = false
    setLoading(true)
    setError(null)
    void window.electronAPI.getAgentRunRecoveryPlans(sessionId)
      .then((next) => { if (!disposed) setPlans(next) })
      .catch((cause: unknown) => { if (!disposed) setError(cause instanceof Error ? cause.message : String(cause)) })
      .finally(() => { if (!disposed) setLoading(false) })
    return () => { disposed = true }
  }, [readVersion, sessionId])

  if (loading) return <div className="flex items-center gap-2 px-3 py-1.5 text-[11px] text-muted-foreground"><Loader2 className="size-3 animate-spin" />正在检查未完成运行</div>
  if (error) return <div role="status" data-testid="agent-run-recovery-error" className="px-3 py-1.5 text-xs text-destructive">未完成运行检查失败，尚未确认恢复状态。<Button type="button" size="sm" variant="outline" onClick={() => setReadVersion((value) => value + 1)}>重新检查运行记录</Button></div>
  if (plans.length === 0) return null

  const hasConfirm = plans.some((plan) => plan.action === 'confirm')
  const hasMismatch = plans.some((plan) => plan.reconciliation?.status === 'mismatch' || plan.action === 'abandon')
  const requiresAttention = hasConfirm || hasMismatch
  return (
    <div className={cn('mx-3 mb-2 rounded-lg border px-3 py-2 text-xs', requiresAttention ? 'border-amber-500/30 bg-amber-500/5' : 'border-border/60 bg-muted/30')} role="status" data-testid="agent-run-recovery-notice">
      <div className="flex items-start gap-2">
        {requiresAttention ? <AlertTriangle className="mt-0.5 size-4 shrink-0 text-amber-600" /> : <ShieldCheck className="mt-0.5 size-4 shrink-0 text-primary" />}
        <div className="min-w-0 flex-1">
          <div className="font-medium">发现 {plans.length} 个未完成运行</div>
          <div className="mt-1 max-h-64 space-y-3 overflow-y-auto text-muted-foreground">
            {plans.map((plan) => (
              <div key={`${plan.runId}:${plan.lastSequence}`} data-recovery-run={plan.runId}>
                <div className="mb-1 truncate font-mono text-[10px]" title={plan.runId}>运行 {plan.runId}</div>
                {plan.reconciliation?.status === 'mismatch' || plan.action === 'abandon'
                  ? '两套运行事实源无法对账，系统已停止自动恢复。'
                  : plan.reconciliation?.status === 'incomplete'
                    ? '运行中间态尚未完整提交；请先核对已发生的工具操作，重新发消息不等于恢复此运行。'
                    : plan.action === 'confirm'
                      ? '存在未确认的工具或权限副作用，系统没有自动重放。'
                      : plan.action === 'resume'
                        ? '运行记录已通过一致性检查。'
                        : '运行日志不完整，已停止自动恢复。'} {plan.reason}
                {plan.continuationBlockedReason && <p className="mt-1">{plan.continuationBlockedReason}</p>}
                <div className="mt-2 flex flex-wrap gap-2">
                  {plan.availableActions?.includes('continue') && <Button type="button" size="sm" variant="outline" disabled={Boolean(applyingRunId)} onClick={() => { void perform(plan, 'continue') }}>从检查点继续</Button>}
                  {plan.availableActions?.includes('abandon') && (confirmAbandonRunId === plan.runId
                    ? <><span>保留日志并终结此运行？</span><Button type="button" size="sm" variant="outline" disabled={Boolean(applyingRunId)} onClick={() => { void perform(plan, 'abandon') }}>确认放弃此运行</Button><Button type="button" size="sm" variant="ghost" disabled={Boolean(applyingRunId)} onClick={() => setConfirmAbandonRunId(null)}>返回</Button></>
                    : <Button type="button" size="sm" variant="ghost" disabled={Boolean(applyingRunId)} onClick={() => setConfirmAbandonRunId(plan.runId)}>保留日志并放弃此运行</Button>)}
                </div>
              </div>
            ))}
          </div>
          {actionError && <p role="alert" className="mt-2 text-destructive">{actionError}</p>}
          <Button type="button" size="sm" variant="outline" className="mt-2 h-7 text-xs" disabled={Boolean(applyingRunId)} onClick={() => setReadVersion((value) => value + 1)}>重新检查运行记录</Button>
        </div>
      </div>
    </div>
  )
}
