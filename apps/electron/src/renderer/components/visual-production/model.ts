import type { VisualProductionDraft, VisualProductionDocument, VisualShot, VisualJob, VisualCandidate, VisualProductionKind, VisualProductionSnapshot } from '@proma/shared'

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
/** 引用绑定正式作品和版本，Agent 应先读取最新版本并提交候选。 */
export function buildVisualPrompt(document: VisualProductionDocument, shotId?: string, assetId?: string): string {
  return `请协助制作影像作品「${document.title}」。\nproductionId: ${document.id}\nrevision: ${document.revision}${shotId ? `\nshotId: ${shotId}` : ''}${assetId ? `\nassetId: ${assetId}` : ''}\n先读取当前作品和引用资产，保留范围外内容。请使用影像创作工具启动任务、生成真实媒体并提交候选，由我预览后采用。我的要求：`
}
/** 终态重试使用最新作品版本；删除目标不降级为整部作品重做。 */
export function buildVisualRetryPrompt(document: VisualProductionDocument, job: VisualJob): string | null {
  if (!['failed', 'cancelled', 'interrupted'].includes(job.status) || (job.shotId && !document.shots.some(shot => shot.id === job.shotId))) return null
  return `${buildVisualPrompt(document, job.shotId)}\n${job.instruction}\n请先核对最新设定和已确认资产，创建新任务重试，不恢复旧任务；只修改上述目标。`
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
