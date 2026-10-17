import { describe, expect, test } from 'bun:test'
import type { PrototypeCandidateSummary, PrototypeJob, PrototypeSnapshot } from '@dutydeck/shared'
import { buildPrototypeHistory, collectPendingPrototypePages, filterPrototypeHistory } from './interaction-design-history'

/** 创建最小快照；输入局部历史覆盖，返回互相隔离的测试数据。 */
function snapshot(overrides: Partial<PrototypeSnapshot> = {}): PrototypeSnapshot {
  return {
    document: { schemaVersion: 1, id: 'p', revision: 2, createdAt: 1, updatedAt: 2, name: '原型', platform: 'mobile', brief: '', groups: [], pages: [], entryPageId: '', flows: [] },
    versions: [], candidates: [], jobs: [], assets: [], checks: [], ...overrides,
  }
}

/** 创建候选；输入身份及覆盖字段，返回可独立调整的摘要。 */
function candidate(id: string, overrides: Partial<PrototypeCandidateSummary> = {}): PrototypeCandidateSummary {
  return { id, prototypeId: 'p', baseRevision: 1, summary: id, status: 'ready', createdAt: 10, ...overrides }
}

/** 创建任务；输入身份及状态，返回完整任务摘要。 */
function job(id: string, status: PrototypeJob['status']): PrototypeJob {
  return { id, status, prototypeId: 'p', sessionId: 's', baseRevision: 1, instruction: id, createdAt: 5 }
}

describe('历史版本与候选的统一派生模型', () => {
  test('Given 已采纳候选和对应版本 When 整理历史 Then 合并为版本并按正式采纳时间排序', () => {
    /** 版本与候选及任务共同描述同一结果。 */
    const source = snapshot({ versions: [{ revision: 2, summary: '正式说明', createdAt: 30 }, { revision: 1, summary: '初稿', createdAt: 1 }], candidates: [candidate('accepted', { status: 'adopted', adoptedRevision: 2, jobId: 'j' }), candidate('pending', { createdAt: 20 })], jobs: [job('j', 'candidate')] })
    /** 保留原输入用于检查纯派生操作不会改动业务状态。 */
    const original = structuredClone(source)
    /** 排序后同一结果只占一行。 */
    const entries = buildPrototypeHistory(source)
    expect(entries.map(entry => [entry.kind, entry.status, entry.createdAt])).toEqual([['version', 'adopted', 30], ['candidate', 'pending', 20], ['version', 'adopted', 1]])
    expect(entries[0]?.candidate?.id).toBe('accepted')
    expect(entries[0]?.summary).toBe('正式说明')
    expect(source).toEqual(original)
  })

  test('Given 已采纳版本已删除 When 整理历史 Then 候选和关联任务不会重新回流', () => {
    /** 存储保留采纳事实，但已删除版本不应通过候选或任务重新出现在 UI。 */
    const source = snapshot({ candidates: [candidate('accepted', { status: 'adopted', adoptedRevision: 9, jobId: 'accepted-job' })], jobs: [job('accepted-job', 'candidate')] })
    expect(buildPrototypeHistory(source)).toEqual([])
    expect(source.candidates[0]?.status).toBe('adopted')
    expect(source.jobs).toHaveLength(1)
  })

  test('Given 旧已采纳候选没有版本关联 When 整理历史 Then 保留已采纳记录', () => {
    /** 无关联版本的旧数据不能推断其对应版本已被用户删除。 */
    const entries = buildPrototypeHistory(snapshot({ candidates: [candidate('legacy', { status: 'adopted' })] }))
    expect(entries).toHaveLength(1)
    expect(entries[0]?.kind).toBe('candidate')
    expect(entries[0]?.status).toBe('adopted')
  })

  test('Given 独立任务与候选关联任务 When 整理历史 Then 保留独立状态且关联任务不重复', () => {
    /** 终态 candidate 已无对应候选时无法继续采纳。 */
    const entries = buildPrototypeHistory(snapshot({ candidates: [candidate('cancelled', { status: 'discarded', jobId: 'linked' })], jobs: [job('linked', 'candidate'), job('running', 'running'), job('failed', 'failed'), job('interrupted', 'interrupted'), job('cancelled', 'cancelled'), job('orphan', 'candidate')] }))
    expect(entries).toHaveLength(6)
    expect(entries.find(entry => entry.job?.id === 'linked')).toBeUndefined()
    expect(entries.find(entry => entry.job?.id === 'orphan')?.status).toBe('interrupted')
    expect(entries.find(entry => entry.job?.id === 'failed')?.status).toBe('failed')
    expect(entries.find(entry => entry.job?.id === 'running')?.status).toBe('running')
  })

  test('Given 混合状态 When 筛选 Then 未采纳只含 ready/stale 且取消不混入失败或中断', () => {
    /** 各状态在筛选中保持真实语义。 */
    const entries = buildPrototypeHistory(snapshot({ candidates: [candidate('ready'), candidate('stale', { status: 'stale' }), candidate('adopted', { status: 'adopted' }), candidate('discarded', { status: 'discarded' })], jobs: [job('running', 'running'), job('failed', 'failed'), job('interrupted', 'interrupted')] }))
    expect(filterPrototypeHistory(entries, 'all')).toEqual(entries)
    expect(filterPrototypeHistory(entries, 'pending').map(entry => entry.candidate?.id)).toEqual(['ready', 'stale'])
    expect(filterPrototypeHistory(entries, 'adopted').map(entry => entry.candidate?.id)).toEqual(['adopted'])
    expect(filterPrototypeHistory(entries, 'cancelled').map(entry => entry.candidate?.id)).toEqual(['discarded'])
  })

  test('Given 相同时间但输入顺序不同 When 整理历史 Then 使用稳定身份排序', () => {
    /** 时间相同的候选使用固定身份决定顺序。 */
    const candidates = [candidate('z'), candidate('a')]
    expect(buildPrototypeHistory(snapshot({ candidates })).map(entry => entry.key)).toEqual(buildPrototypeHistory(snapshot({ candidates: [...candidates].reverse() })).map(entry => entry.key))
  })

  test('Given 新旧候选影响页 When 收集红点 Then 精确去重且已采纳取消不产生红点', () => {
    /** 新字段为空数组表示确定无影响，不回退旧缓存。 */
    const candidates = [candidate('new', { affectedPageIds: ['p1', 'p1', 'p2'] }), candidate('old', { status: 'stale' }), candidate('empty', { affectedPageIds: [] }), candidate('accepted', { status: 'adopted', affectedPageIds: ['p4'] }), candidate('cancelled', { status: 'discarded', affectedPageIds: ['p5'] })]
    expect([...collectPendingPrototypePages(candidates, { old: ['p2', 'p3'], empty: ['wrong'], accepted: ['wrong'], cancelled: ['wrong'] })].sort()).toEqual(['p1', 'p2', 'p3'])
    expect([...collectPendingPrototypePages([candidate('unknown')])]).toEqual([])
  })
})
