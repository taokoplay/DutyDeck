import { describe, expect, test } from 'bun:test'
import type { VisualCandidate, VisualJob, VisualProductionInputs, VisualProductionMethod, VisualProductionResults, VisualProductionSnapshot } from '@dutydeck/shared'
import type { VisualProductionExecutor } from './access'
import { buildVisualCompletionEvaluation, buildVisualMediaStepContinuation, buildVisualRepairStepContinuation, buildVisualReviewStepContinuation, buildVisualWorkflowDiscoveryStepContinuation, createVisualProductionRun } from './agent-run'
import { applyAgentCompletionPolicy } from '../agent-completion-policy'
import type { SDKMessage } from '@dutydeck/shared'

/** 最小正式作品用于验证本轮候选审片队列。 */
function snapshot(candidate?: VisualCandidate): VisualProductionSnapshot {
  const shot = { id: 'shot', episodeId: 'episode', title: '镜头', duration: 4, scene: '', motion: '', dialogue: '', assetIds: [], mediaId: null }
  return {
    document: { schemaVersion: 1, id: 'production', revision: 2, createdAt: 1, updatedAt: 2, title: '作品', kind: 'film', brief: '', ratio: '16:9', fps: 24, voice: '', music: '', episodes: [{ id: 'episode', title: '一' }], assets: [], shots: [shot] },
    media: [], assetVersions: {}, shotStates: {}, candidates: candidate ? [candidate] : [],
    jobs: [{ id: 'job', sessionId: 'session', baseRevision: 2, shotId: 'shot', instruction: '生成', status: 'candidate', createdAt: 1 }],
  }
}

describe('影像 Agent 审片步骤', () => {
  test('Given 初审纠偏媒体回流 When 转入新候选复审 Then 共用总额度并在第十二次后停止', async () => {
    /** 使用真实 Host 策略验证跨阶段，不以静态提示词检查代替调度。 */
    let count = 0
    for (const stage of ['初审', '纠偏', '媒体回流', '新候选复审']) {
      const result = await applyAgentCompletionPolicy({ terminalResult: { type: 'result', subtype: 'success', session_id: 'session' } as SDKMessage, continuationCount: count, signal: new AbortController().signal, canContinue: true,
        evaluateCompletion: async () => buildVisualCompletionEvaluation(stage), continueTask: async () => {} })
      expect(result.continued).toBe(true)
      count = result.continuationCount
    }
    expect(count).toBe(4)
    const limited = await applyAgentCompletionPolicy({ terminalResult: { type: 'result', subtype: 'success', session_id: 'session' } as SDKMessage, continuationCount: 12, signal: new AbortController().signal, canContinue: true,
      evaluateCompletion: async () => buildVisualCompletionEvaluation('仍待审'), continueTask: async () => { throw new Error('不应超过总预算') } })
    expect(limited.continued).toBe(false)
    expect(buildVisualCompletionEvaluation(null)).toEqual({ action: 'complete' })
  })

  test('Given 本轮声音候选 When 声音缺结论或未说明缺口 Then 继续审查而已说明缺口不重复调度', async () => {
    /** 使用真实运行队列验证新声音门，避免只检查提示词字面。 */
    const current = snapshot()
    current.candidates = [{ id: 'audio', jobId: 'job', baseRevision: 2, createdAt: 2, status: 'ready', summary: '待听验配音', draft: current.document, reviewRequired: true, reviewAudioRequired: true,
      review: { technical: 'passed', motion: 'passed', continuity: 'passed', conclusion: '技术检查完成', unchecked: ['未听验'], issues: [], sessionId: 'session', reviewedAt: 3 } }]
    const access: VisualProductionExecutor = { workspaceId: 'workspace', assertCurrent() {}, async execute<M extends VisualProductionMethod>(method: M): Promise<VisualProductionResults[M]> {
      if (method === 'load') return current as VisualProductionResults[M]
      if (method === 'beginJob') return current.jobs[0] as VisualProductionResults[M]
      throw new Error(`unexpected ${method}`)
    } }
    const run = createVisualProductionRun('session', access, access)
    await run.execute('beginJob', { sessionId: 'session', productionId: 'production', baseRevision: 2, instruction: '配音' })
    expect(await run.pendingReviews()).toHaveLength(1)
    current.candidates[0]!.review!.audio = 'pending'
    current.candidates[0]!.review!.unchecked = []
    expect(await run.pendingReviews()).toHaveLength(1)
    current.candidates[0]!.review!.unchecked = ['   ']
    expect(await run.pendingReviews()).toHaveLength(1)
    current.candidates[0]!.review!.unchecked = ['无法实际听验，台词和声线仍待补证；候选不得采用']
    expect(await run.pendingReviews()).toEqual([])
    /** 同轮未审候选仍需继续，不能被另一候选的证据缺口说明放行。 */
    current.candidates.push({ ...current.candidates[0]!, id: 'unreviewed', review: undefined })
    expect(await run.pendingReviews()).toMatchObject([{ candidateId: 'unreviewed' }])
    current.candidates.pop()
    current.candidates[0]!.review!.audio = 'passed'
    expect(await run.pendingReviews()).toEqual([])
  })

  test('Given 本轮候选审核失败 When 完成检查 Then 每候选只纠偏一次且最多续行两轮', async () => {
    /** 正式版本和候选身份都参与修正调度，不扫描其他运行的遗留失败。 */
    const current = snapshot()
    const access: VisualProductionExecutor = { workspaceId: 'workspace', assertCurrent() {}, async execute<M extends VisualProductionMethod>(method: M): Promise<VisualProductionResults[M]> {
      if (method === 'load') return current as VisualProductionResults[M]
      if (method === 'beginJob') return current.jobs[0] as VisualProductionResults[M]
      throw new Error(`unexpected ${method}`)
    } }
    const run = createVisualProductionRun('session', access, access)
    await run.execute('beginJob', { sessionId: 'session', productionId: 'production', baseRevision: 2, instruction: '持续优化' })
    current.candidates = [{ id: 'failed', jobId: 'job', baseRevision: 2, createdAt: 2, status: 'ready', summary: '缺少真实POV', draft: current.document, reviewRequired: true,
      review: { technical: 'passed', motion: 'failed', continuity: 'pending', conclusion: '关键视角缺失', unchecked: [], issues: [{ gate: 'motion', severity: 'error', message: '裁切不是第一人称', atSeconds: 2 }], sessionId: 'session', reviewedAt: 3 } }]
    const repairs = await run.takePendingRepairs()
    expect(repairs).toMatchObject([{ candidateId: 'failed', review: { motion: 'failed' } }])
    expect(buildVisualRepairStepContinuation(repairs)).toContain('裁切不是第一人称')
    expect(buildVisualRepairStepContinuation([])).toBeNull()
    expect(await run.takePendingRepairs()).toEqual([])
    current.candidates[0]!.id = 'failed-again'
    expect(await run.takePendingRepairs()).toHaveLength(1)
    current.candidates[0]!.id = 'third-failure'
    expect(await run.takePendingRepairs()).toEqual([])
    /** 旧任务即使存在硬失败，也不属于本轮修正队列。 */
    const otherRun = createVisualProductionRun('other', access, access)
    expect(await otherRun.takePendingRepairs()).toEqual([])
  })

  test('Given 失败候选已过期 When 检查修正 Then 不续行不消耗纠偏轮次', async () => {
    const current = snapshot()
    current.candidates = [{ id: 'old', jobId: 'job', baseRevision: 1, createdAt: 2, status: 'ready', summary: '旧失败', draft: current.document, reviewRequired: true,
      review: { technical: 'failed', motion: 'pending', continuity: 'pending', conclusion: '旧文件损坏', unchecked: [], issues: [], sessionId: 'session', reviewedAt: 3 } }]
    const access: VisualProductionExecutor = { workspaceId: 'workspace', assertCurrent() {}, async execute<M extends VisualProductionMethod>(method: M): Promise<VisualProductionResults[M]> {
      if (method === 'load') return current as VisualProductionResults[M]
      if (method === 'beginJob') return current.jobs[0] as VisualProductionResults[M]
      throw new Error(`unexpected ${method}`)
    } }
    const run = createVisualProductionRun('session', access, access)
    await run.execute('beginJob', { sessionId: 'session', productionId: 'production', baseRevision: 2, instruction: '优化' })
    expect(await run.takePendingRepairs()).toEqual([])
    expect(await run.pendingReviews()).toEqual([])
    current.candidates[0]!.baseRevision = 2
    expect(await run.takePendingRepairs()).toHaveLength(1)
  })

  test('Given 本轮提交待审影片 When 审核未完成 Then 同一 Agent 自动继续审片步骤', async () => {
    const current = snapshot()
    const candidate = (reviewed: boolean): VisualCandidate => ({
      id: 'candidate', jobId: 'job', baseRevision: 2, createdAt: 2, status: 'ready', summary: '待审影片', reviewRequired: true,
      draft: { ...current.document, shots: current.document.shots },
      ...(reviewed ? { review: { technical: 'passed' as const, motion: 'passed' as const, continuity: 'pending' as const, conclusion: '待补衔接', unchecked: [], issues: [], sessionId: 'session', reviewedAt: 3 } } : {}),
    })
    const access: VisualProductionExecutor = {
      workspaceId: 'workspace', assertCurrent() {},
      async execute<M extends VisualProductionMethod>(method: M, input: VisualProductionInputs[M]): Promise<VisualProductionResults[M]> {
        if (method === 'load') return snapshot(current.candidates[0]) as VisualProductionResults[M]
        if (method === 'beginJob') return { id: 'job', sessionId: 'session', baseRevision: 2, shotId: 'shot', instruction: '生成', status: 'running', createdAt: 1 } as VisualProductionResults[M]
        throw new Error(`unexpected ${method}`)
      },
    }
    const run = createVisualProductionRun('session', access, access)
    await run.execute('beginJob', { sessionId: 'session', productionId: 'production', baseRevision: 2, instruction: '生成', shotId: 'shot' })
    current.candidates = [candidate(false)]
    expect(await run.pendingReviews()).toMatchObject([{ productionId: 'production', candidateId: 'candidate', shotId: 'shot', summary: '待审影片' }])
    const message = buildVisualReviewStepContinuation(await run.pendingReviews())
    expect(message).toContain('不要等待用户点击')
    expect(message).toContain('reviewCandidate')
    expect(message).toContain('continuityPlan')

    current.candidates = [candidate(true)]
    expect(await run.pendingReviews()).toHaveLength(1)
    /** 旧视频无声音门时仍能报告实际缺失的连续性证据，不伪造通过。 */
    current.candidates[0]!.review!.unchecked = ['相邻镜头媒体不可用，衔接未能复验，保留待审']
    expect(await run.pendingReviews()).toEqual([])
    current.candidates = [{ ...candidate(true), review: { ...candidate(true).review!, technical: 'failed', issues: [{ gate: 'technical', severity: 'error', message: '损坏' }] } }]
    expect(await run.pendingReviews()).toEqual([])
    current.candidates = [{ ...candidate(true), review: { ...candidate(true).review!, continuity: 'passed' } }]
    expect(await run.pendingReviews()).toEqual([])
    expect(buildVisualReviewStepContinuation([])).toBeNull()
  })
})

describe('影像 Agent 工作流发现步骤', () => {
  test('Given ComfyUI 视频任务 When 扫描尚未结束 Then 同一 Agent 被要求继续并保存最终结论', async () => {
    const required: VisualJob = {
      id: 'job', sessionId: 'session', baseRevision: 2, shotId: 'shot', instruction: '生成', status: 'running', createdAt: 1,
      mediaKind: 'video',
      workflowDiscovery: {
        status: 'candidates', connectionId: 'comfy.local', mediaKind: 'video',
        candidateCount: 2, blockedCount: 0, nextOffset: 6,
      },
    }
    const current = snapshot()
    current.jobs = [required]
    const access: VisualProductionExecutor = {
      workspaceId: 'workspace', assertCurrent() {},
      async execute<M extends VisualProductionMethod>(method: M, input: VisualProductionInputs[M]): Promise<VisualProductionResults[M]> {
        if (method === 'load') return current as VisualProductionResults[M]
        if (method === 'beginJob') return required as VisualProductionResults[M]
        throw new Error(`unexpected ${method}`)
      },
    }
    const run = createVisualProductionRun('session', access, access)
    await run.execute('beginJob', { sessionId: 'session', productionId: 'production', baseRevision: 2, instruction: '生成', shotId: 'shot', mediaKind: 'video' })
    const otherRun = createVisualProductionRun('other-session', access, access)
    await expect(otherRun.execute('recordWorkflowDiscovery', {
      sessionId: 'other-session', productionId: 'production', baseRevision: 2, jobId: 'job',
      discovery: { status: 'no-match', connectionId: 'comfy.local', mediaKind: 'video', candidateCount: 0, blockedCount: 0, nextOffset: null, message: '越权写入' },
    })).rejects.toThrow('不属于本轮')
    expect(await run.pendingWorkflowDiscoveries()).toMatchObject([{
      productionId: 'production', jobId: 'job', shotId: 'shot', connectionId: 'comfy.local',
      mediaKind: 'video', status: 'candidates', candidateCount: 2, nextOffset: 6,
    }])
    const message = buildVisualWorkflowDiscoveryStepContinuation(await run.pendingWorkflowDiscoveries())
    expect(message).toContain('media_discover_workflows')
    expect(message).toContain('nextOffset')
    expect(message).toContain('visual_production_record_workflow_discovery')
    expect(message).toContain('不能以“工具缺失”')

    current.jobs = [{ ...required, workflowDiscovery: { ...required.workflowDiscovery!, status: 'selected', nextOffset: null, selectedWorkflow: { workflowId: 'workflow', workflowRevision: 2, contentHash: 'a'.repeat(64) } } }]
    expect(await run.pendingWorkflowDiscoveries()).toEqual([])
    current.jobs = [{ ...required, workflowDiscovery: { ...required.workflowDiscovery!, status: 'no-match', nextOffset: null, message: '所有候选的输入角色均不匹配' } }]
    expect(await run.pendingWorkflowDiscoveries()).toEqual([])
    expect(buildVisualWorkflowDiscoveryStepContinuation([])).toBeNull()
  })
})

describe('影像 Agent 媒体生成步骤', () => {
  test('Given 媒体只完成准备尚未执行 When Host 判断等待条件 Then 立即交回 Agent 发起执行', async () => {
    const preparedJob: VisualJob = {
      id: 'job', sessionId: 'session', baseRevision: 2, shotId: 'shot', instruction: '生成镜02影片',
      status: 'running', stage: 'preparing', createdAt: 1,
      mediaExecutions: [{
        runId: 'media-run', engine: 'workflow', name: '芯火 H3', kind: 'video',
        source: { type: 'workflow', connectionId: 'comfy.local', workflowId: 'h3', workflowRevision: 1 },
        parameters: {}, referenceAssets: [], phase: 'prepared', createdAt: 2,
      }],
    }
    const current = snapshot()
    current.jobs = [preparedJob]
    const access: VisualProductionExecutor = {
      workspaceId: 'workspace',
      assertCurrent() {},
      async waitForMediaExecution() { throw new Error('准备态不应进入 Host 终态等待') },
      async execute<M extends VisualProductionMethod>(method: M): Promise<VisualProductionResults[M]> {
        if (method === 'load') return current as VisualProductionResults[M]
        if (method === 'beginJob') return preparedJob as VisualProductionResults[M]
        throw new Error(`unexpected ${method}`)
      },
    }
    const run = createVisualProductionRun('session', access, access)
    await run.execute('beginJob', { sessionId: 'session', productionId: 'production', baseRevision: 2, instruction: '生成镜02影片', shotId: 'shot', mediaKind: 'video' })

    await expect(run.waitForPendingMedia(new AbortController().signal)).resolves.toMatchObject([{ mediaPhase: 'prepared' }])
  })

  test('Given Host 可观察媒体任务 When Agent 回合结束 Then Host 等到真实终态并写回任务而不要求模型轮询', async () => {
    const running: VisualJob = {
      id: 'job', sessionId: 'session', baseRevision: 2, shotId: 'shot', instruction: '生成镜02影片',
      status: 'running', stage: 'generating', createdAt: 1,
      mediaExecutions: [{
        runId: 'media-run', engine: 'workflow', name: '芯火 H3', kind: 'video',
        source: { type: 'workflow', connectionId: 'comfy.local', workflowId: 'h3', workflowRevision: 1 },
        parameters: {}, referenceAssets: [], phase: 'running', createdAt: 2,
      }],
    }
    const current = snapshot()
    current.jobs = [running]
    const waitCalls: string[] = []
    let resolveMedia!: (phase: 'succeeded' | 'failed') => void
    const mediaSettlement = new Promise<'succeeded' | 'failed'>(resolve => { resolveMedia = resolve })
    const access: VisualProductionExecutor & {
      waitForMediaExecution(input: { runId: string; engine: 'model' | 'workflow' }): Promise<{ phase: 'succeeded' | 'failed' }>
    } = {
      workspaceId: 'workspace',
      assertCurrent() {},
      async waitForMediaExecution(input) {
        waitCalls.push(`${input.engine}:${input.runId}`)
        return { phase: await mediaSettlement }
      },
      async execute<M extends VisualProductionMethod>(method: M, input: VisualProductionInputs[M]): Promise<VisualProductionResults[M]> {
        if (method === 'load') return current as VisualProductionResults[M]
        if (method === 'beginJob') return running as VisualProductionResults[M]
        if (method === 'recordMediaExecution') {
          const phase = await mediaSettlement
          current.jobs = [{
            ...running,
            mediaExecutions: [{ ...running.mediaExecutions![0]!, phase }],
          }]
          return current.jobs[0] as VisualProductionResults[M]
        }
        throw new Error(`unexpected ${method}`)
      },
    }
    const run = createVisualProductionRun('session', access, access)
    await run.execute('beginJob', { sessionId: 'session', productionId: 'production', baseRevision: 2, instruction: '生成镜02影片', shotId: 'shot', mediaKind: 'video' })
    expect(await run.pendingMediaSteps()).toMatchObject([{ mediaRunId: 'media-run', mediaPhase: 'running', mediaEngine: 'workflow' }])
    const waiting = run.waitForPendingMedia(new AbortController().signal)
    await Promise.resolve()
    resolveMedia('succeeded')
    const pending = await waiting

    expect(waitCalls).toEqual(['workflow:media-run'])
    expect(pending).toMatchObject([{ jobId: 'job', mediaRunId: 'media-run', mediaPhase: 'succeeded' }])
  })

  test('Given 本轮影像任务仍在生成 When Agent 尝试结束 Then Host 要求继续等待并提交候选', async () => {
    const running: VisualJob = {
      id: 'job',
      sessionId: 'session',
      baseRevision: 2,
      shotId: 'shot',
      instruction: '生成镜02影片',
      status: 'running',
      stage: 'generating',
      createdAt: 1,
      mediaExecutions: [{
        runId: 'media-run',
        engine: 'workflow',
        name: '芯火 H3',
        kind: 'video',
        source: { type: 'workflow', connectionId: 'comfy.local', workflowId: 'h3', workflowRevision: 1 },
        parameters: {},
        referenceAssets: [],
        phase: 'running',
        createdAt: 2,
      }],
    }
    const current = snapshot()
    current.jobs = [running]
    const access: VisualProductionExecutor = {
      workspaceId: 'workspace',
      assertCurrent() {},
      async execute<M extends VisualProductionMethod>(method: M, input: VisualProductionInputs[M]): Promise<VisualProductionResults[M]> {
        if (method === 'load') return current as VisualProductionResults[M]
        if (method === 'beginJob') return running as VisualProductionResults[M]
        throw new Error(`unexpected ${method}`)
      },
    }
    const run = createVisualProductionRun('session', access, access)
    await run.execute('beginJob', { sessionId: 'session', productionId: 'production', baseRevision: 2, instruction: '生成镜02影片', shotId: 'shot', mediaKind: 'video' })
    expect(await run.pendingMediaSteps()).toMatchObject([{
      productionId: 'production',
      jobId: 'job',
      shotId: 'shot',
      mediaRunId: 'media-run',
      mediaPhase: 'running',
    }])
    const message = buildVisualMediaStepContinuation(await run.pendingMediaSteps())
    expect(message).toContain('Host 托管等待')
    expect(message).not.toContain('使用 media_wait_run 沿真实 revision')
    expect(message).toContain('visual_production_propose_shot')
    expect(message).toContain('visual_production_fail_job')
    expect(message).toContain('不能以普通成功终态结束')
    expect(message).toContain('不展示 runId、内部工具名或工作流版本')

    current.jobs = [{ ...running, status: 'candidate' }]
    expect(await run.pendingMediaSteps()).toEqual([])
    expect(buildVisualMediaStepContinuation([])).toBeNull()
  })
})
