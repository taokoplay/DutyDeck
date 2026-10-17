import type { ToolDefinition } from '@earendil-works/pi-coding-agent'
import type { MediaInputValue, VisualJob, VisualProductionMediaOption, VisualProductionMediaSource, VisualProductionMediaKind } from '@dutydeck/shared'
import { visualProductionMediaSourceAllows } from '@dutydeck/shared'
import { Type } from 'typebox'
import type { TSchema } from 'typebox'
import type { VisualProductionExecutor } from './access'
import { mergeVisualMediaInputs } from './media-catalog'
import { visualMediaExecutionContext } from './media-execution-context'

/** 媒体绑定仅接受本轮 beginJob 签发的身份。 */
interface VisualMediaJob { job: VisualJob; productionId: string }
/** 工具包装沿用既有媒体授权和调用，只增加作品范围与可信记录。 */
interface VisualMediaBindingOptions {
  sessionId: string
  access: VisualProductionExecutor
  jobs(): VisualMediaJob[]
}
/** 以字段比较来源，避免属性排列顺序改变身份判断。 */
function sameSource(left: VisualProductionMediaSource, right: VisualProductionMediaSource): boolean {
  return left.type === right.type && visualProductionMediaSourceAllows(left, right)
}
/** 优先使用原有固定工作流参数，服务范围不能覆盖更精确的冻结设置。 */
function configuredEntry(job: VisualJob, source: VisualProductionMediaSource, kind: VisualProductionMediaKind) {
  const entries = job.mediaConfiguration?.entries
  return entries?.find(entry => entry.kind === kind && sameSource(entry.source, source))
    ?? entries?.find(entry => entry.kind === kind && visualProductionMediaSourceAllows(entry.source, source))
}
/**
 * 为既有媒体工具绑定影像任务；无活动影像任务时保留普通 Agent 行为。
 * @param tools 已带权限策略的内建工具。
 * @param options 固定会话、项目访问器与本轮任务目录。
 * @returns 不改变原工具名称和授权策略的包装工具。
 */
export function bindVisualProductionMediaTools(tools: ToolDefinition[], options: VisualMediaBindingOptions): ToolDefinition[] {
  /** 已准备运行的绑定在本轮内不可改派到其他作品。 */
  const bindings = new Map<string, VisualMediaJob & { engine: 'model' | 'workflow'; option: VisualProductionMediaOption }>()
  /** 每次以持久化状态排除取消、过期、已交候选任务。 */
  async function activeJobs(): Promise<VisualMediaJob[]> {
    const snapshots = new Map<string, Awaited<ReturnType<typeof load>>>()
    const jobs: VisualMediaJob[] = []
    for (const owned of options.jobs()) {
      let snapshot = snapshots.get(owned.productionId)
      if (!snapshot) { snapshot = await load(owned.productionId); snapshots.set(owned.productionId, snapshot) }
      const job = snapshot.jobs.find(item => item.id === owned.job.id && item.sessionId === options.sessionId)
      if (job?.status === 'running' && job.baseRevision === snapshot.document.revision) jobs.push({ productionId: owned.productionId, job })
    }
    return jobs
  }
  /** 归属由访问器复核，输入不包含本机路径。 */
  function load(productionId: string) { return options.access.execute('load', { sessionId: options.sessionId, productionId }) }
  /** 执行前只允许当前仍可执行的公开来源；不自动替换失效方案。 */
  async function currentOption(binding: VisualMediaJob, source: VisualProductionMediaSource, kind?: string): Promise<VisualProductionMediaOption> {
    /** 工作流必须由 Agent 给出精确版本，目录服务本身没有可执行的输入定义。 */
    let option: VisualProductionMediaOption | undefined
    if (source.type === 'workflow') {
      if (kind !== 'image' && kind !== 'video' && kind !== 'audio') throw new Error('VISUAL_MEDIA_WORKFLOW_REQUIRED: 请指定工作流输出类别')
      if (binding.job.mediaConfiguration && !configuredEntry(binding.job, source, kind)) throw new Error('VISUAL_MEDIA_OUT_OF_SCOPE: 当前制作任务未启用此服务或工作流')
      option = await options.access.execute('resolveMediaWorkflow', { sessionId: options.sessionId, productionId: binding.productionId, source, kind })
      if (option.kind !== kind || !sameSource(option.source, source)) throw new Error('VISUAL_MEDIA_WORKFLOW_MISMATCH: 工作流解析结果与选定来源不符')
    } else if (source.type === 'model') {
      const catalog = await options.access.execute('mediaCatalog', { sessionId: options.sessionId, productionId: binding.productionId })
      option = catalog.find(item => sameSource(item.source, source) && (!kind || item.kind === kind))
    }
    if (!option?.available) throw new Error('VISUAL_MEDIA_UNAVAILABLE: 制作来源不可用，请检查制作配置')
    if (binding.job.mediaConfiguration && !configuredEntry(binding.job, source, option.kind)) throw new Error('VISUAL_MEDIA_OUT_OF_SCOPE: 当前制作任务未启用此方案')
    return option
  }
  /** 主进程按运行身份回读事实，模型不能填报虚假来源、参数或素材。 */
  async function record(runId: string, binding: VisualMediaJob & { engine: 'model' | 'workflow' }): Promise<void> {
    await options.access.execute('recordMediaExecution', { sessionId: options.sessionId, productionId: binding.productionId, baseRevision: binding.job.baseRevision, jobId: binding.job.id, runId, engine: binding.engine })
  }
  return tools.map(tool => {
    /** 精确名单不拦截画布执行或其他业务工具。 */
    const prepare = tool.name === 'media_prepare_generation' || tool.name === 'media_prepare_run'
    const execute = tool.name === 'media_execute_generation' || tool.name === 'media_execute_run'
    const observe = ['media_get_generation', 'media_wait_generation', 'media_cancel_generation', 'media_get_run', 'media_wait_run', 'media_cancel_run'].includes(tool.name)
    if (!prepare && !execute && !observe) return tool
    return {
      ...tool,
      ...(prepare ? { description: `${tool.description} 影像制作须先 begin_job，再按作品制作配置选择来源；多个活动任务时必须提供 visualJobId。作品默认参数会自动补入，inputs 可显式覆盖。`, parameters: { ...tool.parameters, properties: { ...((tool.parameters as TSchema & { properties?: Record<string, TSchema> }).properties ?? {}), visualJobId: Type.Optional(Type.String({ minLength: 1, maxLength: 128 })) } } } : {}),
      async execute(callId, raw, signal, onUpdate, context) {
        signal?.throwIfAborted()
        /** 丢弃包装专属字段后才交原工具严格解析。 */
        const { visualJobId, ...params } = raw as Record<string, unknown>
        if (prepare) {
          const jobs = await activeJobs()
          const selected = visualJobId ? jobs.find(item => item.job.id === visualJobId) : jobs.length === 1 ? jobs[0] : undefined
          if ((visualJobId && !selected) || jobs.length > 1 && !selected) throw new Error('VISUAL_MEDIA_JOB_REQUIRED: 请提供本轮活动任务的 visualJobId')
          if (!selected) return tool.execute(callId, params, signal, onUpdate, context)
          const engine: 'model' | 'workflow' = tool.name === 'media_prepare_generation' ? 'model' : 'workflow'
          if (engine === 'workflow' && (params.profileId || !params.connectionId || !params.workflowId || !params.workflowRevision || !params.mediaKind)) throw new Error('VISUAL_MEDIA_WORKFLOW_REQUIRED: 请在作品允许的服务内发现并检查工作流，再提供 connectionId、workflowId、workflowRevision、mediaKind')
          const source: VisualProductionMediaSource = engine === 'model' ? { type: 'model', modelRef: String(params.modelRef) } : { type: 'workflow', connectionId: String(params.connectionId), workflowId: String(params.workflowId), workflowRevision: Number(params.workflowRevision) }
          const option = await currentOption(selected, source, typeof params.mediaKind === 'string' ? params.mediaKind : undefined)
          const entry = configuredEntry(selected.job, source, option.kind)
          params.inputs = mergeVisualMediaInputs(option, entry?.parameters ?? {}, (params.inputs ?? {}) as Record<string, MediaInputValue>)
          signal?.throwIfAborted()
          const result = await visualMediaExecutionContext.run({ sessionId: options.sessionId, productionId: selected.productionId, jobId: selected.job.id, baseRevision: selected.job.baseRevision }, () => tool.execute(callId, params, signal, onUpdate, context))
          const details = result.details as { id?: unknown } | undefined
          if (typeof details?.id === 'string') {
            const binding = { ...selected, engine, option }
            bindings.set(`${engine}:${details.id}`, binding)
            await record(details.id, binding)
          }
          return result
        }
        const engine = tool.name.endsWith('_generation') ? 'model' : 'workflow'
        const runId = String(params.runId)
        const binding = bindings.get(`${engine}:${runId}`)
        if (execute) {
          if (!binding && (await activeJobs()).length) throw new Error('VISUAL_MEDIA_RUN_NOT_BOUND: 请先为当前影像任务准备媒体生成')
          if (binding) {
            await currentOption(binding, binding.option.source, binding.option.kind)
            await record(runId, binding)
          }
        }
        signal?.throwIfAborted()
        const result = binding && execute
          ? await visualMediaExecutionContext.run({ sessionId: options.sessionId, productionId: binding.productionId, jobId: binding.job.id, baseRevision: binding.job.baseRevision }, () => tool.execute(callId, params, signal, onUpdate, context))
          : await tool.execute(callId, params, signal, onUpdate, context)
        /** 终态作品保持只读；取消/查询仍允许回收原媒体任务。 */
        if (binding && (await activeJobs()).some(item => item.job.id === binding.job.id)) await record(runId, binding)
        return result
      },
    }
  })
}
