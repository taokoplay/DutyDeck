import * as React from 'react'
import { Check, FileText, Folder, Loader2, Pause, Play } from 'lucide-react'
import type { KnowledgeEntry, KnowledgePlan, KnowledgePlanSource, KnowledgeWorkflow } from '@dutydeck/shared'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogTrigger } from '@/components/ui/dialog'

/** 自动接管时提交的最小分组身份和名称。 */
export interface KnowledgePlanSelection {
  id: string
  title: string
}

/** 工作流面板属性；文件读取仍复用知识目录的受控入口。 */
export interface KnowledgeWorkflowPanelProps {
  workflow: KnowledgeWorkflow
  entries: KnowledgeEntry[]
  pendingAction: string | null
  error: string | null
  /** 返回 false 表示自动接管失败，需要打开进度面板提供重试入口。 */
  onConfirm: (groups: KnowledgePlanSelection[]) => Promise<boolean> | boolean | void
  onPause: (paused: boolean) => void
  /** 仅重新处理用户选中的大纲项。 */
  onRetryItem?: (itemId: string) => void
  onSelectEntryId: (entryId: string, expectedRevision?: string) => void
}

/**
 * 把 Agent 已经提出的范围原样交给自动执行流程。
 * @param proposal 当前待确认的权威范围提案。
 * @returns 包含全部分组身份和名称的确认载荷。
 */
export function buildAutomaticKnowledgePlanSelection(proposal: KnowledgePlan): KnowledgePlanSelection[] {
  return proposal.groups.flatMap((group) => {
    const title = group.title.trim()
    return title ? [{ id: group.id, title }] : []
  })
}

/** 整理流程放入独立弹窗；新提案会直接接管，不再要求用户逐组勾选和改名。 */
export function KnowledgeWorkflowDialog(props: KnowledgeWorkflowPanelProps): React.ReactElement | null {
  /** 用户主动查看进度时打开，自动接管不会抢先弹出复杂表单。 */
  const [open, setOpen] = React.useState(false)
  /** 同一提案版本只自动尝试一次，避免轮询快照重复触发确认。 */
  const attemptedProposalRef = React.useRef(new Set<string>())
  /** 异步接管结果只在组件仍挂载时更新弹窗。 */
  const mountedRef = React.useRef(true)
  React.useEffect(() => {
    mountedRef.current = true
    return () => { mountedRef.current = false }
  }, [])
  React.useEffect(() => {
    const proposal = props.workflow.proposal
    if (!proposal || proposal.groups.length === 0 || props.pendingAction !== null) return
    const proposalKey = `${proposal.id}:${proposal.revision}`
    if (attemptedProposalRef.current.has(proposalKey)) return
    attemptedProposalRef.current.add(proposalKey)
    /** 自动确认后同一调用链会提交生成任务；失败时打开可审计的简化进度面板。 */
    void Promise.resolve(props.onConfirm(buildAutomaticKnowledgePlanSelection(proposal)))
      .then((succeeded) => {
        if (mountedRef.current && succeeded === false) setOpen(true)
      })
      .catch(() => {
        if (mountedRef.current) setOpen(true)
      })
  }, [props.onConfirm, props.pendingAction, props.workflow.proposal?.id, props.workflow.proposal?.revision])

  if (!props.workflow.proposal && !props.workflow.approved) return null
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button type="button" size="sm" variant="outline">
          {props.workflow.proposal ? 'Agent 接管中' : props.workflow.paused ? '整理已暂停' : '整理进度'}
        </Button>
      </DialogTrigger>
      <DialogContent className="flex max-h-[85dvh] w-[calc(100%-2rem)] max-w-2xl flex-col overflow-hidden p-0">
        <DialogHeader className="shrink-0 border-b border-border px-5 pb-3 pt-5 pr-12">
          <DialogTitle>知识库整理</DialogTitle>
          <DialogDescription>Agent 会自动确认整理范围并继续生成；这里只展示进度，需要时再查看明细。</DialogDescription>
        </DialogHeader>
        <div className="min-h-0 overflow-y-auto scrollbar-thin">
          <KnowledgeWorkflowPanelView {...props} onSelectEntryId={(entryId, revision) => {
            props.onSelectEntryId(entryId, revision)
            setOpen(false)
          }} />
        </div>
      </DialogContent>
    </Dialog>
  )
}

/** 根据宿主目录和显式读取事实生成来源展示，绝不从 proposal 文案猜测覆盖率。 */
function describePlanSource(source: KnowledgePlanSource, entries: KnowledgeEntry[]): { label: string; status: string } {
  const entry = entries.find((candidate) => candidate.id === source.entryId)
  const location = source.relativePath ?? entry?.source.relativePath ?? entry?.source.id ?? source.entryId
  const title = source.title ?? entry?.title
  const label = title ? `${title} · ${location}` : location
  if (entry?.metadataOnly || source.coverage === 'unsupported') return { label, status: '暂不支持' }
  if (source.coverage === 'read') return { label, status: '已读相关页' }
  return { label, status: '未核对' }
}

/** 返回大纲路径的父文件夹；根目录文件归入“根目录”。 */
function outlineFolder(relativePath: string): string {
  const segments = relativePath.split('/').filter(Boolean)
  return segments.length > 1 ? segments.slice(0, -1).join('/') : '根目录'
}

/** 独立面板保留只读摘要和进度，便于嵌入其他宿主。 */
export function KnowledgeWorkflowPanel(props: KnowledgeWorkflowPanelProps): React.ReactElement {
  return <KnowledgeWorkflowPanelView {...props} />
}

/** 展示自动接管摘要、已确认大纲和暂停状态，不为未生成文件制造链接。 */
function KnowledgeWorkflowPanelView({
  workflow,
  entries,
  pendingAction,
  error,
  onConfirm,
  onPause,
  onRetryItem,
  onSelectEntryId,
}: KnowledgeWorkflowPanelProps): React.ReactElement {
  const proposal = workflow.proposal

  /** 按文件夹聚合大纲，保持 Agent 规划的自由目录结构。 */
  const outlineGroups = React.useMemo(() => {
    const groups = new Map<string, NonNullable<KnowledgeWorkflow['outline']>['items']>()
    for (const item of workflow.outline?.items ?? []) {
      const folder = outlineFolder(item.relativePath)
      groups.set(folder, [...(groups.get(folder) ?? []), item])
    }
    return [...groups.entries()]
  }, [workflow.outline])
  const automaticGroups = proposal ? buildAutomaticKnowledgePlanSelection(proposal) : []
  const busy = pendingAction !== null
  /** 只有宿主确认排队或运行时才允许显示暂停动作。 */
  const running = workflow.execution?.status === 'running' || workflow.execution?.status === 'queued'
  /** 旧工作流不据 paused=false 推断模型还在运行。 */
  const executionLabel = workflow.execution ? ({ queued: '等待执行', running: '正在生成', paused: '已暂停', blocked: '已阻塞', interrupted: '已中断', finished: '本次处理完成' }[workflow.execution.status]) : workflow.paused ? '已暂停' : '未运行'
  /** 将宿主稳定错误分类转为用户可以采取行动的说明。 */
  const executionReasons: Record<string, string> = {
    budget_exhausted: '本段额度已用完，可继续处理剩余项',
    dispatch_failed: '任务准备或提交失败，可重试继续处理',
    queue_cancelled: '排队任务已取消，可继续处理剩余项',
    process_restarted: '应用重启中断了任务，已保存正文保留，可继续处理',
    paused: '已暂停后续处理',
    user_stopped: '已停止本次处理，可继续剩余项',
    run_failed: '本轮处理失败，已保存正文保留，可重试',
    no_progress: '本轮没有新增依据或正文，请检查条目缺口后重试',
  }
  /** 未知分类不直接暴露内部代码。 */
  const executionReason = workflow.execution?.reason ? executionReasons[workflow.execution.reason] ?? '处理已停止，请检查条目详情后重试' : undefined
  /** 汇总已确认大纲状态，说明当前生成进度。 */
  const outlineStatus = React.useMemo(() => {
    const items = workflow.outline?.items ?? []
    return {
      total: items.length,
      ready: items.filter((item) => item.status === 'ready').length,
      partial: items.filter((item) => item.status === 'partial').length,
      pending: items.filter((item) => item.status === 'pending').length,
      missing: items.filter((item) => item.status === 'missing').length,
    }
  }, [workflow.outline])
  /** 只对已保存正文统计内容准入，文件完成不等于事实可自动使用。 */
  const admissionStatus = React.useMemo(() => {
    const saved = (workflow.outline?.items ?? []).filter((item) => item.status === 'ready' || item.status === 'partial')
    const statuses = saved.map((item) => entries.find((entry) => entry.id === item.entryId)?.admission?.status)
    return {
      eligible: statuses.filter((status) => status === 'eligible').length,
      needsEvidence: statuses.filter((status) => status === 'needs_evidence').length,
      unassessed: statuses.filter((status) => status !== 'eligible' && status !== 'needs_evidence').length,
    }
  }, [workflow.outline, entries])
  /** 自动接管前只展示聚合规模，避免把每个来源都变成用户需要处理的控件。 */
  const proposalSummary = React.useMemo(() => ({
    sourceCount: proposal?.groups.reduce((total, group) => total + group.sources.length, 0) ?? 0,
    gapCount: proposal?.groups.reduce((total, group) => total + group.gaps.length, 0) ?? 0,
    outputCount: proposal?.groups.reduce((total, group) => total + group.outputs.length, 0) ?? 0,
  }), [proposal])

  return (
    <section className="space-y-3 border-b border-border bg-muted/10 px-3 py-3" aria-label="知识库生成流程">
      {proposal && (
        <div className="space-y-3 rounded-md border border-border bg-background p-3">
          <div className="rounded-md border border-primary/20 bg-primary/5 px-3 py-2.5 text-xs leading-5">
            <p className="font-medium text-foreground">Agent 已规划好整理范围，正在自动继续</p>
            <p className="mt-1 text-muted-foreground">
              范围确认和后续大纲、正文生成由同一个 Agent 连续完成，不需要逐组设置。原始来源、缺口和产出仍保留在下方明细中。
            </p>
          </div>
          <div className="space-y-2">
            <h3 className="text-sm font-medium text-foreground">本次整理范围</h3>
            <p className="text-xs text-muted-foreground">{proposal.title} · 拟使用目录 {proposal.rootRelativePath}</p>
            <div className="flex flex-wrap gap-1.5 text-[11px] text-muted-foreground">
              <Badge variant="secondary">{proposal.groups.length} 个分组</Badge>
              <Badge variant="outline">{proposalSummary.sourceCount} 份来源</Badge>
              <Badge variant="outline">{proposalSummary.gapCount} 个信息缺口</Badge>
              <Badge variant="outline">{proposalSummary.outputCount} 份预计产出</Badge>
            </div>
          </div>
          <details className="rounded-md border border-border/70">
            <summary className="cursor-pointer px-3 py-2 text-xs font-medium text-foreground">查看 Agent 选定的范围明细</summary>
            <div className="space-y-2 border-t border-border/70 p-2.5">
              {proposal.groups.map((group) => (
                <div key={group.id} className="space-y-2 rounded-md bg-muted/20 p-2.5">
                  <div>
                    <p className="text-xs font-medium text-foreground">{group.title}</p>
                    <p className="mt-1 text-xs leading-5 text-muted-foreground">{group.summary}</p>
                  </div>
                  {group.sources.length > 0 && (
                    <div className="space-y-1" aria-label={`${group.title} 来源`}>
                      {group.sources.map((source) => {
                        const description = describePlanSource(source, entries)
                        return <div key={`${source.entryId}:${source.revision}`} className="flex flex-wrap items-center gap-1.5 text-[11px] text-muted-foreground"><span className="break-all">{description.label}</span><Badge variant="outline">{description.status}</Badge></div>
                      })}
                    </div>
                  )}
                  <div className="flex flex-wrap gap-1.5 text-[11px] text-muted-foreground">
                    <Badge variant="secondary">来源 {group.sources.length} 个</Badge>
                    {group.gaps.map((gap, index) => <Badge key={`${index}:${gap}`} variant="outline">缺口：{gap}</Badge>)}
                    {group.outputs.map((output, index) => <Badge key={`${index}:${output}`} variant="outline">产出：{output}</Badge>)}
                  </div>
                </div>
              ))}
            </div>
          </details>
          <div className="flex items-center justify-between gap-3">
            <p className="text-xs text-muted-foreground">{busy ? '正在把范围交给 Agent 继续处理…' : '自动接管失败时，可在这里重新提交。'}</p>
            <Button type="button" size="sm" disabled={busy || automaticGroups.length === 0} onClick={() => { void onConfirm(automaticGroups) }}>
              {busy ? <Loader2 className="animate-spin" aria-hidden="true" /> : <Check aria-hidden="true" />}
              让 Agent 直接整理
            </Button>
          </div>
        </div>
      )}

      {workflow.approved && (
        <div className="space-y-2 rounded-md border border-border bg-background p-3" data-testid="knowledge-approved-outline">
          <div className="flex flex-wrap items-start justify-between gap-2">
            <div className="min-w-0">
              <h3 className="text-sm font-medium text-foreground">知识库大纲</h3>
              <p className="truncate text-xs text-muted-foreground">{workflow.approved.rootRelativePath} · 已确认 {workflow.approved.groups.length} 个分组</p>
              {workflow.outline && (
                <p className="mt-1 text-xs text-muted-foreground">
                  已保存 {outlineStatus.ready + outlineStatus.partial}/{outlineStatus.total} 篇 · 共 {outlineStatus.total} 项
                  {outlineStatus.ready > 0 && ` · ${outlineStatus.ready} 项已生成`}
                  {outlineStatus.partial > 0 && ` · ${outlineStatus.partial} 项部分完成`}
                  {outlineStatus.pending > 0 && ` · ${outlineStatus.pending} 项等待生成`}
                  {outlineStatus.missing > 0 && ` · ${outlineStatus.missing} 项文件已删除`}
                </p>
              )}
              {workflow.outline && <p className="mt-1 text-xs text-muted-foreground">内容达标 {admissionStatus.eligible} 篇 · 待补依据 {admissionStatus.needsEvidence} 篇 · 尚未评估或已失效 {admissionStatus.unassessed} 篇</p>}
            </div>
            <Button type="button" variant="outline" size="sm" disabled={busy} onClick={() => onPause(running)}>
              {pendingAction === 'pause-workflow' ? <Loader2 className="animate-spin" aria-hidden="true" /> : running ? <Pause aria-hidden="true" /> : <Play aria-hidden="true" />}
              {running ? '暂停生成' : '继续处理'}
            </Button>
          </div>
          <p className="text-xs text-muted-foreground" role="status">{executionLabel}{executionReason ? ` · ${executionReason}` : ''}</p>
          {workflow.paused && <p className="text-xs text-amber-600 dark:text-amber-400">生成已暂停；已写入文件仍可阅读，后续 Agent 发布会被拒绝。</p>}
          {!workflow.outline ? (
            <p className="rounded-md border border-dashed border-border px-3 py-4 text-center text-xs text-muted-foreground">尚未保存大纲；启动处理后将在此显示。</p>
          ) : (
              <div className="space-y-3 border-t border-border/70 px-3 py-3">
                {outlineGroups.map(([folder, items]) => (
                  <div key={folder} className="space-y-1">
                    <div className="flex items-center gap-1.5 text-xs font-medium text-foreground"><Folder className="size-3.5" aria-hidden="true" />{folder}</div>
                    <div className="space-y-1 pl-5">
                      {items.map((item) => {
                        const entry = item.entryId ? entries.find((candidate) => candidate.id === item.entryId) : undefined
                        const readable = Boolean(item.entryId) && (item.status === 'ready' || item.status === 'partial')
                        const statusLabel = item.status === 'ready' ? '已生成' : item.status === 'partial' ? '部分完成' : item.status === 'missing' ? '文件已删除' : '等待生成'
                        /** 内容准入独立于文件是否写入成功。 */
                        const admissionLabel = entry?.admission?.status === 'eligible' ? '内容达标' : entry?.admission?.status === 'needs_evidence' ? '待补依据' : entry?.admission?.status === 'invalidated' ? '评估已失效' : '尚未评估'
                        /** 单项失败说明由宿主持久化，关闭弹窗不会丢失。 */
                        const failure = workflow.execution?.failures[item.id]
                        return (
                          <div key={item.id} className="rounded border border-border/50 p-2 text-xs">
                            <div className="flex items-center gap-2">
                              <FileText className="size-3.5 shrink-0" aria-hidden="true" />
                              {readable && item.entryId ? <button type="button" className="min-w-0 flex-1 truncate text-left hover:underline focus-visible:ring-2 focus-visible:ring-ring" aria-label={`打开${item.title}`} onClick={() => onSelectEntryId(item.entryId!, entry?.revision)}>{item.title}</button> : <span className="min-w-0 flex-1 truncate">{item.title}</span>}
                              <Badge variant="outline">{statusLabel}</Badge>
                            </div>
                            <p className="mt-1 text-muted-foreground">{admissionLabel}</p>
                            {failure && <p className="mt-1 text-destructive">{failure.message}</p>}
                            <details className="mt-2 text-muted-foreground">
                              <summary className="cursor-pointer">用途、来源与内容评估</summary>
                              <div className="mt-2 space-y-1 break-words">
                                <p>用途：{item.summary}</p>
                                {entry?.admission?.purpose && <p>业务价值：{entry.admission.purpose}</p>}
                                {entry?.admission && <>
                                  <p>内容性质：{({ fact: '事实', rule: '业务规则', decision: '决策', procedure: '操作流程', plan: '计划', hypothesis: '假设', history: '历史记录' })[entry.admission.contentType]}</p>
                                  <p>重要程度：{entry.admission.importance === 'high' ? '重要' : '普通'}</p>
                                  {entry.admission.asOf && <p>截至时间：{entry.admission.asOf}</p>}
                                </>}
                                <p>适用范围：{item.scope || entry?.admission?.scope || '尚未说明'}</p>
                                <p>章节：{item.sections.join('、') || '尚未规划'}</p>
                                <p>来源：{item.sources?.map((source) => `${describePlanSource(source, entries).label}（${describePlanSource(source, entries).status}）`).join('；') || '尚未登记逐项来源'}</p>
                                <p>缺口：{item.gaps?.join('；') || '暂无已登记缺口'}</p>
                                {entry?.admission?.issues.map((issue, index) => <p key={index}>待核实：{issue}</p>)}
                                {entry?.admission?.coverage.map((coverage, index) => <p key={index}>{coverage.topic}：{coverage.reason}</p>)}
                              </div>
                            </details>
                            {onRetryItem && (failure || item.status !== 'ready' || admissionLabel !== '内容达标') && <Button type="button" variant="ghost" size="sm" disabled={busy || running} onClick={() => onRetryItem(item.id)}>仅重试此项</Button>}
                          </div>
                        )
                      })}
                    </div>
                  </div>
                ))}
              </div>
          )}
        </div>
      )}
      {error && <p className="text-xs text-destructive" role="alert">{error}</p>}
    </section>
  )
}
