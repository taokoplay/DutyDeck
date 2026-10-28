import { describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { SDKMessage, VisualCandidate, VisualJob } from '@dutydeck/shared'
import { createVisualProductionRun, buildVisualCompletionEvaluation } from './agent-run'
import { buildVisualProductionAgentTools } from './agent-tools'
import { VisualProductionService } from './store'
import { applyAgentCompletionPolicy } from '../agent-completion-policy'

describe('多作品文本交付集成', () => {
  test('Given 两作品 When 正确读取第二部后漏写入 Then Host续行且候选采用仅持久化第二部', async () => {
    /** 全链路只用临时项目，验证真实候选、CAS、磁盘持久化与宿主完成策略。 */
    const projectRoot = mkdtempSync(join(tmpdir(), 'visual-text-delivery-'))
    try {
      const service = new VisualProductionService({ workspaceId: 'workspace', projectRoot })
      const first = await service.invoke('create', { sessionId: 'session', title: '大胤刑警', kind: 'film' })
      const second = await service.invoke('create', { sessionId: 'session', title: '妖巷', kind: 'comic' })
      const target = { sessionId: 'session', productionId: second.document.id }
      const access = { workspaceId: 'workspace', assertCurrent() {}, execute: service.invoke.bind(service) }
      const run = createVisualProductionRun('session', access, access, [target.productionId])
      const tools = buildVisualProductionAgentTools({ sessionId: 'session', sdk: { defineTool: (definition: unknown) => definition } as Parameters<typeof buildVisualProductionAgentTools>[0]['sdk'], assertAccess() {}, execute: run.execute, completeTask: run.completeTask })
      /** 实际工具入口注入会话，不允许测试直接改作品文件。 */
      const call = (name: string, input: Record<string, unknown>) => tools.find(tool => tool.name === name)!.execute('call', input, new AbortController().signal, undefined, {} as never)
      await call('visual_production_list', {})
      await call('visual_production_read', { productionId: target.productionId })
      let continued = false
      const evaluated = await applyAgentCompletionPolicy({ terminalResult: { type: 'result', subtype: 'success', session_id: 'session' } as SDKMessage, continuationCount: 0, canContinue: true, signal: new AbortController().signal,
        evaluateCompletion: async () => buildVisualCompletionEvaluation(run.pendingDelivery()), continueTask: async () => { continued = true } })
      expect(continued).toBe(true)
      expect(evaluated.continued).toBe(true)
      await expect(call('visual_production_complete_task', { outcome: 'written', productionIds: [target.productionId], reason: '已在聊天中交付分镜' })).rejects.toThrow('正式写入')
      const job = (await call('visual_production_begin_job', { productionId: target.productionId, baseRevision: 1, instruction: '新增首集分镜' })).details as VisualJob
      const { title, kind, brief, ratio, fps, voice, music, episodes, assets } = second.document
      const candidate = (await call('visual_production_propose', { productionId: target.productionId, baseRevision: 1, jobId: job.id, summary: '首集两个镜头', draft: { title, kind, brief, ratio, fps, voice, music, episodes, assets, shots: ['opening', 'reveal'].map(id => ({ id, episodeId: episodes[0]!.id, title: id, duration: 3, scene: '雨夜石巷', motion: '镜头推进', dialogue: '', assetIds: [], mediaId: null })) } })).details as VisualCandidate
      await expect(call('visual_production_complete_task', { outcome: 'written', productionIds: [target.productionId], reason: '已提交候选' })).rejects.toThrow('正式写入')
      await call('visual_production_adopt_candidate', { productionId: target.productionId, baseRevision: 1, candidateId: candidate.id })
      await call('visual_production_complete_task', { outcome: 'written', productionIds: [target.productionId], reason: '首集分镜已采用' })
      expect(run.pendingDelivery()).toBeNull()
      /** 重新创建服务读取磁盘，不能用内存对象变更冒充持久化成功。 */
      const reloaded = new VisualProductionService({ workspaceId: 'workspace', projectRoot })
      expect((await reloaded.invoke('load', target)).document.shots.map(shot => shot.id)).toEqual(['opening', 'reveal'])
      expect((await reloaded.invoke('load', { sessionId: 'session', productionId: first.document.id })).document).toEqual(first.document)
      await run.finish(false)
    } finally { rmSync(projectRoot, { recursive: true, force: true }) }
  })
})
