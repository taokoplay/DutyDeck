import * as React from 'react'
import type { AgentModuleRunAudit } from '@dutydeck/shared'
import { Button } from '@/components/ui/button'

/** 审计仅按用户展开/刷新读取，不订阅 token 或高频轮询。 */
export function AgentModuleRunAuditView({ sessionId }: { sessionId: string }): React.ReactElement {
  return <SessionModuleRunAuditView key={sessionId} sessionId={sessionId} />
}

/** 会话 key 隔离异步结果，避免导航后显示上一会话的运行来源。 */
function SessionModuleRunAuditView({ sessionId }: { sessionId: string }): React.ReactElement {
  /** 有界运行快照、展开状态与请求反馈。 */
  const [audits, setAudits] = React.useState<AgentModuleRunAudit[]>([])
  const [open, setOpen] = React.useState(false)
  const [loading, setLoading] = React.useState(false)
  const [failed, setFailed] = React.useState(false)
  const mounted = React.useRef(true)
  React.useEffect(() => { mounted.current = true; return () => { mounted.current = false } }, [])

  /** 只读取主进程投影；错误不展示可能包含路径的原始异常。 */
  const refresh = async (): Promise<void> => {
    if (loading) return
    setLoading(true)
    setFailed(false)
    try {
      const next = await window.electronAPI.getAgentModuleRunAudits({ sessionId })
      if (mounted.current) setAudits(next)
    } catch {
      if (mounted.current) setFailed(true)
    } finally {
      if (mounted.current) setLoading(false)
    }
  }

  return <div className="mx-3 mb-2 text-[11px]" data-testid="agent-module-run-audit">
    <Button type="button" variant="ghost" size="sm" aria-expanded={open} onClick={() => {
      setOpen(!open)
      if (!open) void refresh()
    }}>模块与工具审计</Button>
    {open && <div className="max-h-72 space-y-3 overflow-y-auto rounded-md border p-3">
      <div className="flex items-center justify-between gap-2">
        <span className="text-muted-foreground">最近 20 轮；模块声明不等于工具权限，实际工具按运行记录。</span>
        <Button type="button" variant="ghost" size="sm" disabled={loading} onClick={() => void refresh()}>{loading ? '读取中…' : '刷新'}</Button>
      </div>
      {failed && <p role="alert" className="text-destructive">审计读取失败，请重试。</p>}
      {!failed && !loading && audits.length === 0 && <p className="text-muted-foreground">暂无模块运行审计；旧运行不推测补全。</p>}
      {audits.map(audit => <AgentModuleRunAuditDetails key={audit.runId} audit={audit} />)}
    </div>}
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
