import * as React from 'react'
import { ChevronLeft, History } from 'lucide-react'
import type { VisualCandidate, VisualJob, VisualProductionSnapshot } from '@dutydeck/shared'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogTrigger } from '@/components/ui/dialog'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { buildVisualRetryPrompt, groupVisualRecords, VISUAL_KIND_LABELS, type VisualProductionRecord, type VisualRecordTab } from './model'
import { VisualMediaView } from './VisualMediaView'

/** 原有版本与写入校验由工作台执行，记录弹窗只负责浏览和发起操作。 */
interface VisualProductionRecordsProps {
  /** 当前会话，用于读取候选媒体。 */
  sessionId: string
  /** 当前作品的最新任务、候选与正式内容。 */
  snapshot: VisualProductionSnapshot
  /** 隐藏工作台时关闭弹窗并停止媒体。 */
  paneActive: boolean
  /** 写入期间禁用重复操作。 */
  busy: boolean
  /** 将写入失败展示在用户正在操作的弹窗内。 */
  error: string
  /** 打开记录时暂停背景预演。 */
  onOpen: () => void
  /** 采用指定候选，主工作台负责校验最新正式版本。 */
  onAdopt: (candidateId: string) => void
  /** 丢弃指定候选。 */
  onDiscard: (candidateId: string) => void
  /** 取消指定运行任务。 */
  onCancel: (jobId: string) => void
  /** 将失败任务的要求引用到主 Agent 对话。 */
  onRetry: (job: VisualJob) => void
}
/** 阶段来自真实制作任务，不推算供应商进度。 */
const JOB_STAGE_LABELS = { preparing: '准备参考素材', generating: '生成媒体中', reviewing: '检查生成结果' }
/** 完整状态名称供卡片和详情共用。 */
const CANDIDATE_LABELS = { ready: '待采用', stale: '已过期', adopted: '已采用', discarded: '已丢弃' }
/** 页签名称与顺序固定，空状态页签也保留，避免数量变化时入口跳动。 */
const RECORD_TAB_LABELS: Record<VisualRecordTab, string> = { all: '全部', running: '进行中', pending: '待采用', adopted: '已采用', failed: '失败/中断', stale: '已过期', closed: '已结束' }
/** 媒体运行回执使用真实阶段，未知供应商阶段原样保留。 */
const MEDIA_PHASE_LABELS: Record<string, string> = { prepared: '待执行', queued: '排队中', running: '生成中', completed: '已完成', succeeded: '已完成', failed: '失败', cancelled: '已取消', interrupted: '已中断' }
/** 状态页签按固定顺序渲染，供键盘左右切换。 */
const RECORD_TABS = Object.keys(RECORD_TAB_LABELS) as VisualRecordTab[]
/** 空列表明确对应的状态范围，取消和丢弃不归为生成失败。 */
const RECORD_EMPTY_LABELS: Record<VisualRecordTab, string> = { all: '暂无制作记录，向旁边的 Agent 描述制作要求即可开始。', running: '暂无进行中的任务', pending: '暂无待采用的结果', adopted: '暂无已采用的结果', failed: '暂无失败或中断的任务', stale: '暂无已过期的结果', closed: '暂无已结束的任务；已取消和已丢弃的记录会显示在这里。' }

/** 顶部统一入口与单一弹窗，候选预览在弹窗内切换，不叠加第二层模态窗口。 */
export function VisualProductionRecords({ sessionId, snapshot, paneActive, busy, error, onOpen, onAdopt, onDiscard, onCancel, onRetry }: VisualProductionRecordsProps): React.ReactElement {
  /** 弹窗关闭后只保留轻量入口，不挂载完整列表。 */
  const [open, setOpen] = React.useState(false)
  /** 候选身份为空时显示记录列表。 */
  const [candidateId, setCandidateId] = React.useState<string | null>(null)
  /** 当前选中的任务状态，后台更新数量时不主动切换用户正在浏览的页签。 */
  const [tab, setTab] = React.useState<VisualRecordTab>('all')
  /** 视图切换后聚焦标题，让键盘与读屏继续在同一弹窗内操作。 */
  const heading = React.useRef<HTMLHeadingElement>(null)
  /** 列表与预览切换时复位正文滚动，避免停在上一页底部。 */
  const body = React.useRef<HTMLDivElement>(null)
  /** 返回记录时让选中的状态在窄窗内可见，不移动弹窗或键盘焦点。 */
  const tabList = React.useRef<HTMLDivElement>(null)
  /** 仅在数据变化时合并任务与候选，不读取额外媒体或发起 IPC。 */
  const groups = React.useMemo(() => groupVisualRecords(snapshot), [snapshot.jobs, snapshot.candidates])
  /** 只渲染当前状态的任务，隐藏页签不挂载长指令和媒体。 */
  const records = React.useMemo(() => tab === 'all' ? groups.records : groups.records.filter(item => item.status === tab), [groups, tab])
  /** 顶部入口和状态页签使用同一计数来源。 */
  const counts = groups.counts
  /** 始终从最新快照解析，采用后预览即时显示已采用状态。 */
  const candidate = snapshot.candidates.find(item => item.id === candidateId)
  /** 单镜头候选只展开自身对比，整部候选保留完整设定。 */
  const candidateShotId = snapshot.jobs.find(item => item.id === candidate?.jobId)?.shotId
  /** 宽面板展示分项数量，窄面板用合计与无障碍名称保留信息。 */
  const countSummary = [counts.running ? `${counts.running} 进行中` : '', counts.pending ? `${counts.pending} 待采用` : '', counts.stale ? `${counts.stale} 需更新` : ''].filter(Boolean).join(' · ')
  React.useEffect(() => { if (!paneActive) setOpen(false) }, [paneActive])
  React.useEffect(() => {
    if (!open) return
    heading.current?.focus()
    if (body.current) body.current.scrollTop = 0
  }, [candidateId, open])
  /** 切换筛选只复位列表滚动，焦点留在 Tabs，保留方向键连续操作。 */
  React.useEffect(() => { if (body.current) body.current.scrollTop = 0 }, [tab])
  React.useEffect(() => {
    /** 只调整页签容器的横向滚动，避免原生 scrollIntoView 牵动正文。 */
    const list = tabList.current
    const selected = list?.querySelector<HTMLElement>('[aria-selected="true"]')
    if (!list || !selected) return
    /** 使用布局坐标避免弹窗入场缩放影响距离，预留默认 Tabs 的四像素内边距。 */
    const left = selected.offsetLeft - 4
    const right = selected.offsetLeft + selected.offsetWidth + 4
    if (left < list.scrollLeft) list.scrollLeft = left
    else if (right > list.scrollLeft + list.clientWidth) list.scrollLeft = right - list.clientWidth
  }, [tab, candidateId, open])

  /** 开关弹窗时清理临时浏览状态，正式任务始终继续在后台执行。 */
  const changeOpen = (next: boolean): void => {
    setOpen(next); setCandidateId(null); setTab('all')
    if (next) onOpen()
  }
  /** 返回时保留原筛选；结果状态已变化则定位到它的新页签，避免返回空列表。 */
  const backToRecords = (): void => {
    /** 根据最新快照找到当前预览所在任务，兼容采用或丢弃后的状态改变。 */
    const record = groups.records.find(item => item.candidates.some(candidate => candidate.id === candidateId))
    if (tab !== 'all' && record && record.status !== tab) setTab(record.status)
    setCandidateId(null)
  }
  /** 候选操作复用主工作台的受控写入；过期结果明确不可采用。 */
  const candidateActions = (item: VisualCandidate, preview: boolean): React.ReactElement => <div className="vp-row vp-record-actions">
    {preview && <Button variant="outline" size="sm" onClick={() => setCandidateId(item.id)}>预览</Button>}
    {item.status === 'ready' && <Button size="sm" disabled={busy || item.baseRevision !== snapshot.document.revision} onClick={() => onAdopt(item.id)}>采用候选</Button>}
    {(item.status === 'ready' || item.status === 'stale') && <Button variant="ghost" size="sm" disabled={busy} onClick={() => onDiscard(item.id)}>丢弃</Button>}
  </div>
  /** 一条任务只渲染一张记录卡片，完整指令与失败信息由详情展开。 */
  const renderRecord = ({ job, candidates }: VisualProductionRecord): React.ReactElement => <article className="vp-record" key={job.id} data-job-id={job.id}>
    <div className="vp-record-heading">
      <h3 className="vp-record-title">{candidates[0]?.summary || job.instruction}</h3>
      {!candidates.length && <span className="vp-badge">{job.status === 'running' && job.stage ? JOB_STAGE_LABELS[job.stage] : ({ running: '处理中', candidate: '候选已提交', failed: '失败', cancelled: '已取消', interrupted: '已中断' })[job.status]}</span>}
    </div>
    <div className="vp-record-meta">
      <span>{job.shotId ? snapshot.document.shots.find(item => item.id === job.shotId)?.title || '原镜头已删除' : '整部作品'}</span>
      <time dateTime={new Date(job.createdAt).toISOString()}>{new Date(job.createdAt).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })}</time>
    </div>
    {job.message && <p className="vp-record-message">{job.message}</p>}
    {candidates.map(item => <div className="vp-record-candidate" key={item.id} data-candidate-id={item.id}>
      <div className="vp-record-heading">{candidates.length > 1 && <span className="vp-record-title">{item.summary}</span>}<span className="vp-badge">{CANDIDATE_LABELS[item.status]}</span><span className="vp-muted">基于版本 {item.baseRevision}</span></div>
      {item.status === 'stale' && <p className="vp-muted">作品已更新，此候选需基于最新版本重新制作。</p>}
      {candidateActions(item, true)}
    </div>)}
    <div className="vp-row vp-record-actions">
      {job.status === 'running' && <Button variant="outline" size="sm" disabled={busy} onClick={() => onCancel(job.id)}>取消任务</Button>}
      {buildVisualRetryPrompt(snapshot.document, job) && <Button variant="outline" size="sm" disabled={busy} onClick={() => { onRetry(job); changeOpen(false) }}>引用到 Agent 重试</Button>}
    </div>
    {!!job.mediaExecutions?.length && <details className="vp-record-details"><summary>媒体执行（{job.mediaExecutions.length}）</summary>{job.mediaExecutions.map(execution => <section className="vp-media-receipt" key={execution.runId}>
      <div className="vp-row"><strong>{execution.name}</strong><span className="vp-badge">{({ image: '图片', video: '视频', audio: '声音' })[execution.kind]}</span><span className="vp-muted">最近查询：{MEDIA_PHASE_LABELS[execution.phase] ?? execution.phase}</span></div>
      <dl><dt>创建时间</dt><dd>{new Date(execution.createdAt).toLocaleString('zh-CN')}</dd><dt>运行标识</dt><dd>{execution.runId}</dd><dt>实际来源</dt><dd>{execution.source.type === 'model' ? execution.source.modelRef : `ComfyUI · ${execution.source.connectionId} / ${execution.source.workflowId} · v${execution.source.workflowRevision}`}</dd><dt>实际参数</dt><dd>{Object.entries(execution.parameters).map(([key, value]) => `${key}: ${value}`).join(' · ') || '使用服务默认值'}</dd><dt>参考素材</dt><dd>{execution.referenceAssets.length ? execution.referenceAssets.map(asset => `${asset.mediaKind} · ${asset.assetId}`).join('\n') : '无参考素材'}</dd>{execution.prompt && <><dt>提示词</dt><dd>{execution.prompt}</dd></>}</dl>
    </section>)}</details>}
    <details className="vp-record-details"><summary>任务详情</summary><p className="vp-summary">{job.instruction}</p>{job.message && <p className="vp-summary">{job.message}</p>}</details>
  </article>

  return <Dialog open={open} onOpenChange={changeOpen}>
    <DialogTrigger asChild><Button variant="ghost" size="sm" className="vp-records-trigger" aria-label={`制作记录${countSummary ? ` · ${countSummary}` : ''}`} title={countSummary || '查看制作任务和候选结果'}>
      <History size={14} /><span>制作记录</span>{countSummary && <><span className="vp-records-counts">{countSummary}</span><span className="vp-records-count" aria-hidden="true">{counts.running + counts.pending + counts.stale}</span></>}
    </Button></DialogTrigger>
    <DialogContent className="vp-dialog vp-records-dialog sm:max-w-[760px]" onOpenAutoFocus={event => { event.preventDefault(); heading.current?.focus() }}>
      <DialogHeader><DialogTitle ref={heading} tabIndex={-1}>{candidate ? '候选预览' : '制作记录'}</DialogTitle><DialogDescription>{candidate ? `预览不会替换正式内容。基于版本 ${candidate.baseRevision}。` : '查看制作进度，预览并采用 Agent 提交的结果。'}</DialogDescription></DialogHeader>
      {error && <p role="alert" className="vp-error">{error}</p>}
      <Tabs value={tab} onValueChange={value => setTab(value as VisualRecordTab)} className="vp-records-tabs-layout">
        {!candidate && <TabsList ref={tabList} className="vp-records-tabs" aria-label="制作记录状态">{RECORD_TABS.map(value => <TabsTrigger key={value} value={value} data-record-status={value} aria-label={`${RECORD_TAB_LABELS[value]}，${counts[value]} 条任务`}>
          {RECORD_TAB_LABELS[value]}<span className="vp-records-tab-count">{counts[value]}</span>
        </TabsTrigger>)}</TabsList>}
      <div ref={body} className="vp-form-body vp-records-body">
        {candidate ? <>
          <div className="vp-row"><Button variant="ghost" size="sm" onClick={backToRecords}><ChevronLeft size={14} />返回记录</Button><span className="vp-badge">{CANDIDATE_LABELS[candidate.status]}</span></div>
          <p className="vp-summary">{candidate.summary}</p>
          {!candidateShotId && <>
            <section className="vp-card"><h3>作品设定</h3><p>{candidate.draft.title} · {VISUAL_KIND_LABELS[candidate.draft.kind]} · {candidate.draft.ratio} · {candidate.draft.fps} fps</p><p className="vp-summary">{candidate.draft.brief || '未填写作品目标'}</p><p className="vp-muted">配音：{candidate.draft.voice || '未设置'} · 音乐：{candidate.draft.music || '未设置'}</p></section>
            <section className="vp-card"><h3>集数（{candidate.draft.episodes.length}）</h3>{candidate.draft.episodes.map(item => <p key={item.id}>{item.title}</p>)}</section>
            <section className="vp-card"><h3>资产（{candidate.draft.assets.length}）</h3>{candidate.draft.assets.map(item => <div key={item.id} className="vp-card"><strong>{item.name} · {item.type}{item.locked ? ' · 锁定' : ''}</strong><p className="vp-summary">{item.description}</p>{item.mediaId && <VisualMediaView active={paneActive} sessionId={sessionId} productionId={snapshot.document.id} media={snapshot.media.find(media => media.id === item.mediaId)} />}</div>)}</section>
          </>}
          <h3>{candidateShotId ? '指定镜头对比' : `镜头（${candidate.draft.shots.length}）`}</h3>
          {candidate.draft.shots.filter(item => !candidateShotId || item.id === candidateShotId).map(item => <section className="vp-card" key={item.id}>
            <h3>{item.title}</h3><div className="vp-grid">
              <figure><figcaption className="vp-muted">当前已采用</figcaption><VisualMediaView controls active={paneActive} sessionId={sessionId} productionId={snapshot.document.id} media={snapshot.media.find(media => media.id === snapshot.document.shots.find(shot => shot.id === item.id)?.mediaId)} /></figure>
              <figure><figcaption className="vp-muted">本次候选</figcaption><VisualMediaView controls active={paneActive} sessionId={sessionId} productionId={snapshot.document.id} media={snapshot.media.find(media => media.id === item.mediaId)} /></figure>
            </div><p className="vp-summary">{item.scene}</p>
          </section>)}
          {candidate.status === 'stale' && <p className="vp-muted">作品已更新，此候选需基于最新版本重新制作。</p>}
        </> : <TabsContent value={tab} className="vp-records-panel">{records.length ? records.map(renderRecord) : <p className="vp-records-empty">{RECORD_EMPTY_LABELS[tab]}</p>}</TabsContent>}
      </div>
      </Tabs>
      {candidate && (candidate.status === 'ready' || candidate.status === 'stale') && <footer className="vp-form-footer">{candidateActions(candidate, false)}</footer>}
    </DialogContent>
  </Dialog>
}
