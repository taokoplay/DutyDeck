import type { VisualProductionReference } from '@dutydeck/shared'
import type { VisualProductionDraft, VisualProductionDocument, VisualShot, VisualJob, VisualCandidate, VisualProductionKind, VisualProductionSnapshot } from '@dutydeck/shared'

/** 作品类型名称由编辑入口和候选预览共用。 */
export const VISUAL_KIND_LABELS: Record<VisualProductionKind, string> = { comic: '漫剧', film: '影片', promo: '宣传片', image: '图片' }

/** 合并后的任务展示状态；失败与中断、取消与丢弃分别归入相同筛选。 */
export type VisualRecordStatus = 'running' | 'pending' | 'adopted' | 'failed' | 'stale' | 'closed'
/** 全部和各状态对应的页签值。 */
export type VisualRecordTab = 'all' | VisualRecordStatus
/** 一个任务及它提交的候选组成一条制作记录。 */
export interface VisualProductionRecord {
  /** 原始任务，保留完整要求与失败原因供详情查看。 */
  job: VisualJob
  /** 同任务候选按新到旧排列，不另建重复的任务卡片。 */
  candidates: VisualCandidate[]
  /** 一条任务只归入一个页签，优先标出仍需处理的状态。 */
  status: VisualRecordStatus
}
/** 制作记录及各状态的任务数量。 */
export interface VisualRecordGroups {
  /** 全部列表优先排列进行中、待采用和已过期记录，各组按新到旧排序。 */
  records: VisualProductionRecord[]
  /** 页签及入口共用任务口径，同任务多个候选不重复计数。 */
  counts: Record<VisualRecordTab, number>
}

/** 视频候选审核对采用动作的可读状态。 */
export type VisualCandidateReviewState = 'legacy' | 'missing' | 'pending' | 'failed' | 'ready'

/**
 * 从候选审核记录计算采用门禁，不修改候选或正式作品。
 * @param candidate 当前候选；旧候选没有 reviewRequired 时保持兼容。
 * @returns 可显示并用于按钮禁用的审核状态。
 */
export function visualCandidateReviewState(candidate: VisualCandidate): VisualCandidateReviewState {
  if (candidate.review?.audio === 'failed' || candidate.review?.issues.some(issue => issue.severity === 'error')) return 'failed'
  if (!candidate.reviewRequired) return 'legacy'
  if (!candidate.review) return 'missing'
  const review = candidate.review
  if ([review.technical, review.motion, review.continuity].includes('failed') || review.issues.some(issue => issue.severity === 'error')) return 'failed'
  if ([review.technical, review.motion, review.continuity].includes('pending')) return 'pending'
  if (review.audio === 'pending' || (candidate.reviewAudioRequired && !review.audio)) return 'pending'
  return 'ready'
}

/** 输入作品任务与候选，按任务合并并返回展示分组；不修改持久化数据。 */
export function groupVisualRecords(snapshot: Pick<VisualProductionSnapshot, 'jobs' | 'candidates'>): VisualRecordGroups {
  /** 一次建立关联，避免每条任务重复扫描整个候选集合。 */
  const byJob = new Map<string, VisualCandidate[]>()
  /** 汇总仅服务于显示，采用权限继续由原有版本校验控制。 */
  const counts: VisualRecordGroups['counts'] = { all: 0, running: 0, pending: 0, adopted: 0, failed: 0, stale: 0, closed: 0 }
  /** 仍需处理的任务优先出现在全部列表。 */
  const current: VisualProductionRecord[] = []
  /** 已结束记录保留完整查询和预览能力。 */
  const history: VisualProductionRecord[] = []
  for (const candidate of snapshot.candidates) {
    if (!byJob.has(candidate.jobId)) byJob.set(candidate.jobId, [])
    byJob.get(candidate.jobId)!.push(candidate)
  }
  for (const job of [...snapshot.jobs].sort((left, right) => right.createdAt - left.createdAt)) {
    /** 同任务的候选与原始任务一起展示，已采用结果也可追溯。 */
    const candidates = (byJob.get(job.id) ?? []).sort((left, right) => right.createdAt - left.createdAt)
    /** 候选结果优先于“已提交”任务状态，不能把待采用误归为已结束。 */
    const status: VisualRecordStatus = job.status === 'running' ? 'running'
      : candidates.some(item => item.status === 'ready') ? 'pending'
        : candidates.some(item => item.status === 'stale') ? 'stale'
          : candidates.some(item => item.status === 'adopted') ? 'adopted'
            : job.status === 'failed' || job.status === 'interrupted' ? 'failed' : 'closed'
    /** 当前任务及其所有候选仍只展示为一条记录。 */
    const record = { job, candidates, status }
    counts.all++; counts[status]++
    if (status === 'running' || status === 'pending' || status === 'stale') current.push(record)
    else history.push(record)
  }
  return { records: [...current, ...history], counts }
}

/** 从正式版本提取可编辑字段，深拷贝避免草稿污染已采用内容。 */
export function copyVisualDraft(document: VisualProductionDraft): VisualProductionDraft {
  return structuredClone({ title: document.title, kind: document.kind, brief: document.brief, ratio: document.ratio, fps: document.fps, voice: document.voice, music: document.music, episodes: document.episodes, assets: document.assets, shots: document.shots })
}
/** 只在当前集内交换镜头，其他集的位置与对象保持不变。 */
export function reorderVisualShot(shots: VisualShot[], shotId: string, offset: -1 | 1): VisualShot[] {
  const index = shots.findIndex(shot => shot.id === shotId)
  if (index < 0) return shots
  const indices = shots.map((shot, position) => shot.episodeId === shots[index]!.episodeId ? position : -1).filter(position => position >= 0)
  const target = indices[indices.indexOf(index) + offset]
  if (target === undefined) return shots
  const next = [...shots]
  ;[next[index], next[target]] = [next[target]!, next[index]!]
  return next
}
/** 从当前正式对象创建引用快照，不生成操作指令或覆盖用户草稿。 */
export function buildVisualReference(workspaceId: string, document: VisualProductionDocument, shotId?: string, assetId?: string): VisualProductionReference {
  /** 精确校验选中的子目标，不能降级为整个作品。 */
  const shot = shotId ? document.shots.find(item => item.id === shotId) : undefined
  const asset = assetId ? document.assets.find(item => item.id === assetId) : undefined
  if (shotId && !shot || assetId && !asset || shotId && assetId) throw new Error('引用对象不存在，请刷新后重试。')
  return { workspaceId, productionId: document.id, productionRevision: document.revision,
    target: shot ? { kind: 'shot', shotId: shot.id } : asset ? { kind: 'asset', assetId: asset.id } : { kind: 'production' },
    title: shot?.title ?? asset?.name ?? document.title, productionTitle: document.title }
}
/** 终态重试使用最新作品版本；删除目标不降级为整部作品重做。 */
export function buildVisualRetryPrompt(document: VisualProductionDocument, job: VisualJob): string | null {
  if (!['failed', 'cancelled', 'interrupted'].includes(job.status) || (job.shotId && !document.shots.some(shot => shot.id === job.shotId))) return null
  return `请重试影像作品「${document.title}」${job.shotId ? `中镜头「${document.shots.find(shot => shot.id === job.shotId)!.title}」` : '的上述对象'}。\n${job.instruction}\n请先核对最新设定和已确认资产，创建新任务重试，不恢复旧任务；只修改上述目标。`
}

/**
 * 为待审视频生成可引用的 Agent 审片要求，不自动发送或提交审核。
 * @param document 当前正式作品。
 * @param candidate 需要审核的候选。
 * @param job 候选所属任务及可选镜头范围。
 * @returns 明确的审片提示；旧候选或无需审核时返回 null。
 */
export function buildVisualCandidateReviewPrompt(document: VisualProductionDocument, candidate: VisualCandidate, job: VisualJob): string | null {
  if (!candidate.reviewRequired || candidate.status !== 'ready') return null
  const shot = job.shotId ? document.shots.find(item => item.id === job.shotId) : undefined
  const target = shot ? `镜头「${shot.title}」` : `作品「${document.title}」`
  return `请审核${target}的媒体候选「${candidate.summary}」。打开正式作品 ${document.id} 的视觉范围并使用候选 ${candidate.id}，将前后镜头加入 continuityShotIds；先 inspect 实际媒体，再提交 reviewCandidate。审核覆盖 technical、motion、continuity，涉及声音时增加 audio：technical 检查可解码、时长和异常帧；motion 检查主体、动作和生成瑕疵；continuity 检查前后镜头方向、空间、动作、道具与声音接续；audio 必须实际听验对白、旁白、语气、音效、配乐及混音，未听验保持 pending，不能用转录或波形代替。纯声音候选的 motion 可标 passed 并说明不适用。问题记录时间点，未听完整音频、未看完整视频或仅抽帧要写入未检查范围。不要替用户采用候选。`
}
/** 迟到请求只有在同一上下文且最新代次时才可回填界面。 */
export class VisualRequestGate {
  private sequence = 0
  next(): number { return ++this.sequence }
  accepts(ticket: number): boolean { return ticket === this.sequence }
}

/** 工作区往返仍产生新代次，字符串相同不代表旧异步操作仍拥有界面。 */
export class VisualScopeEpoch {
  private context = ''
  private epoch = 0
  enter(context: string): void { if (this.context !== context) { this.context = context; this.epoch++ } }
  capture(): number { return this.epoch }
  accepts(epoch: number): boolean { return this.epoch === epoch }
  invalidate(): void { this.epoch++ }
}
