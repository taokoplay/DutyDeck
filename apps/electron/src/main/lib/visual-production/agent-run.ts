import type { VisualCandidate, VisualCandidateReview, VisualProductionInputs, VisualProductionMethod, VisualProductionResults, VisualProductionSnapshot, VisualJob } from '@dutydeck/shared'
import type { VisualProductionExecutor } from './access'
import type { AgentCompletionEvaluation } from '../agent-completion-policy'

/**
 * 影像各阶段共用总续行预算，避免纠偏后的复审退回通用三次额度。
 * @param message 本次有界的发现、生成、审查或修正指令；空值表示无需续行。
 * @returns 同一 Agent 的完成判断；独立纠偏次数仍由运行队列限制。
 */
export function buildVisualCompletionEvaluation(message: string | null): AgentCompletionEvaluation {
  return message ? { action: 'continue', message, continuationLimit: 12 } : { action: 'complete' }
}

/** 本轮任务中尚待同一 Agent 完成的审片候选。 */
export interface PendingVisualReviewStep {
  productionId: string
  productionRevision: number
  candidateId: string
  jobId: string
  shotId?: string
  summary: string
}

/** 本轮失败候选的定向修正依据；不包含媒体字节或新的执行授权。 */
export interface PendingVisualRepairStep extends PendingVisualReviewStep {
  /** 当前候选实际保存的审核结论，供下一次指令继承约束。 */
  review: VisualCandidateReview
}

/** 每轮运行的纠偏续行上限；限制模型循环，不代替媒体调用预算。 */
const MAX_VISUAL_REPAIR_ROUNDS = 2

/**
 * 将失败证据转成同一 Agent 的修正任务，不能把审核失败当作新调用授权。
 * @param pending 本轮首次交付的有效失败候选。
 * @returns 定向修正要求；没有候选时为空。
 */
export function buildVisualRepairStepContinuation(pending: readonly PendingVisualRepairStep[]): string | null {
  if (!pending.length) return null
  /** 限制单次证据正文；完整结论仍可从正式候选读取。 */
  const targets = pending.slice(0, 8).map(item => `- ${JSON.stringify({ productionId: item.productionId, revision: item.productionRevision, shotId: item.shotId, candidateId: item.candidateId, conclusion: item.review.conclusion.slice(0, 1000), issues: item.review.issues.slice(0, 8), unchecked: item.review.unchecked.slice(0, 4) })}`).join('\n')
  return `本轮候选已发现硬失败，继续执行缺陷驱动修正步骤，不能仅报告“审核未通过”就结束。先形成“问题及时间点→依据→最小修正范围→继承已通过约束→新指令→复验标准”，保存到后续 job.instruction；失败候选保留且不得采用。核对剩余授权、调用次数/预算与真实处理能力，只在范围内读取最新版本并修正目标镜头计划、begin_job 新任务；每次新产物都要重新审查hash，并与前版相同时间窗比较。缺少实际听验只代表证据缺口，不能盲目重生成音频。无改善、缺能力、缺授权/预算或用户停止时，报告具体阻塞与可执行下一步。Host 每轮最多两次纠偏续行，这不是外传素材、收费重试或修改锁定资产的授权。\n${targets}`
}

/** 本轮视频任务中尚未完成的工作流发现步骤。 */
export interface PendingVisualWorkflowDiscoveryStep {
  productionId: string
  productionRevision: number
  jobId: string
  shotId?: string
  connectionId: string
  mediaKind: 'image' | 'video' | 'audio'
  status: NonNullable<VisualJob['workflowDiscovery']>['status']
  candidateCount: number
  nextOffset: number | null
  message?: string
}

/** 本轮仍在运行、尚未进入候选或失败终态的影像任务。 */
export interface PendingVisualMediaStep {
  productionId: string
  productionRevision: number
  jobId: string
  shotId?: string
  instruction: string
  stage?: VisualJob['stage']
  mediaRunId?: string
  mediaPhase?: string
  mediaEngine?: 'model' | 'workflow'
}

/** 已提交且仍由远端或收集器推进的阶段，Host 可以直接托管等待。 */
const HOST_WAITABLE_MEDIA_PHASES = new Set([
  'uploading', 'compiling', 'submitting', 'submission-unknown', 'queued', 'running',
  'collecting', 'collection-failed', 'cancel-requested',
])

/**
 * 构造完成门禁的续行要求，让同一 Agent 在结束前完成影片审核步骤。
 * @param pending 尚未完成审核的候选。
 * @returns 可直接交给 Agent 的续行消息；没有待审项时为空。
 */
export function buildVisualReviewStepContinuation(pending: readonly PendingVisualReviewStep[]): string | null {
  if (!pending.length) return null
  const targets = pending.slice(0, 8).map(item => `- ${item.shotId ? `镜头 ${item.shotId} · ` : ''}${item.summary}（候选 ${item.candidateId}）`).join('\n')
  return `本轮有 ${pending.length} 个新影片或声音候选，当前任务尚未完成审片步骤。不要等待用户点击审核按钮；请在同一个 Agent 任务中继续，打开每个候选及必要前后镜头的上下文，读取 continuityPlan，逐项核对入场/出场、关键动作中间态、叙事和声音接续。inspect 实际视频抽样或音频技术证据，并调用 visual_production_review_candidate（reviewCandidate）保存 technical、motion、continuity；reviewAudioRequired 的候选还必须提交 audio 结论，核对准确台词/角色、声线、语气、旁白、拟音/音效/音乐与混音。未实际听验时 audio=pending 并写 unchecked，不能用 ASR、波形或AAC存在冒充听验。技术失败或已证实缺少用户关键视角、动作、连续性/声音内容时，对应门必须 failed+error，不能用 warning 放行；warning 只限轻微瑕疵，证据不足保持 pending/unchecked，不猜测通过或失败。记录问题时间点；无法取得必要证据时在 unchecked 写清各项缺口、原因与补证下一步，随后报告候选仍待审核、未采用并结束本轮；不重复检查同样的元数据，也不把报告阻塞当作质量通过。\n${targets}`
}

/**
 * 构造工作流发现的 Host 续行要求，防止 Agent 在文件可发现时直接结束或误报缺少工具。
 * @param pending 本轮尚未完成发现或选择的媒体任务。
 * @returns 可直接交给同一 Agent 的续行消息；没有待处理任务时为空。
 */
export function buildVisualWorkflowDiscoveryStepContinuation(
  pending: readonly PendingVisualWorkflowDiscoveryStep[],
): string | null {
  if (!pending.length) return null
  const targets = pending.slice(0, 8).map(item => {
    const shot = item.shotId ? `镜头 ${item.shotId} · ` : ''
    const cursor = item.nextOffset === null ? '当前页已结束' : `下一页 offset=${item.nextOffset}`
    const reason = item.message ? `；说明：${item.message}` : ''
    return `- ${shot}任务 ${item.jobId} · ${item.mediaKind} · 服务 ${item.connectionId} · 状态 ${item.status} · 候选 ${item.candidateCount} · ${cursor}${reason}`
  }).join('\n')
  return `本轮影像任务尚未完成 ComfyUI 工作流发现与精确选择，不能以“工具缺失”“等待用户切换 Canvas”或“服务已连接”结束。请由当前主 Agent 继续使用已注册的 media_discover_workflows，按任务真实输出类别和输入角色检查；沿 nextOffset 读完整目录并调用 media_inspect_workflow 核对候选。选中后必须用 media_use_remote_workflow 返回的精确 workflowId、workflowRevision、contentHash 写入任务；若完整目录确无语义匹配或服务不可用，再调用 visual_production_record_workflow_discovery 保存 no-match/blocked 及具体原因，不能仅凭名称、筛选结果或读取失败判定无匹配。\n${targets}`
}

/**
 * 构造长时媒体任务的 Host 续行要求，避免 Agent 把 media_wait_run 的 running 结果当成结束。
 * @param pending 本轮仍未进入候选或失败终态的影像任务。
 * @returns 同一 Agent 必须继续推进的任务说明；没有活动任务时为空。
 */
export function buildVisualMediaStepContinuation(pending: readonly PendingVisualMediaStep[]): string | null {
  if (!pending.length) return null
  const targets = pending.slice(0, 8).map(item => {
    const shot = item.shotId ? `镜头 ${item.shotId} · ` : ''
    const media = item.mediaRunId
      ? `媒体运行 ${item.mediaRunId} · ${item.mediaPhase ?? '状态未知'}`
      : '尚未记录媒体运行'
    return `- ${shot}任务 ${item.jobId} · ${item.stage ?? '阶段未知'} · ${media}`
  }).join('\n')
  return `本轮仍有 ${pending.length} 个影像任务未进入候选、失败或取消终态，不能以普通成功终态结束。Host 托管等待负责长时媒体任务：不要为了刷新进度重复调用 media_wait_run，也不要重复准备或执行收费请求。工作流发现未完成时先完成发现和选择；媒体运行成功后导入全部输出并调用 visual_production_propose_shot 提交该镜头候选；确认失败时调用 visual_production_fail_job 保存原因；只有候选已提交并完成必要的同回合审片后才能结束。最终回复只说明镜头、当前阶段、候选或失败结果及下一步；除非用户明确要求诊断，不展示 runId、内部工具名或工作流版本。\n${targets}`
}

/** 单轮主会话只结算本轮签发的任务；不扫描、接管其他运行的任务。 */
export function createVisualProductionRun(sessionId: string, access: VisualProductionExecutor, cleanup: VisualProductionExecutor) {
  /** 本轮实际 beginJob 返回的可信身份，不采纳模型提供的任意任务。 */
  const ownedJobs = new Map<string, { job: VisualJob; productionId: string }>()
  /** 同一失败候选只分发一次，避免忽略建议时原地循环。 */
  const deliveredRepairs = new Set<string>()
  /** 只对实际分发修正步骤计数，空队列与过期候选不消耗额度。 */
  let repairRounds = 0
  return {
    /** 只向主进程工具包装器提供本轮签发身份；返回副本防止外部改写冻结配置。 */
    mediaJobs() { return structuredClone([...ownedJobs.values()]) },
    /**
     * 只扫描本轮任务关联的候选，供 Host 防止 Agent 在审片步骤前结束。
     * @returns 尚未记录必需结论或未说明待审证据缺口的候选；质量采用门禁独立保持。
     */
    async pendingReviews(): Promise<PendingVisualReviewStep[]> {
      const snapshots = new Map<string, VisualProductionSnapshot>()
      const pending: PendingVisualReviewStep[] = []
      for (const { job, productionId } of ownedJobs.values()) {
        let current = snapshots.get(productionId)
        if (!current) {
          current = await access.execute('load', { sessionId, productionId })
          snapshots.set(productionId, current)
        }
        for (const candidate of current.candidates.filter((item: VisualCandidate) => item.jobId === job.id && item.status === 'ready' && item.baseRevision === current!.document.revision && item.reviewRequired)) {
          if (candidate.review) {
            const statuses = [candidate.review.technical, candidate.review.motion, candidate.review.continuity, ...(candidate.review.audio ? [candidate.review.audio] : candidate.reviewAudioRequired ? ['pending'] : [])]
            /** 硬失败已形成审片结论，由后续有界纠偏步骤处理。 */
            if (statuses.includes('failed') || candidate.review.issues.some(issue => issue.severity === 'error')) continue
            /** 缺少必需声音结论仍需补审，不能借已有 unchecked 跳过该门。 */
            const hasRequiredConclusions = !candidate.reviewAudioRequired || Boolean(candidate.review.audio)
            /** 审查已说明缺证据时允许报告阻塞；pending 仍由采用门禁拦截，避免反复调度。 */
            if (hasRequiredConclusions && (!statuses.includes('pending') || candidate.review.unchecked.some(item => item.trim().length > 0))) continue
          }
          pending.push({ productionId, productionRevision: current.document.revision, candidateId: candidate.id, jobId: job.id, ...(job.shotId ? { shotId: job.shotId } : {}), summary: candidate.summary })
        }
      }
      return pending
    },
    /**
     * 只向当前运行分发有效失败候选，不接管旧任务或自动发起媒体调用。
     * @returns 本次可处理的失败证据；同一候选不重复分发，最多两轮。
     */
    async takePendingRepairs(): Promise<PendingVisualRepairStep[]> {
      if (repairRounds >= MAX_VISUAL_REPAIR_ROUNDS) return []
      /** 同作品只读取一次快照，避免多镜任务重复读取和扩大上下文。 */
      const snapshots = new Map<string, VisualProductionSnapshot>()
      const pending: PendingVisualRepairStep[] = []
      for (const { job, productionId } of ownedJobs.values()) {
        let current = snapshots.get(productionId)
        if (!current) {
          current = await access.execute('load', { sessionId, productionId })
          snapshots.set(productionId, current)
        }
        for (const candidate of current.candidates) {
          if (candidate.jobId !== job.id || candidate.status !== 'ready' || candidate.baseRevision !== current.document.revision || !candidate.reviewRequired || !candidate.review || deliveredRepairs.has(candidate.id)) continue
          /** 仅有真实硬失败才要求修正，pending、warning 不产生付费重试诱导。 */
          const review = candidate.review
          if (![review.technical, review.motion, review.continuity, review.audio].includes('failed') && !review.issues.some(issue => issue.severity === 'error')) continue
          pending.push({ productionId, productionRevision: current.document.revision, candidateId: candidate.id, jobId: job.id, ...(job.shotId ? { shotId: job.shotId } : {}), summary: candidate.summary, review: structuredClone(review) })
          if (pending.length >= 8) break
        }
        if (pending.length >= 8) break
      }
      if (pending.length) {
        repairRounds++
        for (const item of pending) deliveredRepairs.add(item.candidateId)
      }
      return pending
    },
    /**
     * 只扫描本轮任务自己的工作流发现状态。
     * @returns 仍要求 Agent 扫描候选或提交最终结论的媒体任务。
     */
    async pendingWorkflowDiscoveries(): Promise<PendingVisualWorkflowDiscoveryStep[]> {
      const snapshots = new Map<string, VisualProductionSnapshot>()
      const pending: PendingVisualWorkflowDiscoveryStep[] = []
      for (const { job: owned, productionId } of ownedJobs.values()) {
        let current = snapshots.get(productionId)
        if (!current) {
          current = await access.execute('load', { sessionId, productionId })
          snapshots.set(productionId, current)
        }
        /** 只读取当前持久任务；工具包装器持有的副本不能作为完成证据。 */
        const job = current.jobs.find(item => item.id === owned.id && item.sessionId === sessionId)
        const discovery = job?.workflowDiscovery
        if (!job || job.status !== 'running' || !discovery) continue
        /** selected、no-match、blocked 已是可审计终态；其余状态必须由同一 Agent 继续处理。 */
        if (!['required', 'scanning', 'candidates'].includes(discovery.status)) continue
        pending.push({
          productionId,
          productionRevision: current.document.revision,
          jobId: job.id,
          ...(job.shotId ? { shotId: job.shotId } : {}),
          connectionId: discovery.connectionId,
          mediaKind: discovery.mediaKind,
          status: discovery.status,
          candidateCount: discovery.candidateCount,
          nextOffset: discovery.nextOffset,
          ...(discovery.message ? { message: discovery.message } : {}),
        })
      }
      return pending
    },
    /**
     * 只检查本轮签发且仍为 running 的任务。
     * @returns 尚未提交候选、失败或取消的影像任务及最近媒体运行状态。
     */
    async pendingMediaSteps(): Promise<PendingVisualMediaStep[]> {
      const snapshots = new Map<string, VisualProductionSnapshot>()
      const pending: PendingVisualMediaStep[] = []
      for (const { job: owned, productionId } of ownedJobs.values()) {
        let current = snapshots.get(productionId)
        if (!current) {
          current = await access.execute('load', { sessionId, productionId })
          snapshots.set(productionId, current)
        }
        /** 只以持久化任务为准；内存副本不能证明本轮工作已经结束。 */
        const job = current.jobs.find(item => item.id === owned.id && item.sessionId === sessionId)
        if (job?.status !== 'running') continue
        const execution = [...(job.mediaExecutions ?? [])].sort((left, right) => right.createdAt - left.createdAt)[0]
        pending.push({
          productionId,
          productionRevision: current.document.revision,
          jobId: job.id,
          ...(job.shotId ? { shotId: job.shotId } : {}),
          instruction: job.instruction,
          ...(job.stage ? { stage: job.stage } : {}),
          ...(execution ? { mediaRunId: execution.runId, mediaPhase: execution.phase, mediaEngine: execution.engine } : {}),
        })
      }
      return pending
    },
    /**
     * 等待本轮媒体运行进入可处理终态，并把最新阶段写回影像任务。
     * 等待发生在 Host，不产生模型回合；首个终态返回后交给同一 Agent 继续处理。
     * @param signal 当前 Agent 运行取消信号。
     * @returns 等不到终态时返回当前待处理任务；终态返回后携带最新媒体阶段。
     */
    async waitForPendingMedia(signal: AbortSignal): Promise<PendingVisualMediaStep[]> {
      while (true) {
        signal.throwIfAborted()
        const pending = await this.pendingMediaSteps()
        if (!pending.length || !access.waitForMediaExecution) return pending
        /** 缺少运行身份、引擎或尚未真正执行时，应由 Agent 准备、执行或处理结果。 */
        if (pending.some(step => !step.mediaRunId || !step.mediaEngine || !HOST_WAITABLE_MEDIA_PHASES.has(step.mediaPhase ?? ''))) return pending
        const controller = new AbortController()
        const abort = (): void => controller.abort(signal.reason)
        signal.addEventListener('abort', abort, { once: true })
        try {
          await Promise.race(pending.map(async step => {
            const engine = step.mediaEngine!
            const runId = step.mediaRunId!
            await access.waitForMediaExecution!({ runId, engine }, controller.signal)
            signal.throwIfAborted()
            await access.execute('recordMediaExecution', {
              sessionId,
              productionId: step.productionId,
              baseRevision: step.productionRevision,
              jobId: step.jobId,
              runId,
              engine,
            }, signal)
          }))
        } finally {
          signal.removeEventListener('abort', abort)
          controller.abort(signal.reason)
        }
      }
    },
    async execute<M extends VisualProductionMethod>(method: M, input: VisualProductionInputs[M], signal?: AbortSignal): Promise<VisualProductionResults[M]> {
      if (['recordWorkflowDiscovery', 'propose', 'proposeScript', 'proposeShot', 'referenceMedia', 'updateJob', 'failJob'].includes(method) && 'jobId' in input) {
        /** 旧回合持久任务不属于本轮能力，禁止沿同一 session 偷接迟到结果。 */
        const owned = ownedJobs.get(input.jobId)
        if (!owned || owned.productionId !== input.productionId || input.sessionId !== sessionId) throw new Error('影像任务不属于本轮 Agent 运行')
      }
      const result = await access.execute(method, input, signal)
      if (method === 'beginJob') {
        const job = result as VisualJob
        if ('productionId' in input) ownedJobs.set(job.id, { job, productionId: input.productionId })
      }
      return result
    },
    /**
     * 收尾只更新仍等待结果的本轮任务，服务端保持 candidate/failed/cancelled 不变。
     * cleanup 固定原项目归属并检查当前权限，但允许已结束的运行保存真实终态。
     */
    async finish(stopped: boolean): Promise<void> {
      const errors: unknown[] = []
      for (const { job, productionId } of ownedJobs.values()) {
        try {
          if (stopped) await cleanup.execute('cancelJob', { sessionId, productionId, jobId: job.id })
          else await cleanup.execute('failJob', { sessionId, productionId, jobId: job.id, message: '本轮 Agent 已结束，未提交可预览候选；可根据主会话结果重新发起。' })
        } catch (error) { errors.push(error) }
      }
      ownedJobs.clear()
      if (errors.length) throw new AggregateError(errors, '部分影像任务终态未能保存')
    },
  }
}
