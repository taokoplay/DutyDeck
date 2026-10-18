import { Type } from 'typebox'
import { Value } from 'typebox/value'
import type { ToolDefinition } from '@earendil-works/pi-coding-agent'
import { createAgentSession, getAgentSessionMeta, updateAgentSessionMeta } from '../agent-session-manager'
import { runRegisteredHeadlessAgent, stopRegisteredAgent } from '../agent-headless-runner-registry'
import { createVisualContextDelegation } from './context-delegation'
import { buildVisualTaskContextTools } from './task-context-tools'
import type { VisualTaskContextRuntime } from './task-context'

/** 固定父运行和范围；工具参数不能选择模型、会话、项目或文件。 */
interface VisualDelegationToolOptions {
  sdk: Pick<typeof import('@earendil-works/pi-coding-agent'), 'defineTool'>
  sessionId: string
  workspaceId: string
  channelId: string
  modelId: string
  runtime: VisualTaskContextRuntime
  assertActive(): void
  assertWrite(): void
  createRuntime(runId: string, parentContextId: string): VisualTaskContextRuntime
}

/**
 * 装配专用审图委派；子运行仅能检查冻结范围和保存观察。
 * @param options 主进程固定的父任务身份与域服务。
 * @returns 主 Agent 工具以及显式取消/释放入口。
 */
export function buildVisualContextDelegationTools(options: VisualDelegationToolOptions) {
  const controller = createVisualContextDelegation({
    parentSessionId: options.sessionId, workspaceId: options.workspaceId, channelId: options.channelId, modelId: options.modelId,
    assertActive: options.assertActive,
    assertContext: async contextId => { await options.runtime.describe(contextId) },
    createSession: (id, objective) => {
      options.assertWrite()
      const parent = getAgentSessionMeta(options.sessionId)
      const child = createAgentSession(`影像检查 · ${objective.slice(0, 40)}`, options.channelId, options.workspaceId, options.modelId)
      updateAgentSessionMeta(child.id, { parentSessionId: options.sessionId, rootSessionId: parent?.rootSessionId ?? options.sessionId,
        sourceDelegationId: id, sourceVisualReviewRunId: id, delegationRole: 'review', delegationDepth: (parent?.delegationDepth ?? 0) + 1,
        delegationGoal: objective, delegationStatus: 'running', permissionMode: 'bypassPermissions' })
      return child.id
    },
    createTools: async (parentContextId, runId) => {
      const frozen = await options.runtime.describe(parentContextId)
      const runtime = options.createRuntime(runId, parentContextId)
      try {
        const opened = await runtime.open(frozen.openInput)
        const contextId = opened.details.visualTaskContext.contextId
        let recorded = false
        /** 每次执行前后复核父范围，防切换阶段后的迟到读图与提交。 */
        const tools = buildVisualTaskContextTools({ sdk: options.sdk, runtime, assertAccess: write => {
          options.assertActive()
          if (write) options.assertWrite()
        } }).filter(tool => tool.name === 'visual_production_inspect_media' || tool.name === 'visual_production_record_observation')
          .map((tool): ToolDefinition => ({ ...tool, async execute(callId, args, signal, onUpdate, ctx) {
            await options.runtime.describe(parentContextId, signal)
            const result = await tool.execute(callId, args, signal, onUpdate, ctx)
            await options.runtime.describe(parentContextId, signal)
            if (tool.name === 'visual_production_record_observation') recorded = true
            return result
          } }))
        const description = await runtime.describe(contextId)
        return { tools, policy: { runId, initialContextId: contextId }, prompt: JSON.stringify({ contextId, scope: description.openInput,
          media: description.media, guidance: '仅使用此 contextId，按检查目标选择素材；先inspect，再依据实际图像record。' }),
        hasObservation: () => recorded, dispose: () => runtime.dispose() }
      } catch (error) { runtime.dispose(); throw error }
    },
    run: async (input, callbacks, extensions) => {
      await runRegisteredHeadlessAgent(input, { ...callbacks,
        onError: error => { updateAgentSessionMeta(input.sessionId, { delegationStatus: 'failed' }); callbacks.onError(error) },
        onComplete: (messages, terminal) => {
          updateAgentSessionMeta(input.sessionId, { delegationStatus: terminal?.status === 'completed' ? 'completed' : terminal?.status === 'cancelled' ? 'cancelled' : 'failed' })
          callbacks.onComplete(messages, terminal)
        },
      }, extensions)
    },
    stop: sessionId => { updateAgentSessionMeta(sessionId, { delegationStatus: 'cancelled' }); stopRegisteredAgent(sessionId) },
  })
  /** 只有显式请求才启动子模型；查询回执不会等待或重放生成。 */
  const startSchema = Type.Object({ contextId: Type.String({ minLength: 1, maxLength: 128 }), objective: Type.String({ minLength: 1, maxLength: 2000 }) }, { additionalProperties: false })
  const readSchema = Type.Object({ reviewId: Type.String({ minLength: 1, maxLength: 128 }) }, { additionalProperties: false })
  const tools: ToolDefinition[] = [
    options.sdk.defineTool({ name: 'visual_production_delegate_review', label: '委派影像检查',
      description: '在当前已打开的视觉范围中启动独立受限审图子 Agent；只能查看授权素材并保存观察，不会生成媒体或继承主会话图片。返回回执后用read_review查询。', parameters: startSchema,
      async execute(_id, input, signal) {
        signal?.throwIfAborted(); options.assertWrite()
        if (!Value.Check(startSchema, input)) throw new Error('VISUAL_REVIEW_INPUT_INVALID')
        const receipt = await controller.start(input.contextId, input.objective, signal)
        return { content: [{ type: 'text', text: JSON.stringify(receipt) }], details: receipt }
      },
    }),
    options.sdk.defineTool({ name: 'visual_production_read_review', label: '读取影像检查回执',
      description: '读取本轮专用检查子任务真实终态。completed才返回固定范围的持久观察；摘要不等于验收证明。旧运行只可从重新打开范围的历史观察追溯，不能自动续跑。', parameters: readSchema,
      async execute(_id, input, signal) {
        signal?.throwIfAborted(); options.assertActive()
        if (!Value.Check(readSchema, input)) throw new Error('VISUAL_REVIEW_INPUT_INVALID')
        const receipt = await controller.read(input.reviewId)
        const scope = await options.runtime.describe(receipt.contextId, signal, receipt.id)
        const result = { ...receipt, ...(receipt.status === 'completed' ? { observations: scope.observations } : {}) }
        return { content: [{ type: 'text', text: JSON.stringify(result) }], details: result }
      },
    }),
  ]
  return { tools, cancelAll: () => controller.cancelAll(), dispose: () => controller.dispose() }
}
