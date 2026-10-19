import * as React from 'react'
import type { AgentModuleRunAudit } from '@dutydeck/shared'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from '@/components/ui/dialog'

/** 调用记录弹窗归属与关闭后焦点恢复，由模块栏持有。 */
interface AgentModuleRunAuditViewProps {
  sessionId: string
  onClose: () => void
  onReturnFocus: () => void
}

/** 仅在用户打开时挂载；读取当前会话记录，不订阅 token 或高频轮询。 */
export function AgentModuleRunAuditView({ sessionId, onClose, onReturnFocus }: AgentModuleRunAuditViewProps): React.ReactElement {
  return <Dialog open onOpenChange={(open) => { if (!open) onClose() }}>
    <DialogContent className="w-[calc(100%-2rem)] max-w-2xl" onCloseAutoFocus={(event) => {
      event.preventDefault()
      onReturnFocus()
    }}>
      <DialogHeader>
        <DialogTitle>调用记录</DialogTitle>
        <DialogDescription>查看当前会话最近 20 轮使用的模块、加载的 Skills 和实际调用的工具。</DialogDescription>
      </DialogHeader>
      <SessionModuleRunAuditView key={sessionId} sessionId={sessionId} />
    </DialogContent>
  </Dialog>
}

/** 会话 key 隔离异步结果，避免导航后显示上一会话的运行来源。 */
function SessionModuleRunAuditView({ sessionId }: { sessionId: string }): React.ReactElement {
  /** 有界运行快照与请求反馈；每次打开重新读取，不复用其他会话的记录。 */
  const [audits, setAudits] = React.useState<AgentModuleRunAudit[]>([])
  const [loading, setLoading] = React.useState(true)
  const [failed, setFailed] = React.useState(false)
  /** 关闭或切会话后忽略迟到响应，并同步阻止同一次挂载的重复读取。 */
  const mounted = React.useRef(false)
  const reading = React.useRef(false)

  /** 只读取主进程投影；错误不展示可能包含路径的原始异常。 */
  const refresh = React.useCallback(async (): Promise<void> => {
    if (reading.current) return
    reading.current = true
    setLoading(true)
    setFailed(false)
    try {
      const next = await window.electronAPI.getAgentModuleRunAudits({ sessionId })
      if (mounted.current) setAudits(next)
    } catch {
      if (mounted.current) setFailed(true)
    } finally {
      reading.current = false
      if (mounted.current) setLoading(false)
    }
  }, [sessionId])

  React.useEffect(() => {
    mounted.current = true
    void refresh()
    return () => { mounted.current = false }
  }, [refresh])

  return <div className="min-h-0 max-h-[60vh] space-y-3 overflow-y-auto text-xs" data-testid="agent-module-run-audit" aria-busy={loading}>
      <div className="flex items-center justify-between gap-2">
        <span className="text-muted-foreground">模块提供的能力与实际调用分别记录。</span>
        <Button type="button" variant="ghost" size="sm" disabled={loading} onClick={() => void refresh()}>{loading ? '读取中…' : '刷新'}</Button>
      </div>
      {failed && <p role="alert" className="text-destructive">调用记录读取失败，请刷新重试。</p>}
      {!failed && !loading && audits.length === 0 && <p className="text-muted-foreground">暂无调用记录，早期会话可能未记录这些信息。</p>}
      {audits.map(audit => <AgentModuleRunAuditDetails key={audit.runId} audit={audit} />)}
  </div>
}

/** 安全字段的纯展示组件，明确区分提供的 Skills 与成功加载事实。 */
export function AgentModuleRunAuditDetails({ audit }: { audit: AgentModuleRunAudit }): React.ReactElement {
  return <section className="space-y-1 border-t pt-2" aria-label={`运行 ${audit.runId}`}>
    <p className="break-all font-medium">运行 {audit.runId} · {audit.policyMode} · 策略 v{audit.policyRevision}</p>
    <p className="text-muted-foreground">{audit.status === 'completed' ? '运行完成' : audit.status === 'failed' ? '运行失败' : audit.status === 'stopped' ? '运行已停止' : '尚未记录运行终态'}</p>
    {audit.moduleCommandId && <p className="break-all text-muted-foreground">命令 {audit.moduleCommandId}</p>}
    {audit.modules.map(module => <div key={module.moduleId} className="space-y-0.5">
      <p>{module.moduleId} @{module.moduleVersion} · {module.invocationMode ?? module.mode}</p>
      <p className="break-all text-muted-foreground">提供 Skills：{module.skillRefs.join('、') || '无'}；提示引用：{module.promptRefs.join('、') || '无'}</p>
      <p className="break-all text-muted-foreground">声明能力：{module.declaredCapabilities.join('、') || '无'}</p>
    </div>)}
    {audit.unavailable.map(item => <p key={item.moduleId} className="text-destructive">{item.moduleId}：{item.reason}</p>)}
    <p className="break-all">已加载 Skills：{audit.activatedSkills.map(skill => `${skill.slug}（${skill.moduleId}@${skill.moduleVersion}）`).join('、') || '无成功加载记录'}</p>
    <p className="break-all">本轮实际工具：{audit.tools.map(tool => `${tool.toolName}（${tool.status === 'completed' ? '完成' : tool.status === 'failed' ? '失败' : '未收到结果'}）`).join('、') || '无工具调用记录'}</p>
    {audit.truncated && <p className="text-muted-foreground">审计展示已达到条数上限。</p>}
  </section>
}
