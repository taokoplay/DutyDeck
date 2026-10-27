import type { ToolDefinition } from '@earendil-works/pi-coding-agent'
import type { AgentToolResult } from '@earendil-works/pi-agent-core'
import type { MediaAssetRef, MediaInputValue, VisualJob, VisualProductionMediaOption, VisualProductionMediaSource, VisualProductionMediaKind } from '@dutydeck/shared'
import { resolveVisualShotOutputs, visualProductionMediaSourceAllows } from '@dutydeck/shared'
import { Type } from 'typebox'
import type { TSchema } from 'typebox'
import type { VisualProductionExecutor } from './access'
import { mergeVisualMediaInputs } from './media-catalog'
import { visualMediaExecutionContext } from './media-execution-context'

/** 缺少本轮媒体任务时给出可直接执行、且必须在同一回合完成的恢复路径。 */
const VISUAL_MEDIA_JOB_REQUIRED_MESSAGE = 'VISUAL_MEDIA_JOB_REQUIRED: 当前回合还没有影像任务。现在调用 visual_production_begin_job，绑定作品、目标镜头、最新 baseRevision 与 mediaKind，然后立即继续原来的 media_prepare_* 调用；不要只报告此错误、检查 revision 或结束回合。'
/** 镜头计划缺失时指向单镜头原子工具，避免模型退回整份草稿或 Canvas。 */
const VIDEO_PLAN_REQUIRED_MESSAGE = 'VIDEO_PLAN_REQUIRED: 当前单镜头缺少生成计划。现在调用 visual_production_update_shot_plan，基于最新镜头写入 videoPlan 与 continuityPlan；已导入的首尾帧通过 references 登记。成功后重新 begin_job 并继续生成，禁止改用整份 draft、无 job、Canvas 或其他绕过路径。'
/** Host 已接管长时媒体等待，不再把轮询工具作为模型下一步。 */
const HOST_MANAGED_WAIT_TOOLS = new Set(['media_wait_run', 'media_wait_generation'])

/**
 * 从影像任务的工具回执中移除主动轮询动作，明确下一步由 Host 等待终态。
 * @param result 原媒体工具回执。
 * @returns 保持同一工具结果结构的投影结果。
 */
function projectHostManagedMediaWait(result: AgentToolResult<unknown>): AgentToolResult<unknown> {
  if (!result.details || typeof result.details !== 'object' || Array.isArray(result.details)) return result
  const details = result.details as Record<string, unknown>
  if (!Array.isArray(details.availableActions)) return result
  const availableActions = details.availableActions.filter(action => !HOST_MANAGED_WAIT_TOOLS.has(String(action)))
  if (availableActions.length === details.availableActions.length) return result
  const projected = {
    ...details,
    availableActions,
    hostManagedWait: 'Host 会等待媒体终态并在成功后自动续行；不要重复调用等待工具刷新进度。',
  }
  return { ...result, content: [{ type: 'text', text: JSON.stringify(projected) }], details: projected }
}

/**
 * 判断不可信值是否是历史调用方常用的裸媒体引用。
 * @param value 待检查的输入值。
 * @returns 字段完整且只包含媒体引用字段时为 true。
 */
function isRawMediaReference(value: unknown): value is MediaAssetRef {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const reference = value as Record<string, unknown>
  const allowed = new Set(['assetId', 'revision', 'hash', 'mediaKind'])
  if (Object.keys(reference).some(key => !allowed.has(key))) return false
  return typeof reference.assetId === 'string'
    && typeof reference.revision === 'number'
    && Number.isSafeInteger(reference.revision)
    && reference.revision >= 1
    && typeof reference.hash === 'string'
    && (reference.mediaKind === 'image' || reference.mediaKind === 'video' || reference.mediaKind === 'audio')
}

/**
 * 将历史调用中的裸媒体引用规范化为 MediaInputValue。
 * 只兼容完整媒体身份，未知形状继续交给原媒体工具严格拒绝。
 * @param inputs Agent 传入的原始媒体输入。
 * @returns 已规范化的输入映射。
 */
function normalizeMediaInputs(inputs: unknown): Record<string, MediaInputValue> {
  if (!inputs || typeof inputs !== 'object' || Array.isArray(inputs)) return inputs as Record<string, MediaInputValue>
  const normalized: Record<string, MediaInputValue> = Object.create(null) as Record<string, MediaInputValue>
  for (const [key, value] of Object.entries(inputs)) {
    normalized[key] = isRawMediaReference(value) ? { kind: 'asset', asset: value } : value as MediaInputValue
  }
  return normalized
}

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
      if (job?.status === 'running' && (job.compatibleRevision ?? job.baseRevision) === snapshot.document.revision) jobs.push({ productionId: owned.productionId, job })
    }
    return jobs
  }
  /** 归属由访问器复核，输入不包含本机路径。 */
  function load(productionId: string) { return options.access.execute('load', { sessionId: options.sessionId, productionId }) }
  /**
   * 按 Agent 保存的镜头视频设计核对实际参考帧。
   * @param binding 当前冻结的影像任务。
   * @param option 已解析的视频制作方案。
   * @param inputs 完成默认参数合并后的媒体输入。
   * @returns 校验完成后的空值；旧镜头没有计划时保持原行为。
   */
  async function assertVideoPlanInputs(binding: VisualMediaJob, option: VisualProductionMediaOption, inputs: Record<string, MediaInputValue>): Promise<void> {
    if (option.kind !== 'video') return
    const snapshot = await load(binding.productionId)
    const shot = binding.job.shotId ? snapshot.document.shots.find(item => item.id === binding.job.shotId) : undefined
    const plan = shot?.videoPlan
    /** 单镜头视频必须先有 Agent 保存的制作决定；整作品旧任务保持兼容。 */
    if (binding.job.shotId && !plan) throw new Error(VIDEO_PLAN_REQUIRED_MESSAGE)
    /** 衔接合同在媒体执行前再次校验，防止调用方绕过 UI 准备门禁。 */
    const continuity = shot?.continuityPlan
    if (binding.job.shotId && (!continuity?.entryState.trim() || !continuity.exitState.trim() || !continuity.rationale.trim())) {
      throw new Error('CONTINUITY_PLAN_REQUIRED: 请先明确入场状态、出场状态、动作锚点与声音接续')
    }
    if (!shot || !plan) return
    /** 当前已采用画面、显式首帧资产和尾帧资产都转换为不可变媒体身份。 */
    const mediaById = new Map(snapshot.media.map(item => [item.id, item]))
    const outputs = resolveVisualShotOutputs(shot, mediaById)
    const frameMediaIds = plan.mode === 'text-to-video'
      ? []
      : [
          plan.firstFrameAssetId
            ? snapshot.document.assets.find(asset => asset.id === plan.firstFrameAssetId)?.mediaId
            : outputs.image,
          ...(plan.mode === 'first-last-frame'
            ? [snapshot.document.assets.find(asset => asset.id === plan.lastFrameAssetId)?.mediaId]
            : []),
        ]
    if (frameMediaIds.some(mediaId => !mediaId)) throw new Error('VIDEO_PLAN_FRAME_MISSING: 镜头生成计划的参考帧尚无正式媒体')
    /** 已选择图片的动作锚点必须进入真实输入，不能只在界面展示后被静默忽略。 */
    const anchorMediaIds = continuity?.anchors.flatMap(anchor => {
      if (!anchor.assetId) return []
      const asset = snapshot.document.assets.find(item => item.id === anchor.assetId)
      return asset?.mediaId ? [asset.mediaId] : [null]
    }) ?? []
    if (anchorMediaIds.some(mediaId => !mediaId)) throw new Error('CONTINUITY_PLAN_ANCHOR_MEDIA_MISSING: 动作锚点尚无正式图片媒体')
    /** 只比较受来源设计约束的图片哈希；工作流内部其他标量仍由原校验处理。 */
    const expected = [...new Set([...frameMediaIds, ...anchorMediaIds].filter((mediaId): mediaId is string => Boolean(mediaId)).map(mediaId => mediaById.get(mediaId)?.hash).filter((hash): hash is string => Boolean(hash)))].sort()
    const actual = Object.values(inputs).filter((value): value is Extract<MediaInputValue, { kind: 'asset' }> => value.kind === 'asset' && value.asset.mediaKind === 'image').map(value => value.asset.hash).sort()
    if (expected.length !== actual.length || expected.some((hash, index) => hash !== actual[index])) {
      /** 诊断只暴露内容哈希前缀，便于核对资产而不泄露本地路径或凭据。 */
      const format = (hashes: string[]) => hashes.map(hash => hash.slice(0, 8)).join(', ') || '无'
      throw new Error(`VIDEO_PLAN_INPUT_MISMATCH: 镜头计划要求 ${expected.length} 张图片（${format(expected)}），实际提交 ${actual.length} 张（${format(actual)}）`)
    }
  }
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
    const discover = tool.name === 'media_discover_workflows'
    const selectWorkflow = tool.name === 'media_use_remote_workflow' || tool.name === 'media_save_local_workflow'
    /** 精确已存版本的成功检查可恢复任务选择，不必重新发现远端目录。 */
    const inspectWorkflow = tool.name === 'media_inspect_workflow'
    const execute = tool.name === 'media_execute_generation' || tool.name === 'media_execute_run'
    const observe = ['media_get_generation', 'media_wait_generation', 'media_cancel_generation', 'media_get_run', 'media_wait_run', 'media_cancel_run'].includes(tool.name)
    if (!prepare && !discover && !selectWorkflow && !inspectWorkflow && !execute && !observe) return tool
    return {
      ...tool,
      ...(prepare || discover || selectWorkflow || inspectWorkflow ? { description: `${tool.description} 影像制作须先 begin_job，再按作品制作配置选择来源；多个活动任务时必须提供 visualJobId。`, parameters: { ...tool.parameters, properties: { ...((tool.parameters as TSchema & { properties?: Record<string, TSchema> }).properties ?? {}), visualJobId: Type.Optional(Type.String({ minLength: 1, maxLength: 128 })) } } } : {}),
      async execute(callId, raw, signal, onUpdate, context) {
        signal?.throwIfAborted()
        /** 丢弃包装专属字段后才交原工具严格解析。 */
        const { visualJobId, ...params } = raw as Record<string, unknown>
        if (discover || selectWorkflow || inspectWorkflow) {
          const jobs = await activeJobs()
          const selected = visualJobId ? jobs.find(item => item.job.id === visualJobId) : jobs.length === 1 ? jobs[0] : undefined
          /** 未开始制作时仍允许只读检查，不把诊断操作变成生成前置任务。 */
          if (inspectWorkflow && !visualJobId && jobs.length === 0) return tool.execute(callId, params, signal, onUpdate, context)
          if ((visualJobId && !selected) || jobs.length > 1 && !selected) throw new Error(`${VISUAL_MEDIA_JOB_REQUIRED_MESSAGE} 多个活动任务时必须继续提供正确的 visualJobId。`)
          /** 影像模块的生成必须归属本轮镜头任务，否则结果无法进入候选与审片链路。 */
          if (!selected) throw new Error(VISUAL_MEDIA_JOB_REQUIRED_MESSAGE)
          const result = await tool.execute(callId, params, signal, onUpdate, context)
          let details = result.details as Record<string, unknown> | undefined
          if (inspectWorkflow) {
            /** 只信宿主解析的完整身份；裸定义、失败检查和不匹配输出均不能选定。 */
            const identity = details?.savedWorkflow as Record<string, unknown> | undefined
            const mediaKind = selected.job.mediaKind ?? selected.job.workflowDiscovery?.mediaKind
            if (!identity || params.definition !== undefined || params.prompt !== undefined
              || identity.id !== params.workflowId || identity.revision !== params.workflowRevision
              || typeof identity.id !== 'string' || !identity.id
              || typeof identity.revision !== 'number' || !Number.isSafeInteger(identity.revision) || identity.revision < 1
              || typeof identity.hash !== 'string' || !/^[a-f0-9]{64}$/.test(identity.hash)
              || typeof identity.connectionId !== 'string' || !identity.connectionId
              || (params.connectionId !== undefined && params.connectionId !== identity.connectionId)
              || !Array.isArray(details?.issues) || details.issues.length !== 0
              || !Array.isArray(details.unsupportedReasons) || details.unsupportedReasons.length !== 0
              || !Array.isArray(details.outputs) || !details.outputs.some(output => output?.mediaType === mediaKind)) return result
            /** 重用作品配置与可执行性校验，检查成功不代表可越过作品的来源边界。 */
            await currentOption(selected, { type: 'workflow', connectionId: identity.connectionId, workflowId: identity.id, workflowRevision: identity.revision }, mediaKind)
            details = identity
          }
          if (discover) {
            const discovery = details && typeof details.discovery === 'object' && details.discovery ? details.discovery as Record<string, unknown> : {}
            const rawStatus = String(discovery.status ?? 'blocked')
            const status = rawStatus === 'incomplete' ? 'scanning'
              : rawStatus === 'candidates' ? 'candidates'
                : rawStatus === 'no-match' ? 'no-match'
                  : rawStatus === 'blocked' || rawStatus === 'unavailable' ? 'blocked' : 'scanning'
            const items: unknown[] = Array.isArray(details?.items) ? details.items : []
            const nextOffset = typeof details?.nextOffset === 'number' ? details.nextOffset : null
            const checkedAt = typeof details?.checkedAt === 'number' ? details.checkedAt : Date.now()
            const mediaKind = selected.job.mediaKind === 'image' || selected.job.mediaKind === 'video' || selected.job.mediaKind === 'audio'
              ? selected.job.mediaKind : 'video'
            const connectionId = typeof details?.connectionId === 'string'
              ? details.connectionId
              : selected.job.workflowDiscovery?.connectionId
            if (!connectionId) throw new Error('WORKFLOW_DISCOVERY_RESULT_INVALID: 发现回执缺少可信服务身份')
            /** 按本页真实匹配结果累计候选与阻断数量，分页时只接续连续游标。 */
            const pageCandidates = items.filter(item => {
              if (!item || typeof item !== 'object') return false
              const match = (item as { match?: { status?: unknown } }).match
              return match?.status === 'candidate'
            }).length
            const pageBlocked = items.filter(item => {
              if (!item || typeof item !== 'object') return false
              const value = item as { canImport?: unknown; match?: { status?: unknown } }
              return value.canImport === false || value.match?.status === 'blocked'
            }).length
            const previous = selected.job.workflowDiscovery
            const currentOffset = typeof params.offset === 'number' ? params.offset : 0
            const contiguous = previous?.nextOffset === currentOffset
            const job = await options.access.execute('recordWorkflowDiscovery', {
              sessionId: options.sessionId, productionId: selected.productionId, baseRevision: selected.job.baseRevision, jobId: selected.job.id,
              discovery: {
                status, connectionId, mediaKind,
                candidateCount: pageCandidates + (contiguous ? previous.candidateCount : 0),
                blockedCount: pageBlocked + (contiguous ? previous.blockedCount : 0),
                nextOffset,
                ...(typeof details?.snapshotId === 'string' ? { snapshotId: details.snapshotId } : {}), checkedAt,
                ...(typeof discovery.message === 'string' ? { message: discovery.message } : {}),
              },
            })
            selected.job.workflowDiscovery = job.workflowDiscovery
          } else if (details) {
            const workflowId = typeof details.id === 'string' ? details.id : undefined
            const workflowRevision = typeof details.revision === 'number' ? details.revision : undefined
            const contentHash = typeof details.contentHash === 'string' ? details.contentHash
              : typeof details.hash === 'string' ? details.hash : undefined
            if (workflowId && workflowRevision && contentHash) {
              const mediaKind = selected.job.mediaKind === 'image' || selected.job.mediaKind === 'video' || selected.job.mediaKind === 'audio'
                ? selected.job.mediaKind : selected.job.workflowDiscovery?.mediaKind ?? 'video'
              const job = await options.access.execute('recordWorkflowDiscovery', {
                sessionId: options.sessionId, productionId: selected.productionId, baseRevision: selected.job.baseRevision, jobId: selected.job.id,
                discovery: {
                  status: 'selected', connectionId: String(details.connectionId ?? selected.job.workflowDiscovery?.connectionId),
                  mediaKind, candidateCount: selected.job.workflowDiscovery?.candidateCount ?? 1,
                  blockedCount: selected.job.workflowDiscovery?.blockedCount ?? 0,
                  nextOffset: selected.job.workflowDiscovery?.nextOffset ?? null, checkedAt: Date.now(),
                  selectedWorkflow: { workflowId, workflowRevision, contentHash },
                },
              })
              selected.job.workflowDiscovery = job.workflowDiscovery
            }
          }
          return result
        }
        if (prepare) {
          const jobs = await activeJobs()
          const selected = visualJobId ? jobs.find(item => item.job.id === visualJobId) : jobs.length === 1 ? jobs[0] : undefined
          if ((visualJobId && !selected) || jobs.length > 1 && !selected) throw new Error(`${VISUAL_MEDIA_JOB_REQUIRED_MESSAGE} 多个活动任务时必须继续提供正确的 visualJobId。`)
          /** 没有镜头任务时不能开始生成，否则后续候选和审片都失去可信归属。 */
          if (!selected) throw new Error(VISUAL_MEDIA_JOB_REQUIRED_MESSAGE)
          const engine: 'model' | 'workflow' = tool.name === 'media_prepare_generation' ? 'model' : 'workflow'
          if (engine === 'workflow' && (params.profileId || !params.connectionId || !params.workflowId || !params.workflowRevision || !params.mediaKind)) throw new Error('VISUAL_MEDIA_WORKFLOW_REQUIRED: 请在作品允许的服务内发现并检查工作流，再提供 connectionId、workflowId、workflowRevision、mediaKind')
          /** 兼容 Agent 历史调用中的裸媒体引用，生成前统一为媒体工具认可的判别联合。 */
          params.inputs = normalizeMediaInputs(params.inputs)
          const source: VisualProductionMediaSource = engine === 'model' ? { type: 'model', modelRef: String(params.modelRef) } : { type: 'workflow', connectionId: String(params.connectionId), workflowId: String(params.workflowId), workflowRevision: Number(params.workflowRevision) }
          if (engine === 'workflow' && selected.job.mediaKind === 'video' && source.type === 'workflow') {
            const selectedWorkflow = selected.job.workflowDiscovery?.selectedWorkflow
            if (!selectedWorkflow || selected.job.workflowDiscovery?.connectionId !== source.connectionId || selectedWorkflow.workflowId !== source.workflowId
              || selectedWorkflow.workflowRevision !== source.workflowRevision) throw new Error('WORKFLOW_DISCOVERY_REQUIRED: 请先发现、检查并选定与预检参数一致的视频工作流')
          }
          const option = await currentOption(selected, source, typeof params.mediaKind === 'string' ? params.mediaKind : undefined)
          const entry = configuredEntry(selected.job, source, option.kind)
          const mergedInputs = mergeVisualMediaInputs(option, entry?.parameters ?? {}, (params.inputs ?? {}) as Record<string, MediaInputValue>)
          params.inputs = mergedInputs
          await assertVideoPlanInputs(selected, option, mergedInputs)
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
        return projectHostManagedMediaWait(result)
      },
    }
  })
}
