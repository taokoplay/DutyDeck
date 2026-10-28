import { describe, expect, test } from 'bun:test'
import type { VisualProductionInputs, VisualProductionMethod, VisualProductionResults, VisualProductionSnapshot } from '@dutydeck/shared'
import { createVisualProductionRun } from './agent-run'
import type { VisualProductionExecutor } from './access'

/** 构造两个不同作品的真实领域回执形状；不读写用户作品。 */
function fixture() {
  const document: VisualProductionSnapshot['document'] = { schemaVersion: 1, id: 'yaoxiang', revision: 1, createdAt: 1, updatedAt: 1, title: '妖巷', kind: 'comic', brief: '', ratio: '9:16', fps: 24, voice: '', music: '', episodes: [{ id: 'episode', title: '一' }], assets: [], shots: [] }
  const current: VisualProductionSnapshot = { document, media: [], assetVersions: {}, shotStates: {}, candidates: [], jobs: [] }
  const access: VisualProductionExecutor = { workspaceId: 'workspace', assertCurrent() {}, async execute<M extends VisualProductionMethod>(method: M, input: VisualProductionInputs[M]): Promise<VisualProductionResults[M]> {
    if (method === 'list') return ['dayin', document.id].map(id => ({ id, title: id === 'dayin' ? '大胤刑警' : document.title, kind: document.kind, revision: 1, episodeCount: 1, assetCount: 0, shotCount: 0, updatedAt: 1 })) as VisualProductionResults[M]
    if (method === 'load' || method === 'adopt') return current as VisualProductionResults[M]
    if (method === 'beginJob') return { id: 'job', sessionId: 'session', baseRevision: 1, instruction: '写剧本', status: 'running', createdAt: 1 } as VisualProductionResults[M]
    if (method === 'propose') {
      const candidate: VisualProductionResults['propose'] = { id: 'candidate', jobId: 'job', baseRevision: 1, createdAt: 1, status: 'ready', summary: '剧本', draft: current.document }
      return candidate as VisualProductionResults[M]
    }
    throw new Error(`unexpected ${method} ${JSON.stringify(input)}`)
  } }
  const run = createVisualProductionRun('session', access, access)
  return { run, delivery: run, current }
}

describe('影像交付完成核验', () => {
  test('Given 两作品且已读妖巷 When 只输出文字没有启动job Then 不能直接作为成功交付结束', async () => {
    const { run, delivery } = fixture()
    expect(typeof delivery.pendingDelivery).toBe('function')
    await run.execute('list', { sessionId: 'session' })
    await run.execute('load', { sessionId: 'session', productionId: 'yaoxiang' })
    expect(delivery.pendingDelivery()).toContain('visual_production_complete_task')
    expect(() => delivery.completeTask({ outcome: 'written', productionIds: ['yaoxiang'], reason: '聊天里已写好32镜' })).toThrow('正式写入')
    expect(delivery.pendingDelivery()).not.toBeNull()
  })

  test('Given 普通讨论与只读审查 When 说明无需写入 Then 无副作用结束且不凭关键词启动写入', async () => {
    const { run, delivery, current } = fixture()
    expect(typeof delivery.pendingDelivery).toBe('function')
    expect(delivery.pendingDelivery()).toBeNull()
    await run.execute('load', { sessionId: 'session', productionId: 'yaoxiang' })
    delivery.completeTask({ outcome: 'read-only', productionIds: ['yaoxiang'], reason: '用户仅要求比较剧本方案，不要求保存' })
    expect(delivery.pendingDelivery()).toBeNull()
    expect(current.document.revision).toBe(1)
    expect(current.jobs).toEqual([])
  })

  test('Given 创建候选成功 When 尚未采用 Then 只能报告候选，不能冒充正式写入', async () => {
    const { run, delivery } = fixture()
    expect(typeof delivery.pendingDelivery).toBe('function')
    await run.execute('beginJob', { sessionId: 'session', productionId: 'yaoxiang', baseRevision: 1, instruction: '生成剧本' })
    const draft = (await run.execute('load', { sessionId: 'session', productionId: 'yaoxiang' })).document
    await run.execute('propose', { sessionId: 'session', productionId: 'yaoxiang', baseRevision: 1, jobId: 'job', draft, summary: '候选' })
    expect(() => delivery.completeTask({ outcome: 'written', productionIds: ['yaoxiang'], reason: '候选已提交' })).toThrow('正式写入')
    delivery.completeTask({ outcome: 'candidate', productionIds: ['yaoxiang'], reason: '用户仅要求候选对比，尚未采用' })
    expect(delivery.pendingDelivery()).toBeNull()
  })

  test('Given 精确候选采用回执 When 报告写入 Then 仅接受真实作品身份，其他作品不能借用', async () => {
    const { run, delivery, current } = fixture()
    expect(typeof delivery.pendingDelivery).toBe('function')
    current.candidates = [{ id: 'candidate', jobId: 'job', baseRevision: 1, status: 'adopted', createdAt: 1, summary: '采用', draft: current.document }]
    current.document.revision = 2
    await run.execute('adopt', { sessionId: 'session', productionId: 'yaoxiang', baseRevision: 1, candidateId: 'candidate' })
    expect(() => delivery.completeTask({ outcome: 'written', productionIds: ['dayin'], reason: '错作品' })).toThrow('正式写入')
    delivery.completeTask({ outcome: 'written', productionIds: ['yaoxiang'], reason: '目标候选已采用' })
    expect(delivery.pendingDelivery()).toBeNull()
    /** 新操作使旧完成声明失效，不能提前声明结束后再绕过核验。 */
    await run.execute('load', { sessionId: 'session', productionId: 'yaoxiang' })
    expect(delivery.pendingDelivery()).not.toBeNull()
  })

  test('Given 锁定或版本冲突 When 无法保存 Then 可明确报告受阻，不自动扩大写入权限', async () => {
    const { run, delivery } = fixture()
    expect(typeof delivery.pendingDelivery).toBe('function')
    await run.execute('load', { sessionId: 'session', productionId: 'yaoxiang' })
    expect(() => delivery.completeTask({ outcome: 'blocked', productionIds: ['yaoxiang'], reason: ' ' })).toThrow()
    delivery.completeTask({ outcome: 'blocked', productionIds: ['yaoxiang'], reason: '正式版本已变化，候选尚未采用' })
    expect(delivery.pendingDelivery()).toBeNull()
  })
})
