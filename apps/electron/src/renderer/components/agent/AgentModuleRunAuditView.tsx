import * as React from 'react'
import { useAtomValue } from 'jotai'
import type { AgentModuleAuditContribution, AgentModuleAuditTool, AgentModuleRunAudit } from '@dutydeck/shared'
import { Blocks, CheckCircle2, ChevronDown, CircleAlert, CircleX, Clock3, Wrench } from 'lucide-react'
import { agentModulesAtom } from '@/atoms/agent-module-atoms'
import { Button } from '@/components/ui/button'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from '@/components/ui/dialog'

/** 调用记录弹窗归属与关闭后焦点恢复，由模块栏持有。 */
interface AgentModuleRunAuditViewProps {
  sessionId: string
  onClose: () => void
  onReturnFocus: () => void
}

/** 只在打开时读取当前会话，保留历史快照，不订阅高频事件或触发模型调用。 */
export function AgentModuleRunAuditView({ sessionId, onClose, onReturnFocus }: AgentModuleRunAuditViewProps): React.ReactElement {
  return <Dialog open onOpenChange={(open) => { if (!open) onClose() }}>
    <DialogContent className="flex max-h-[calc(100dvh-2rem)] w-[calc(100%-2rem)] max-w-3xl flex-col p-4 sm:p-6" onCloseAutoFocus={(event) => {
      event.preventDefault()
      onReturnFocus()
    }}>
      <DialogHeader className="shrink-0 pr-6 text-left">
        <DialogTitle>模块运行记录</DialogTitle>
        <DialogDescription>当前会话最近 20 次有记录的运行，按时间倒序显示。</DialogDescription>
      </DialogHeader>
      <SessionModuleRunAuditView key={sessionId} sessionId={sessionId} />
    </DialogContent>
  </Dialog>
}

/** 会话 key 隔离异步结果，避免导航后显示上一会话的运行来源。 */
function SessionModuleRunAuditView({ sessionId }: { sessionId: string }): React.ReactElement {
  /** 有界运行快照与读取反馈，只在打开或手动刷新时更新。 */
  const [audits, setAudits] = React.useState<AgentModuleRunAudit[]>([])
  const [loading, setLoading] = React.useState(true)
  const [failed, setFailed] = React.useState(false)
  /** 复用已加载目录，只为缺少历史名称的记录补充展示标签，不改历史能力。 */
  const catalog = useAtomValue(agentModulesAtom)
  const moduleNames = React.useMemo(() => new Map(catalog.map(module => [module.id, module.displayName])), [catalog])
  /** 关闭或切会话后忽略迟到响应，并阻止同一次挂载的重复读取。 */
  const mounted = React.useRef(false)
  const reading = React.useRef(false)

  /** 从主进程读取当前会话投影；错误不展示可能包含路径的原始异常。 */
  const refresh = React.useCallback(async (): Promise<void> => {
    if (reading.current) return
    reading.current = true
    setLoading(true)
    setFailed(false)
    try {
      /** 新快照只允许回写仍在挂载的会话实例。 */
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

  return <div className="min-h-0 space-y-3 overflow-y-auto text-xs" data-testid="agent-module-run-audit" aria-busy={loading}>
    <div className="flex items-center justify-between gap-3">
      <span className="text-muted-foreground">{loading ? '正在读取运行记录…' : `最近 ${audits.length} 次运行`}</span>
      <Button type="button" variant="ghost" size="sm" disabled={loading} onClick={() => void refresh()}>{loading ? '读取中…' : '刷新'}</Button>
    </div>
    {failed && <p role="alert" className="text-destructive">{audits.length > 0 ? '刷新失败，以下为上次读取的记录。' : '调用记录读取失败，请刷新重试。'}</p>}
    {!failed && !loading && audits.length === 0 && <p className="rounded-md border border-dashed p-6 text-center text-muted-foreground">暂无调用记录，早期会话可能未记录这些信息。</p>}
    {audits.map((audit, index) => <AgentModuleRunAuditDetails key={audit.runId} audit={audit} moduleNames={moduleNames} defaultExpanded={index === 0} />)}
  </div>
}

/** 未写入终态的历史运行可能已中断，不能据此断言此刻仍在运行。 */
const AUDIT_STATUS = {
  running: { label: '尚无结束记录', icon: Clock3, className: 'text-muted-foreground' },
  completed: { label: '已完成', icon: CheckCircle2, className: 'text-emerald-600 dark:text-emerald-300' },
  failed: { label: '运行失败', icon: CircleX, className: 'text-destructive' },
  stopped: { label: '已停止', icon: CircleAlert, className: 'text-muted-foreground' },
} as const

/** 接入失败的可读原因；未知代码只在诊断信息内保留。 */
const UNAVAILABLE_REASONS: Readonly<Record<string, string>> = {
  AGENT_MODULE_DISABLED: '模块已禁用',
  AGENT_MODULE_WORKSPACE_REQUIRED: '需要先选择项目',
  AGENT_MODULE_SKILLS_DISABLED: '本次运行未启用 Skills',
  AGENT_MODULE_NOT_FOUND: '模块未安装或已移除',
  AGENT_MODULE_PROMPT_UNAVAILABLE: '模块提示词不可用',
  AGENT_MODULE_SKILL_UNAVAILABLE: '依赖的 Skill 缺失或已禁用',
  AGENT_MODULE_POLICY_REVISION_CONFLICT: '模块设置已变化，请重新选择后发送',
}

/** 同名工具的状态计数，不推测工具与模块的因果归属。 */
interface ToolSummary {
  toolName: string
  count: number
  completed: number
  failed: number
  started: number
}

/** 从实际工具记录聚合计数；异常项优先，其次按调用次数排序。 */
function summarizeTools(tools: readonly AgentModuleAuditTool[]): ToolSummary[] {
  /** 使用 Map 保留任意插件工具名，并只为已出现的工具分配计数。 */
  const summaries = new Map<string, ToolSummary>()
  for (const tool of tools) {
    /** 当前工具的累计事实，未收到结果不会计为完成。 */
    const current = summaries.get(tool.toolName) ?? { toolName: tool.toolName, count: 0, completed: 0, failed: 0, started: 0 }
    current.count += 1
    current[tool.status] += 1
    summaries.set(tool.toolName, current)
  }
  return [...summaries.values()].sort((a, b) => b.failed - a.failed || b.started - a.started || b.count - a.count || a.toolName.localeCompare(b.toolName))
}

/** 从安全时间戳生成本地时间；非法日期显示占位，避免整块记录崩溃。 */
function formatAuditTime(timestamp: number): string {
  /** 先验证 Date 范围，再交给本地格式化器。 */
  const date = new Date(timestamp)
  return Number.isNaN(date.getTime()) ? '时间未知' : date.toLocaleString('zh-CN', { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })
}

/** 运行卡片仅接收快照与名称索引；历史运行默认可折叠，避免一次渲染全部工具明细。 */
interface AgentModuleRunAuditDetailsProps {
  audit: AgentModuleRunAudit
  moduleNames?: ReadonlyMap<string, string>
  defaultExpanded?: boolean
}

/** 按运行组织模块卡片及工具摘要；运行 ID 等技术字段保留在折叠诊断区。 */
export function AgentModuleRunAuditDetails({ audit, moduleNames, defaultExpanded = true }: AgentModuleRunAuditDetailsProps): React.ReactElement {
  /** 标题状态及模块名称只反映本次快照，名称回退不改写旧模块接入方式。 */
  const status = AUDIT_STATUS[audit.status]
  const StatusIcon = status.icon
  const names = audit.modules.map(module => module.displayName ?? moduleNames?.get(module.moduleId) ?? module.moduleId)
  const failedTools = audit.tools.filter(tool => tool.status === 'failed').length

  return <Collapsible defaultOpen={defaultExpanded} className="rounded-lg border border-border/70 bg-card" aria-label={`运行 ${audit.runId}`}>
    <CollapsibleTrigger asChild>
      <button type="button" className="group flex w-full items-start gap-2.5 rounded-lg p-3 text-left hover:bg-muted/30 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
        <StatusIcon className={`mt-0.5 size-4 shrink-0 ${status.className}`} aria-hidden="true" />
        <span className="min-w-0 flex-1 space-y-1">
          <span className="flex flex-wrap items-center gap-x-2 gap-y-1 font-medium"><span>{formatAuditTime(audit.startedAt)}</span><span className={status.className}>{status.label}</span></span>
          <span className="block break-words text-muted-foreground">{names.join(' · ') || (audit.unavailable.length > 0 ? '模块未接入' : '未选择模块')} · 工具 {audit.tools.length} 次{audit.truncated ? '（部分记录）' : ''}</span>
          {(failedTools > 0 || audit.unavailable.length > 0) && <span className="block text-destructive">{[failedTools > 0 ? `${failedTools} 次工具失败` : '', audit.unavailable.length > 0 ? `${audit.unavailable.length} 个模块不可用` : ''].filter(Boolean).join(' · ')}</span>}
        </span>
        <ChevronDown className="mt-1 size-3.5 shrink-0 text-muted-foreground transition-transform group-data-[state=open]:rotate-180" aria-hidden="true" />
      </button>
    </CollapsibleTrigger>
    <CollapsibleContent className="space-y-4 border-t border-border/60 p-3">
      {audit.truncated && <p role="note" className="rounded-md bg-muted p-2 text-muted-foreground">记录已达到展示上限；下方数量仅统计已展示部分。</p>}
      <section className="space-y-2" aria-label="本轮解析模块">
        <h3 className="flex items-center gap-1.5 font-medium"><Blocks className="size-3.5" aria-hidden="true" />本轮模块 <span className="text-muted-foreground">{audit.modules.length}</span></h3>
        {audit.modules.length > 0 && audit.unavailable.length > 0 && <p className="text-muted-foreground">以下模块已解析，但本轮仍有模块不可用，接入未完成。</p>}
        {audit.modules.length > 0 ? <div className={audit.modules.length > 1 ? 'grid min-w-0 gap-2 sm:grid-cols-2' : 'grid min-w-0 gap-2'}>
          {audit.modules.map(module => <ModuleAuditCard key={module.moduleId} module={module} audit={audit} name={module.displayName ?? moduleNames?.get(module.moduleId) ?? module.moduleId} />)}
        </div> : <p className="rounded-md border border-dashed p-3 text-muted-foreground">{audit.unavailable.length > 0 ? '本轮模块未能接入，原因如下。' : '本轮未选择模块，工具记录仍可在下方查看。'}</p>}
        {audit.unavailable.map(item => <div key={item.moduleId} className="rounded-md border border-destructive/30 bg-destructive/5 p-2.5 text-destructive">
          <p className="font-medium">{moduleNames?.get(item.moduleId) ?? (item.moduleId === 'session-policy' ? '模块设置' : item.moduleId)}</p>
          <p>{UNAVAILABLE_REASONS[item.reason] ?? '模块接入失败，详情见诊断信息。'}</p>
        </div>)}
      </section>
      <ToolAuditSummary tools={audit.tools} />
      <details className="text-[11px] text-muted-foreground">
        <summary className="cursor-pointer rounded py-1 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">诊断信息</summary>
        <div className="mt-1 space-y-1 break-all rounded-md bg-muted/30 p-2">
          <p>运行标识：{audit.runId}</p>
          <p>历史策略：{audit.policyMode} · v{audit.policyRevision}</p>
          {audit.moduleCommandId && <p>模块命令：{audit.moduleCommandId}</p>}
          {audit.unavailable.map(item => <p key={item.moduleId}>{item.moduleId}：{item.reason}</p>)}
        </div>
      </details>
    </CollapsibleContent>
  </Collapsible>
}

/** 按模块身份与版本匹配实际 Skill，声明不冒充成功加载；旧快照保留原接入来源。 */
function ModuleAuditCard({ module, audit, name }: { module: AgentModuleAuditContribution; audit: AgentModuleRunAudit; name: string }): React.ReactElement {
  /** 同一 Skill 可以属于多个模块，必须逐模块匹配身份与版本。 */
  const loadedSkills = audit.activatedSkills.filter(skill => skill.moduleId === module.moduleId && skill.moduleVersion === module.moduleVersion)
  const invocation = module.invocationMode === 'invoke' ? '显式调用' : (module.invocationMode ?? module.mode) === 'pinned' ? '历史固定策略' : '已解析'

  return <article className="min-w-0 space-y-2.5 rounded-md border border-border/60 p-3" aria-label={`模块 ${name}`}>
    <div className="flex items-start justify-between gap-2">
      <h4 className="min-w-0 break-words font-medium">{name}</h4>
      <span className="shrink-0 rounded-full bg-muted px-2 py-0.5 text-[10px] text-muted-foreground">{invocation}</span>
    </div>
    <p className="flex flex-wrap gap-x-3 gap-y-1 text-[11px] text-muted-foreground">
      <span>Skills 已加载 {loadedSkills.length}/{module.skillRefs.length}</span><span>声明提示词 {module.promptRefs.length} 条</span>
    </p>
    {loadedSkills.length > 0 ? <div className="flex flex-wrap gap-1">{loadedSkills.map(skill => <span key={skill.slug} className="max-w-full break-all rounded bg-primary/10 px-1.5 py-0.5 text-[11px] text-primary">{skill.slug}</span>)}</div>
      : <p className="text-[11px] text-muted-foreground">{module.skillRefs.length > 0 ? '尚无 Skill 成功加载记录' : '此模块无需加载 Skill'}</p>}
    <details className="text-[11px] text-muted-foreground">
      <summary className="cursor-pointer rounded focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">模块来源与能力</summary>
      <div className="mt-2 space-y-1 break-all">
        <p>{module.moduleId} @{module.moduleVersion}</p>
        <p>提供 Skills：{module.skillRefs.join('、') || '无'}</p>
        <p>提示引用：{module.promptRefs.join('、') || '无'}</p>
        <p>声明能力：{module.declaredCapabilities.join('、') || '无'}（不代表实际执行）</p>
      </div>
    </details>
  </article>
}

/** 聚合同名工具并支持只看失败，完整调用顺序保留在折叠明细里。 */
function ToolAuditSummary({ tools }: { tools: readonly AgentModuleAuditTool[] }): React.ReactElement {
  /** 筛选只影响明细视图，总计始终保留本轮已记录的全部调用。 */
  const [failedOnly, setFailedOnly] = React.useState(false)
  const summaries = React.useMemo(() => summarizeTools(tools), [tools])
  const completed = tools.filter(tool => tool.status === 'completed').length
  const failed = tools.filter(tool => tool.status === 'failed').length
  const pending = tools.length - completed - failed
  const visibleSummaries = failedOnly ? summaries.filter(summary => summary.failed > 0) : summaries

  return <section className="space-y-2" aria-label="本轮工具调用">
    <div className="flex flex-wrap items-center justify-between gap-2">
      <h3 className="flex items-center gap-1.5 font-medium"><Wrench className="size-3.5" aria-hidden="true" />整轮工具调用 <span className="text-muted-foreground">{tools.length} 次</span></h3>
      {failed > 0 && <Button type="button" size="sm" variant={failedOnly ? 'secondary' : 'ghost'} className="h-6 px-2 text-[11px]" aria-pressed={failedOnly} onClick={() => setFailedOnly(value => !value)}>只看失败</Button>}
    </div>
    <p className="text-[11px] text-muted-foreground">包含本轮全部工具；记录未区分具体模块归属。</p>
    {tools.length > 0 ? <>
      <div className="flex flex-wrap gap-x-3 gap-y-1 text-[11px]">
        <span className="text-muted-foreground">完成 {completed}</span>
        {failed > 0 && <span className="text-destructive">失败 {failed}</span>}
        {pending > 0 && <span className="text-muted-foreground">未收到结果 {pending}</span>}
      </div>
      <div className="max-h-52 divide-y divide-border/50 overflow-y-auto rounded-md border border-border/60">
        {visibleSummaries.map(summary => <div key={summary.toolName} data-testid="audit-tool-summary" className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 px-2.5 py-2">
          <span className="min-w-0 break-all font-mono text-[11px]">{summary.toolName}</span>
          <span className="flex flex-wrap gap-x-2 text-[11px] text-muted-foreground">
            <span>{failedOnly ? summary.failed : summary.count} 次</span>
            {!failedOnly && summary.completed > 0 && <span>完成 {summary.completed}</span>}
            {summary.failed > 0 && <span className="text-destructive">失败 {summary.failed}</span>}
            {!failedOnly && summary.started > 0 && <span>未收到结果 {summary.started}</span>}
          </span>
        </div>)}
      </div>
      <details className="text-[11px] text-muted-foreground">
        <summary className="cursor-pointer rounded py-1 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">查看调用明细{failedOnly ? '（仅失败）' : ''}</summary>
        <ol className="mt-1 max-h-40 space-y-1 overflow-y-auto rounded-md bg-muted/25 p-2">{tools.map((tool, index) => (!failedOnly || tool.status === 'failed') && <li key={tool.toolUseId} className="flex items-start justify-between gap-2">
          <span className="min-w-0 break-all">{index + 1}. {tool.toolName}</span>
          <span className={`shrink-0 ${tool.status === 'failed' ? 'text-destructive' : 'text-muted-foreground'}`}>{tool.status === 'completed' ? '完成' : tool.status === 'failed' ? '失败' : '未收到结果'}</span>
        </li>)}</ol>
      </details>
    </> : <p className="rounded-md border border-dashed p-3 text-muted-foreground">本轮无工具调用记录。</p>}
  </section>
}
