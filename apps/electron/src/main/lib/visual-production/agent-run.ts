import type { VisualProductionInputs, VisualProductionMethod, VisualProductionResults, VisualJob } from '@proma/shared'
import type { VisualProductionExecutor } from './access'

/** 单轮主会话只结算本轮签发的任务；不扫描、接管其他运行的任务。 */
export function createVisualProductionRun(sessionId: string, access: VisualProductionExecutor, cleanup: VisualProductionExecutor) {
  /** 本轮实际 beginJob 返回的可信身份，不采纳模型提供的任意任务。 */
  const ownedJobs = new Map<string, { job: VisualJob; productionId: string }>()
  return {
    async execute<M extends VisualProductionMethod>(method: M, input: VisualProductionInputs[M], signal?: AbortSignal): Promise<VisualProductionResults[M]> {
      if ((method === 'propose' || method === 'failJob') && 'jobId' in input) {
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
