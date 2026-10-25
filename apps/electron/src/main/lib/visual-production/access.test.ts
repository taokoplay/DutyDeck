import { describe, expect, test } from 'bun:test'
import { createVisualProductionAccess } from './access'
import { createVisualProductionRun } from './agent-run'
import type { VisualProductionExecutor } from './access'
import type { VisualJob, VisualProductionResults } from '@dutydeck/shared'

describe('Given 会话绑定的影像能力', () => {
  test('When 会话越界、计划写或取消 Then 不进入服务', async () => {
    let calls = 0
    const access = createVisualProductionAccess('session', {
      resolveSession: () => ({ workspaceId: 'workspace', projectRoot: '/project' }), canWrite: () => false,
      acquireWriteLease: () => () => {}, createService: () => ({ async invoke<M extends keyof VisualProductionResults>(): Promise<VisualProductionResults[M]> { calls++; throw new Error('不应调用') } }),
    })
    await expect(access.execute('list', { sessionId: 'other' })).rejects.toThrow('身份')
    await expect(access.execute('create', { sessionId: 'session', title: '作品', kind: 'film' })).rejects.toThrow('计划')
    await expect(access.execute('autoAdoptShots', { sessionId: 'session', productionId: 'production' })).rejects.toThrow('计划')
    const controller = new AbortController(); controller.abort()
    await expect(access.execute('list', { sessionId: 'session' }, controller.signal)).rejects.toThrow('取消')
    expect(calls).toBe(0)
  })
  test('When 本轮结束 Then 只结算本轮签发任务且保留作品归属', async () => {
    const calls: unknown[] = []
    const job: VisualJob = { id: 'job', sessionId: 'session', baseRevision: 1, instruction: '生成', status: 'running', createdAt: 1 }
    const access: VisualProductionExecutor = { workspaceId: 'workspace', assertCurrent() {}, async execute<M extends keyof VisualProductionResults>(): Promise<VisualProductionResults[M]> { return job as VisualProductionResults[M] } }
    const cleanup: VisualProductionExecutor = { ...access, async execute<M extends keyof VisualProductionResults>(method: M, input: unknown): Promise<VisualProductionResults[M]> { calls.push({ method, input }); return {} as VisualProductionResults[M] } }
    const run = createVisualProductionRun('session', access, cleanup)
    await run.execute('beginJob', { sessionId: 'session', productionId: 'production', baseRevision: 1, instruction: '生成' })
    await run.finish(true)
    await run.finish(true)
    expect(calls).toEqual([{ method: 'cancelJob', input: { sessionId: 'session', productionId: 'production', jobId: 'job' } }])
  })
  test('Given Host 提供媒体终态等待 When 调用 Then 绑定当前会话并在取消后拒绝迟到结果', async () => {
    const calls: unknown[] = []
    const access = createVisualProductionAccess('session', {
      resolveSession: () => ({ workspaceId: 'workspace', projectRoot: '/project' }),
      acquireWriteLease: () => () => {},
      createService: () => ({ async invoke<M extends keyof VisualProductionResults>(): Promise<VisualProductionResults[M]> { throw new Error('不应写入') } }),
      waitForMediaExecution: async (input) => {
        calls.push(input)
        return { phase: 'succeeded' }
      },
    })
    expect(await access.waitForMediaExecution?.({ runId: 'run', engine: 'workflow' })).toEqual({ phase: 'succeeded' })
    const controller = new AbortController(); controller.abort()
    await expect(access.waitForMediaExecution?.({ runId: 'run', engine: 'workflow' }, controller.signal)).rejects.toThrow()
    expect(calls).toEqual([{ sessionId: 'session', runId: 'run', engine: 'workflow' }])
  })
})

test('Given 同会话新运行 When 提交旧运行job Then 不得进入正式执行器', async () => {
  let called = false
  const access: VisualProductionExecutor = { workspaceId: 'workspace', assertCurrent() {}, async execute<M extends keyof VisualProductionResults>(): Promise<VisualProductionResults[M]> { called = true; return {} as VisualProductionResults[M] } }
  const run = createVisualProductionRun('session', access, access)
  await expect(run.execute('propose', { sessionId: 'session', productionId: 'production', baseRevision: 1, jobId: 'old-job', draft: {} as never, summary: '旧结果' })).rejects.toThrow('本轮')
  expect(called).toBe(false)
})

test('Given 旧运行任务 When 转换参考或更新阶段或提交单镜头 Then 均不能绕过本轮归属', async () => {
  /** 模拟同一会话的下一轮，底层服务不应收到旧任务调用。 */
  let calls = 0
  const access: VisualProductionExecutor = { workspaceId: 'workspace', assertCurrent() {}, async execute<M extends keyof VisualProductionResults>(): Promise<VisualProductionResults[M]> { calls++; return {} as VisualProductionResults[M] } }
  const run = createVisualProductionRun('session', access, access)
  const base = { sessionId: 'session', productionId: 'production', baseRevision: 1, jobId: 'old-job' }
  await expect(run.execute('referenceMedia', { ...base, mediaId: 'media' })).rejects.toThrow('本轮')
  await expect(run.execute('updateJob', { ...base, stage: 'generating' })).rejects.toThrow('本轮')
  await expect(run.execute('proposeShot', { ...base, shotId: 'shot', mediaId: 'media', summary: '候选' })).rejects.toThrow('本轮')
  expect(calls).toBe(0)
})
