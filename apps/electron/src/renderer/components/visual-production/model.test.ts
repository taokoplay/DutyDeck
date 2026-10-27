import { describe, expect, it } from 'bun:test'
import { buildVisualCandidateReviewPrompt, buildVisualRetryPrompt, copyVisualDraft, groupVisualRecords, reorderVisualShot, visualCandidateReviewState, VisualRequestGate, VisualScopeEpoch } from './model'
import type { VisualCandidate, VisualJob, VisualProductionDraft, VisualShot } from '@dutydeck/shared'
/** 最小镜头夹具用于验证跨集排序边界。 */
const shot = (id: string, episodeId: string): VisualShot => ({ id, episodeId, title: id, duration: 3, scene: '', motion: '', dialogue: '', assetIds: [], mediaId: null })
describe('影像创作编辑模型', () => {
  it('当重排当前集镜头时，应保留其他集位置且边界不越界', () => {
    const source = [shot('a', 'one'), shot('x', 'two'), shot('b', 'one')]
    expect(reorderVisualShot(source, 'a', 1).map(item => item.id)).toEqual(['b', 'x', 'a'])
    expect(reorderVisualShot(source, 'a', -1)).toBe(source)
    expect(source[0]!.id).toBe('a')
  })
  it('当编辑草稿时，不应污染正式镜头与资产引用', () => {
    const source: VisualProductionDraft = { title: '作品', kind: 'film', brief: '', ratio: '16:9', fps: 24, voice: '', music: '', episodes: [{ id: 'one', title: '第一集' }], assets: [], shots: [shot('a', 'one')] }
    const draft = copyVisualDraft(source)
    draft.shots[0]!.assetIds.push('new')
    expect(source.shots[0]!.assetIds).toEqual([])
  })
  it('切换作品或新读取后拒绝旧异步结果', () => {
    const gate = new VisualRequestGate()
    const old = gate.next()
    expect(gate.accepts(old)).toBe(true)
    const current = gate.next()
    expect(gate.accepts(old)).toBe(false)
    expect(gate.accepts(current)).toBe(true)
  })
})

describe('影像工作区往返隔离', () => {
  it('A 保存期间切到 B 再回 A，旧写结果不可清掉新草稿', () => {
    const scope = new VisualScopeEpoch()
    scope.enter('A')
    const saved = scope.capture()
    scope.enter('B')
    scope.enter('A')
    expect(scope.accepts(saved)).toBe(false)
    const current = scope.capture()
    scope.enter('A')
    expect(scope.accepts(current)).toBe(true)
    scope.invalidate()
    expect(scope.accepts(current)).toBe(false)
  })
})

it('失败重试引用最新正式版本，已删除目标或活动任务不允许重试', () => {
  /** 当前版本比失败任务更新，重试必须保留新内容并签发新任务。 */
  const document = { schemaVersion: 1 as const, id: 'production', revision: 8, createdAt: 1, updatedAt: 2, title: '作品', kind: 'film' as const, brief: '', ratio: '16:9', fps: 24, voice: '', music: '', episodes: [{ id: 'one', title: '一' }], assets: [], shots: [shot('third', 'one')] }
  const job = { id: 'old-job', sessionId: 'session', baseRevision: 2, shotId: 'third', instruction: '第三镜头缓慢推进', status: 'failed' as const, createdAt: 1 }
  const prompt = buildVisualRetryPrompt(document, job)
  expect(prompt).toContain('作品「作品」')
  expect(prompt).not.toContain('revision:')
  expect(prompt).toContain('镜头「third」')
  expect(prompt).not.toContain('shotId:')
  expect(prompt).toContain('第三镜头缓慢推进')
  expect(prompt).toContain('新任务')
  expect(prompt).not.toContain('jobId: old-job')
  expect(buildVisualRetryPrompt({ ...document, shots: [] }, job)).toBeNull()
  expect(buildVisualRetryPrompt(document, { ...job, status: 'running' })).toBeNull()
})

describe('制作记录状态筛选', () => {
  /** 候选正文与状态筛选无关，使用完整最小作品保证夹具符合真实合同。 */
  const draft: VisualProductionDraft = { title: '作品', kind: 'film', brief: '', ratio: '16:9', fps: 24, voice: '', music: '', episodes: [], assets: [], shots: [] }
  /** 按真实任务状态构造记录，便于验证终态和候选状态的优先级。 */
  const job = (id: string, status: VisualJob['status']): VisualJob => ({ id, status, sessionId: 'session', baseRevision: 1, createdAt: 1, instruction: id })
  /** 候选通过 jobId 与任务关联，同任务的多个结果不能重复计为多条任务。 */
  const candidate = (jobId: string, status: VisualCandidate['status']): VisualCandidate => ({ id: `${jobId}-${status}`, jobId, status, baseRevision: 1, createdAt: 2, draft, summary: jobId })
  it('当任务覆盖全部执行与候选状态时，各页签数量应完整且互不重复', () => {
    /** 无候选的已提交记录也须保留在已结束中，不能从历史消失。 */
    const snapshot = { jobs: [job('running', 'running'), job('failed', 'failed'), job('interrupted', 'interrupted'), job('cancelled', 'cancelled'), job('pending', 'candidate'), job('adopted', 'candidate'), job('stale', 'candidate'), job('discarded', 'candidate'), job('old', 'candidate')], candidates: [candidate('pending', 'ready'), candidate('adopted', 'adopted'), candidate('stale', 'stale'), candidate('discarded', 'discarded')] }
    expect(groupVisualRecords(snapshot)).toMatchObject({ counts: { all: 9, running: 1, pending: 1, adopted: 1, failed: 2, stale: 1, closed: 3 } })
  })
  it('当同任务包含历史与待采用候选时，只计一条待采用任务，采用后归入已采用', () => {
    /** 保留输入副本，确保分组操作不会改写持久化顺序或状态。 */
    const snapshot = { jobs: [job('one', 'candidate')], candidates: [candidate('one', 'adopted'), candidate('one', 'ready')] }
    const original = structuredClone(snapshot)
    expect(groupVisualRecords(snapshot)).toMatchObject({ counts: { all: 1, pending: 1, adopted: 0 }, records: [{ status: 'pending' }] })
    expect(snapshot).toEqual(original)
    expect(groupVisualRecords({ ...snapshot, candidates: snapshot.candidates.map(item => ({ ...item, status: 'adopted' as const })) })).toMatchObject({ counts: { all: 1, pending: 0, adopted: 1 }, records: [{ status: 'adopted' }] })
    expect(groupVisualRecords({ jobs: [], candidates: [] })).toMatchObject({ counts: { all: 0, running: 0, pending: 0, adopted: 0, failed: 0, stale: 0, closed: 0 }, records: [] })
  })
  it('视频候选只有技术与内容审核完成后才可采用', () => {
    const base = { ...candidate('review', 'ready'), reviewRequired: true }
    expect(visualCandidateReviewState(base)).toBe('missing')
    expect(visualCandidateReviewState({ ...base, review: { technical: 'passed', motion: 'passed', continuity: 'pending', conclusion: '', unchecked: [], issues: [], sessionId: 'session', reviewedAt: 1 } })).toBe('pending')
    expect(visualCandidateReviewState({ ...base, review: { technical: 'failed', motion: 'pending', continuity: 'pending', conclusion: '', unchecked: [], issues: [{ gate: 'technical', severity: 'error', message: '损坏' }], sessionId: 'session', reviewedAt: 1 } })).toBe('failed')
    expect(visualCandidateReviewState({ ...base, review: { technical: 'passed', motion: 'passed', continuity: 'warning', conclusion: '', unchecked: [], issues: [{ gate: 'continuity', severity: 'warning', message: '偏慢' }], sessionId: 'session', reviewedAt: 1 } })).toBe('ready')
    expect(visualCandidateReviewState(candidate('legacy', 'ready'))).toBe('legacy')
  })
  it('新声音候选缺少听验结论或未听验时保持待审，失败禁止采用', () => {
    /** 宿主标记不能由前三项通过隐式满足。 */
    const base: VisualCandidate = { ...candidate('audio', 'ready'), reviewRequired: true, reviewAudioRequired: true, review: { technical: 'passed', motion: 'passed', continuity: 'passed', conclusion: '声音审核', unchecked: [], issues: [], sessionId: 'session', reviewedAt: 1 } }
    expect(visualCandidateReviewState(base)).toBe('pending')
    for (const audio of ['pending', 'failed', 'passed', 'warning'] as const) {
      expect(visualCandidateReviewState({ ...base, review: { ...base.review!, audio } })).toBe(audio === 'passed' || audio === 'warning' ? 'ready' : audio)
    }
    expect(visualCandidateReviewState({ ...base, reviewRequired: undefined, reviewAudioRequired: undefined, review: { ...base.review!, audio: 'failed' } })).toBe('failed')
  })
})

it('需要审核的视频候选可生成明确的 Agent 审片要求', () => {
  const document = { schemaVersion: 1 as const, id: 'production', revision: 4, createdAt: 1, updatedAt: 2, title: '作品', kind: 'film' as const, brief: '', ratio: '16:9', fps: 24, voice: '', music: '', episodes: [{ id: 'one', title: '一' }], assets: [], shots: [shot('shot', 'one')] }
  const job = { id: 'job', sessionId: 'session', baseRevision: 4, shotId: 'shot', instruction: '生成', status: 'candidate' as const, createdAt: 1 }
  const draft: VisualProductionDraft = { title: '作品', kind: 'film', brief: '', ratio: '16:9', fps: 24, voice: '', music: '', episodes: [], assets: [], shots: [] }
  const candidate: VisualCandidate = { id: 'candidate', jobId: 'job', status: 'ready', baseRevision: 4, createdAt: 2, draft, summary: '视频结果', reviewRequired: true }
  const prompt = buildVisualCandidateReviewPrompt(document, candidate, job)
  expect(prompt).toContain('reviewCandidate')
  expect(prompt).toContain('technical、motion、continuity')
  expect(prompt).toContain('前后镜头')
  expect(prompt).toContain('未检查范围')
  expect(buildVisualCandidateReviewPrompt(document, { ...candidate, reviewRequired: undefined }, job)).toBeNull()
})
