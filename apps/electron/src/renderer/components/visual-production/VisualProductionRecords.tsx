import * as React from 'react'
import { ChevronLeft, History } from 'lucide-react'
import type { VisualCandidate, VisualJob, VisualProductionSnapshot } from '@dutydeck/shared'
import { mergeLegacyVisualShotOutputs, resolveVisualShotOutputs } from '@dutydeck/shared'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogTrigger } from '@/components/ui/dialog'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { buildVisualRetryPrompt, groupVisualRecords, visualCandidateReviewState, VISUAL_KIND_LABELS, type VisualProductionRecord, type VisualRecordTab } from './model'
import { VisualMediaView } from './VisualMediaView'
import { SHOT_MEDIA_KINDS, SHOT_MEDIA_LABELS } from './shot-media-model'

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
  /** 分镜素材位直接打开指定候选，每次点击使用新请求对象。 */
  previewRequest?: { id: string; sequence: number } | null
  /** 记录打开期间暂停所有背景预览。 */
  onOpenChange: (open: boolean) => void
  /** 采用指定候选，主工作台负责校验最新正式版本。 */
  onAdopt: (candidateId: string) => void
  /** 丢弃指定候选。 */
  onDiscard: (candidateId: string) => void
  /** 取消指定运行任务。 */
  onCancel: (jobId: string) => void
  /** 将失败任务的要求引用到主 Agent 对话。 */
  onRetry: (job: VisualJob) => void
  /** 将视频候选的审片要求引用到主 Agent，不自动发送。 */
  onReview: (candidate: VisualCandidate) => void
}
/** 阶段来自真实制作任务，不推算供应商进度。 */
const JOB_STAGE_LABELS = { preparing: '准备参考素材', generating: '生成媒体中', reviewing: '检查生成结果' }
/** 完整状态名称供卡片和详情共用。 */
const CANDIDATE_LABELS = { ready: '待采用', stale: '已过期', adopted: '已采用', discarded: '已丢弃' }
/** 页签名称与顺序固定，空状态页签也保留，避免数量变化时入口跳动。 */
const RECORD_TAB_LABELS: Record<VisualRecordTab, string> = { all: '全部', running: '进行中', pending: '待采用', adopted: '已采用', failed: '失败/中断', stale: '已过期', closed: '已结束' }
/** 媒体运行回执使用真实阶段，未知供应商阶段原样保留。 */
const MEDIA_PHASE_LABELS: Record<string, string> = { prepared: '待执行', queued: '排队中', running: '生成中', completed: '已完成', succeeded: '已完成', failed: '失败', cancelled: '已取消', interrupted: '已中断' }
/** 视频候选审核状态使用业务语言，不展示英文枚举。 */
const REVIEW_STATUS_LABELS = { passed: '通过', warning: '有警告', failed: '未通过', pending: '未完成' } as const
const REVIEW_GATE_LABELS = { technical: '技术', motion: '动作', continuity: '衔接' } as const
/** 状态页签按固定顺序渲染，供键盘左右切换。 */
const RECORD_TABS = Object.keys(RECORD_TAB_LABELS) as VisualRecordTab[]
/** 空列表明确对应的状态范围，取消和丢弃不归为生成失败。 */
const RECORD_EMPTY_LABELS: Record<VisualRecordTab, string> = { all: '暂无制作记录，向旁边的 Agent 描述制作要求即可开始。', running: '暂无进行中的任务', pending: '暂无待采用的结果', adopted: '暂无已采用的结果', failed: '暂无失败或中断的任务', stale: '暂无已过期的结果', closed: '暂无已结束的任务；已取消和已丢弃的记录会显示在这里。' }

/** 顶部统一入口与单一弹窗，候选预览在弹窗内切换，不叠加第二层模态窗口。 */
export function VisualProductionRecords({ sessionId, snapshot, paneActive, busy, error, previewRequest, onOpenChange, onAdopt, onDiscard, onCancel, onRetry, onReview }: VisualProductionRecordsProps): React.ReactElement {
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
  /** 由素材位打开后还原原按钮焦点，不跳到顶部制作记录入口。 */
  const opener = React.useRef<HTMLElement | null>(null)
  /** 最新回调避免父级重渲染反复执行打开副作用。 */
  const openCallback = React.useRef(onOpenChange)
  openCallback.current = onOpenChange
  /** 两侧对比共享媒体索引，避免逐槽扫描媒体库。 */
  const mediaById = React.useMemo(() => new Map(snapshot.media.map(item => [item.id, item])), [snapshot.media])
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
  React.useEffect(() => { if (!paneActive) { setOpen(false); openCallback.current(false) } }, [paneActive])
  React.useEffect(() => {
    if (!previewRequest) return
    opener.current = document.activeElement instanceof HTMLElement ? document.activeElement : null
    setCandidateId(previewRequest.id); setOpen(true); setTab('pending'); openCallback.current(true)
  }, [previewRequest])
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
    if (next) opener.current = document.activeElement instanceof HTMLElement ? document.activeElement : null
    setOpen(next); setCandidateId(null); setTab('all')
    onOpenChange(next)
  }
  /** 返回时保留原筛选；结果状态已变化则定位到它的新页签，避免返回空列表。 */
  const backToRecords = (): void => {
    /** 根据最新快照找到当前预览所在任务，兼容采用或丢弃后的状态改变。 */
    const record = groups.records.find(item => item.candidates.some(candidate => candidate.id === candidateId))
    if (tab !== 'all' && record && record.status !== tab) setTab(record.status)
    setCandidateId(null)
  }
  /** 计算单镜头候选实际替换的输出种类，避免把影片候选误标成泛化候选。 */
  const changedMediaKinds = (item: VisualCandidate): Array<typeof SHOT_MEDIA_KINDS[number]> => {
    const shotId = snapshot.jobs.find(job => job.id === item.jobId)?.shotId
    const currentShot = shotId ? snapshot.document.shots.find(shot => shot.id === shotId) : undefined
    const proposedShot = shotId ? item.draft.shots.find(shot => shot.id === shotId) : undefined
    if (!proposedShot) return []
    const current = currentShot ? resolveVisualShotOutputs(currentShot, mediaById) : { image: null, video: null, audio: null }
    const proposed = resolveVisualShotOutputs(mergeLegacyVisualShotOutputs(proposedShot, currentShot, mediaById), mediaById)
    return SHOT_MEDIA_KINDS.filter(kind => current[kind] !== proposed[kind])
  }
  /** 候选操作复用主工作台的受控写入；过期结果明确不可采用。 */
  const candidateActions = (item: VisualCandidate, preview: boolean): React.ReactElement => {
    const changedKinds = changedMediaKinds(item)
    const reviewState = visualCandidateReviewState(item)
    const reviewBlocked = reviewState === 'missing' || reviewState === 'pending' || reviewState === 'failed'
    const adoptLabel = reviewState === 'missing' ? '待审核' : reviewState === 'pending' ? '审核未完成' : reviewState === 'failed' ? '审核未通过' : changedKinds.length === 1 ? `采用${SHOT_MEDIA_LABELS[changedKinds[0]!]}` : '采用候选'
    return <div className="vp-row vp-record-actions">
    {preview && <Button variant="outline" size="sm" onClick={() => setCandidateId(item.id)}>预览</Button>}
    {item.status === 'ready' && item.reviewRequired && (reviewState === 'missing' || reviewState === 'pending') && <span className="vp-auto-review-state">Agent 审核步骤中</span>}
    {item.status === 'ready' && item.reviewRequired && (reviewState === 'ready' || reviewState === 'failed') && <Button variant="outline" size="sm" disabled={busy} onClick={() => onReview(item)}>引用 Agent 复审</Button>}
    {item.status === 'ready' && <Button size="sm" disabled={busy || reviewBlocked || item.baseRevision !== snapshot.document.revision} title={reviewBlocked ? '技术、动作与衔接审核通过后可采用' : undefined} onClick={() => onAdopt(item.id)}>{adoptLabel}</Button>}
    {(item.status === 'ready' || item.status === 'stale') && <Button variant="ghost" size="sm" disabled={busy} onClick={() => onDiscard(item.id)}>丢弃</Button>}
    </div>
  }
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
      {item.reviewRequired && <section className="vp-candidate-review" aria-label="视频候选审核">
        <div className="vp-candidate-review-gates">
          <span className="vp-candidate-review-title">视频审核</span>
          {(['technical', 'motion', 'continuity'] as const).map(gate => {
            /** 未有审核记录时三个门禁统一显示未完成，避免缺项被误认为通过。 */
            const status = item.review?.[gate] ?? 'pending'
            return <span key={gate} className="vp-candidate-review-gate" data-status={status}><b>{REVIEW_GATE_LABELS[gate]}</b>{REVIEW_STATUS_LABELS[status]}</span>
          })}
        </div>
        {item.review?.conclusion && <p>{item.review.conclusion}</p>}
        {!!item.review?.issues.length && <ul>{item.review.issues.map((issue, index) => <li key={`${issue.gate}:${issue.atSeconds ?? 'all'}:${index}`} data-severity={issue.severity}><span>{REVIEW_GATE_LABELS[issue.gate]}{issue.atSeconds === undefined ? '' : ` · ${issue.atSeconds.toFixed(1)}s`}</span>{issue.message}</li>)}</ul>}
        {!item.review && <p className="vp-muted">Agent 将自动审核技术、动作和前后镜衔接，完成前不能采用。</p>}
        {!!item.review?.unchecked.length && <p className="vp-muted">未检查：{item.review.unchecked.join('；')}</p>}
      </section>}
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
    <DialogContent className="vp-dialog vp-records-dialog sm:max-w-[760px]" onOpenAutoFocus={event => { event.preventDefault(); heading.current?.focus() }} onCloseAutoFocus={event => { if (opener.current?.isConnected) { event.preventDefault(); opener.current.focus({ preventScroll: true }) } }}>
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
            {candidate.draft.episodes.some(item => item.script) && <section className="vp-card"><h3>结构化剧本</h3>{candidate.draft.episodes.filter(item => item.script).map(item => <div key={item.id} className="vp-card">
              <strong>{item.title}</strong><p className="vp-summary">{item.script!.logline || '未填写一句话故事'}</p>
              <p className="vp-muted">{item.script!.beats.length} 个叙事节拍 · 目标 {item.script!.targetDurationSeconds || 0}s · {new Set(item.script!.beats.flatMap(beat => beat.shotIds)).size} 个映射镜头</p>
            </div>)}</section>}
            <section className="vp-card"><h3>资产（{candidate.draft.assets.length}）</h3>{candidate.draft.assets.map(item => <div key={item.id} className="vp-card"><strong>{item.name} · {item.type}{item.locked ? ' · 锁定' : ''}</strong><p className="vp-summary">{item.description}</p>{item.mediaId && <VisualMediaView active={paneActive} sessionId={sessionId} productionId={snapshot.document.id} media={snapshot.media.find(media => media.id === item.mediaId)} />}</div>)}</section>
          </>}
          <h3>{candidateShotId ? '指定镜头对比' : `镜头（${candidate.draft.shots.length}）`}</h3>
          {candidate.draft.shots.filter(item => !candidateShotId || item.id === candidateShotId).map(item => {
            /** 旧候选只声明一个输出，其余素材在采用时保留；预览采用同样规则。 */
            const currentShot = snapshot.document.shots.find(shot => shot.id === item.id)
            const current = currentShot ? resolveVisualShotOutputs(currentShot, mediaById) : { image: null, video: null, audio: null }
            const proposed = resolveVisualShotOutputs(mergeLegacyVisualShotOutputs(item, currentShot, mediaById), mediaById)
            return <section className="vp-card" key={item.id}>
              <h3>{item.title}</h3>{SHOT_MEDIA_KINDS.filter(kind => current[kind] || proposed[kind]).map(kind => <div key={kind} className="vp-candidate-output" data-candidate-output={kind}>
                <h4>{SHOT_MEDIA_LABELS[kind]}{current[kind] === proposed[kind] ? ' · 保留' : ' · 更新'}</h4><div className="vp-grid">
                  <figure><figcaption className="vp-muted">当前已采用</figcaption>{current[kind] ? <VisualMediaView controls active={paneActive && open} sessionId={sessionId} productionId={snapshot.document.id} media={mediaById.get(current[kind]!)} /> : <div className="vp-output-empty">尚未采用{SHOT_MEDIA_LABELS[kind]}</div>}</figure>
                  <figure><figcaption className="vp-muted">本次候选</figcaption>{proposed[kind] ? <VisualMediaView controls active={paneActive && open} sessionId={sessionId} productionId={snapshot.document.id} media={mediaById.get(proposed[kind]!)} /> : <div className="vp-output-empty">清空{SHOT_MEDIA_LABELS[kind]}</div>}</figure>
                </div>
              </div>)}<p className="vp-summary">{item.scene}</p>
            </section>
          })}
          {candidate.status === 'stale' && <p className="vp-muted">作品已更新，此候选需基于最新版本重新制作。</p>}
        </> : <TabsContent value={tab} className="vp-records-panel">{records.length ? records.map(renderRecord) : <p className="vp-records-empty">{RECORD_EMPTY_LABELS[tab]}</p>}</TabsContent>}
      </div>
      </Tabs>
      {candidate && (candidate.status === 'ready' || candidate.status === 'stale') && <footer className="vp-form-footer">{candidateActions(candidate, false)}</footer>}
    </DialogContent>
  </Dialog>
}
