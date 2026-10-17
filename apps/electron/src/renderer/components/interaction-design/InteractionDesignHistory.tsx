import * as React from 'react'
import { Check, Clock3, Loader2, X } from 'lucide-react'
import type { PrototypeCandidateSummary, PrototypeSnapshot } from '@dutydeck/shared'
import { Button } from '@/components/ui/button'
import { buildPrototypeHistory, filterPrototypeHistory, type PrototypeHistoryEntry, type PrototypeHistoryFilter } from './interaction-design-history'

/** 历史只负责展示与发出用户意图，写入和上下文校验仍由工作区统一处理。 */
interface InteractionDesignHistoryProps {
  /** 当前模块快照，不包含额外候选正文读取。 */
  snapshot: PrototypeSnapshot
  /** 正在预览的候选身份。 */
  previewId?: string
  /** 写操作期间禁用重复提交。 */
  busy: boolean
  /** 当前会话用于限制生成任务取消入口。 */
  sessionId: string
  /** 按身份读取候选并进入预览。 */
  onPreview: (candidate: PrototypeCandidateSummary) => void
  /** 采纳/取消由父层维护快照和错误提示。 */
  onAdopt: (candidateId: string) => void
  onDiscard: (candidateId: string) => void
  /** 恢复正式历史版本，不创建新版本。 */
  onRestore: (revision: number) => void
  /** 删除前由父层冻结目标并打开确认框。 */
  onDelete: (entry: PrototypeHistoryEntry) => void
  /** 取消仍运行的本会话任务。 */
  onCancelJob: (jobId: string) => void
  /** 返回当前稿或打开候选页面目录，并关闭历史弹窗。 */
  onReturn: () => void
  onPages: () => void
}

/** 筛选文字与业务状态一一对应，失败/运行仍在全部记录中如实展示。 */
const FILTERS: { value: PrototypeHistoryFilter; label: string }[] = [
  { value: 'all', label: '全部' }, { value: 'pending', label: '未采纳' },
  { value: 'adopted', label: '已采纳' }, { value: 'cancelled', label: '已取消' },
]
/** 状态文案避免将失败与用户主动取消混淆。 */
const STATUS_LABELS: Record<PrototypeHistoryEntry['status'], string> = {
  pending: '未采纳', adopted: '已采纳', cancelled: '已取消', running: '生成中', failed: '生成失败', interrupted: '已中断',
}

/** 输入合并历史并提供筛选、预览和处理入口；长说明默认折叠以保持列表可浏览。 */
export function InteractionDesignHistory(props: InteractionDesignHistoryProps): React.ReactElement {
  /** 筛选只影响当前打开的历史窗口。 */
  const [filter, setFilter] = React.useState<PrototypeHistoryFilter>('all')
  /** 快照变更时重新派生一次，不加载任何 HTML。 */
  const entries = React.useMemo(() => buildPrototypeHistory(props.snapshot), [props.snapshot])
  /** 当前筛选后的记录，保留最新时间在前。 */
  const visible = filterPrototypeHistory(entries, filter)
  return <div className="id-history">
    {props.previewId && <div className="id-history-preview"><span>正在预览候选</span><div><Button size="sm" variant="outline" disabled={props.busy} onClick={props.onPages}>查看页面列表</Button><Button size="sm" variant="outline" disabled={props.busy} onClick={props.onReturn}>返回当前版本</Button></div></div>}
    <div className="id-history-filters" role="group" aria-label="历史状态筛选">{FILTERS.map(item => <button key={item.value} aria-label={`筛选${item.label}`} aria-pressed={filter === item.value} onClick={() => setFilter(item.value)}>{item.label}<span>{filterPrototypeHistory(entries, item.value).length}</span></button>)}</div>
    <div className="id-history-list">{visible.length === 0 ? <p className="id-history-empty">暂无{filter === 'all' ? '历史' : FILTERS.find(item => item.value === filter)?.label}记录</p> : visible.map(entry => {
      /** 当前正式版本只读保护；候选基线不符时保留未采纳状态，但禁止直接覆盖。 */
      const current = entry.version?.revision === props.snapshot.document.revision
      /** 过期候选仍可查看与取消，不能采纳。 */
      const stale = entry.candidate && (entry.candidate.status === 'stale' || entry.candidate.baseRevision !== props.snapshot.document.revision)
      /** 摘要首行提供扫读标题，完整说明保留换行。 */
      const title = entry.summary.split('\n')[0]?.trim().slice(0, 90) || '未填写说明'
      /** 多段说明和超长摘要才展开详情入口。 */
      const hasDetails = entry.summary.trim() !== title
      return <article className="id-history-entry" data-history-key={entry.key} key={entry.key}>
        <div className="id-history-meta"><span className="id-history-status" data-history-status={entry.status}>{entry.status === 'adopted' ? <Check size={12} /> : entry.status === 'cancelled' ? <X size={12} /> : entry.status === 'running' ? <Loader2 size={12} className="animate-spin" /> : <Clock3 size={12} />}{STATUS_LABELS[entry.status]}</span>{current && <span className="id-history-current">当前版本</span>}<time dateTime={new Date(entry.createdAt).toISOString()}>{new Date(entry.createdAt).toLocaleString()}</time></div>
        <strong className="id-history-title">{entry.version ? `v${entry.version.revision} ` : ''}{title}</strong>
        {hasDetails && <details className="id-history-details"><summary>查看完整说明</summary><p>{entry.summary}</p></details>}
        {entry.candidate && <p className="id-history-note">{entry.status === 'pending' && stale ? `基于 v${entry.candidate.baseRevision} · 基线已变化，不能直接采纳` : entry.candidate.adoptedRevision ? `采纳为 v${entry.candidate.adoptedRevision}` : `基于 v${entry.candidate.baseRevision}`}{props.previewId === entry.candidate.id ? ' · 正在预览' : ''}</p>}
        {entry.job?.message && <p className="id-history-note">{entry.job.message}</p>}
        <div className="id-history-actions">
          {entry.kind === 'candidate' && entry.candidate && entry.status === 'pending' && <><Button size="sm" variant="outline" disabled={props.busy} onClick={() => props.onPreview(entry.candidate!)}>预览</Button><Button size="sm" aria-label="采纳候选" disabled={props.busy || stale} onClick={() => props.onAdopt(entry.candidate!.id)}>采纳</Button><Button size="sm" variant="ghost" aria-label="取消候选" disabled={props.busy} onClick={() => props.onDiscard(entry.candidate!.id)}>取消</Button></>}
          {entry.version && <Button size="sm" variant="outline" disabled={props.busy || current} onClick={() => props.onRestore(entry.version!.revision)}>恢复此版本</Button>}
          {entry.job?.status === 'running' && entry.job.sessionId === props.sessionId && <Button size="sm" variant="outline" disabled={props.busy} onClick={() => props.onCancelJob(entry.job!.id)}>取消生成</Button>}
          {!current && entry.job?.status !== 'running' && <Button size="sm" variant="ghost" className="id-history-delete" aria-label={entry.version ? `删除 v${entry.version.revision}` : '删除记录'} disabled={props.busy} onClick={() => props.onDelete(entry)}>删除</Button>}
        </div>
      </article>
    })}</div>
  </div>
}
