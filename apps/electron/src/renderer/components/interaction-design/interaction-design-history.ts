import type { PrototypeCandidateSummary, PrototypeJob, PrototypeSnapshot, PrototypeVersion } from '@proma/shared'

/** 历史筛选只归类真实采纳状态，运行和失败信息保留在全部记录。 */
export type PrototypeHistoryFilter = 'all' | 'pending' | 'adopted' | 'cancelled'

/** 合并后的单条历史；原始记录供界面执行预览、采纳、恢复和删除。 */
export interface PrototypeHistoryEntry {
  /** 跨刷新稳定的列表身份。 */
  key: string
  /** 决定可执行操作的主记录类型。 */
  kind: 'version' | 'candidate' | 'job'
  /** 排序时间，已采纳版本使用正式保存时间。 */
  createdAt: number
  /** 原始保存、候选或任务说明。 */
  summary: string
  /** 面向用户的实际状态，不将失败误称取消。 */
  status: 'pending' | 'adopted' | 'cancelled' | 'running' | 'failed' | 'interrupted'
  /** 正式历史版本；只有该字段存在才可恢复版本。 */
  version?: PrototypeVersion
  /** 候选来源；已采纳版本可同时携带候选，避免重复展示。 */
  candidate?: PrototypeCandidateSummary
  /** 无候选结果的独立任务。 */
  job?: PrototypeJob
}

/** 输入完整快照，返回按时间倒序、同时间按稳定身份排序的历史，不修改快照。 */
export function buildPrototypeHistory(snapshot: PrototypeSnapshot): PrototypeHistoryEntry[] {
  /** 版本索引用于常数时间关联已采纳候选。 */
  const versionEntries = new Map<number, PrototypeHistoryEntry>(snapshot.versions.map(version => [version.revision, {
    key: `version:${version.revision}`, kind: 'version', createdAt: version.createdAt,
    summary: version.summary, status: 'adopted', version,
  }]))
  /** 历史输出复用元数据，不读取大体积正文或触发网络请求。 */
  const entries = [...versionEntries.values()]
  /** 已产生候选的任务由候选记录表达，避免同一生成结果出现两次。 */
  const linkedJobs = new Set<string>()
  for (const candidate of snapshot.candidates) {
    if (candidate.jobId) linkedJobs.add(candidate.jobId)
    /** 明确关联的正式版本被删除后不复活候选行，存储仍保留采纳事实。 */
    const adoptedVersion = candidate.status === 'adopted' && candidate.adoptedRevision !== undefined
      ? versionEntries.get(candidate.adoptedRevision) : undefined
    if (candidate.status === 'adopted' && candidate.adoptedRevision !== undefined && !adoptedVersion) continue
    if (adoptedVersion && !adoptedVersion.candidate) {
      adoptedVersion.candidate = candidate
      continue
    }
    entries.push({
      key: `candidate:${candidate.id}`, kind: 'candidate', createdAt: candidate.createdAt,
      summary: candidate.summary, candidate,
      status: candidate.status === 'adopted' ? 'adopted' : candidate.status === 'discarded' ? 'cancelled' : 'pending',
    })
  }
  for (const job of snapshot.jobs) {
    if (linkedJobs.has(job.id)) continue
    entries.push({
      key: `job:${job.id}`, kind: 'job', createdAt: job.createdAt, summary: job.instruction, job,
      // 候选已不可用的孤立任务不能再显示成可采纳，保留为中断记录。
      status: job.status === 'candidate' ? 'interrupted' : job.status,
    })
  }
  return entries.sort((left, right) => right.createdAt - left.createdAt || (left.key < right.key ? -1 : left.key > right.key ? 1 : 0))
}

/** 输入历史与筛选条件，返回匹配状态；全部包含运行、失败和中断。 */
export function filterPrototypeHistory(entries: PrototypeHistoryEntry[], filter: PrototypeHistoryFilter): PrototypeHistoryEntry[] {
  return filter === 'all' ? entries : entries.filter(entry => entry.status === filter)
}

/** 输入候选和旧候选影响页缓存，返回仍待采纳的唯一页面身份集合；不猜测未知影响。 */
export function collectPendingPrototypePages(candidates: PrototypeCandidateSummary[], legacyImpacts: Record<string, string[]> = {}): Set<string> {
  /** Set 合并多份候选对同一页面的提醒。 */
  const pageIds = new Set<string>()
  for (const candidate of candidates) {
    if (candidate.status !== 'ready' && candidate.status !== 'stale') continue
    for (const pageId of candidate.affectedPageIds ?? legacyImpacts[candidate.id] ?? []) pageIds.add(pageId)
  }
  return pageIds
}
