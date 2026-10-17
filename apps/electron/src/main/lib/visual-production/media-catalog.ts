import { createHash } from 'node:crypto'
import { parseMediaWorkflowDefinition } from '@dutydeck/shared'
import type { MediaInputValue, MediaSettingsSnapshot, UnifiedMediaModelOption, VisualProductionMediaOption, VisualProductionMediaKind, VisualProductionMediaSource, VisualProductionMediaParameter, VisualProductionMediaParameterValue } from '@dutydeck/shared'

/** 根据实际已接入 HTTP adapter 描述可消费参数，不推断供应商尚未接入的能力。 */
export function describeVisualModelConstraints(model: UnifiedMediaModelOption): VisualProductionMediaOption['constraints'] {
  /** 只有已声明参考图能力的适配器允许一张参考。 */
  const maxImageReferences = model.capabilities.some((capability) => capability === 'image-to-image' || capability === 'image-to-video') && model.kind !== 'audio' ? model.adapterId === 'dreamina-image' ? 10 : 1 : 0
  /** 参数名称与 unified-media-http-adapters 中实际读取的标量一致。 */
  const parameters: VisualProductionMediaParameter[] = []
  if (model.adapterId === 'dreamina-image') {
    /** 不填默认分辨率，保留执行路由中用户已经保存的模型设置。 */
    const resolutions = model.modelId === '5.0Pro' ? ['1.5k', '2k', '4k'] : ['3.0', '3.1'].includes(model.modelId) ? ['1k', '2k'] : ['2k', '4k']
    parameters.push(
      { key: 'ratio', label: '画面比例', type: 'string', options: ['21:9', '16:9', '3:2', '4:3', '1:1', '3:4', '2:3', '9:16'] },
      { key: 'count', label: '生成张数', type: 'number', min: 1, max: 4 },
      { key: 'resolution_type', label: '分辨率', type: 'string', options: resolutions },
      { key: 'width', label: '自定义宽度', type: 'number', min: 1 },
      { key: 'height', label: '自定义高度', type: 'number', min: 1 },
    )
  }
  if (model.adapterId === 'openai-images') parameters.push({ key: 'size', label: '图片尺寸', type: 'string', defaultValue: '1024x1024' })
  if (model.adapterId === 'xiaomi-speech' || model.adapterId === 'minimax-speech') {
    parameters.push({ key: 'voice', label: '音色', type: 'string', defaultValue: model.adapterId === 'xiaomi-speech' ? 'mimo_default' : 'female-shaonv' })
    parameters.push({ key: 'format', label: '音频格式', type: 'string', defaultValue: 'mp3' })
  }
  return { maxImageReferences, parameters }
}

/** 将公开来源身份转成有界稳定 ID，不保存服务器地址或凭据。 */
function optionId(identity: string): string {
  return `media-${createHash('sha256').update(identity).digest('hex').slice(0, 32)}`
}

/** 本地配置读取范围；目录只消费连接，精确工作流解析才消费模板。 */
type VisualMediaSettings = Pick<MediaSettingsSnapshot, 'connections' | 'workflows' | 'archivedWorkflowIds'>

/** 合并 API 模型与服务路由；三类路由是作品许可范围，不代表服务器已验证支持这些输出。 */
export function buildVisualProductionMediaCatalog(models: UnifiedMediaModelOption[], settings: VisualMediaSettings, _projectId: string): VisualProductionMediaOption[] {
  /** 模型目录的 available 已检查适配器、启用状态与凭据存在性。 */
  const options: VisualProductionMediaOption[] = models.map((model) => ({
    id: optionId(model.ref), name: model.name.slice(0, 200), kind: model.kind, source: { type: 'model', modelRef: model.ref }, parameters: {},
    available: model.available, ...(model.unavailableReason ? { unavailableReason: model.unavailableReason } : {}), constraints: describeVisualModelConstraints(model),
  }))
  for (const connection of settings.connections) {
    if (connection.archivedAt !== undefined) continue
    /** 仅表达配置是否齐全；此处不读取工作流、资源缓存或远端状态。 */
    const available = connection.enabled && (connection.auth.kind === 'none' || connection.credentialConfigured)
    for (const kind of ['image', 'video', 'audio'] as const) {
      options.push({ id: optionId(JSON.stringify(['connection', connection.id, kind])), name: connection.name.slice(0, 200), kind,
        source: { type: 'connection', connectionId: connection.id }, parameters: {}, constraints: {}, available,
        ...(available ? {} : { unavailableReason: !connection.enabled ? '连接已停用' : '连接凭据未配置' }),
      })
    }
  }
  return options
}

/**
 * 按 Agent 选中的精确工作流版本解析真实输入约束，不将模板复制到其他服务。
 * @param settings 公开本地媒体配置，不含凭据值。
 * @param projectId 当前授权项目。
 * @param source 已选服务器及不可变工作流身份。
 * @param kind 本次要求的输出类别。
 * @returns 经过本地身份与定义校验的方案；远端节点和模型仍由现有 prepare/compiler 复核。
 */
export function resolveVisualProductionMediaWorkflow(settings: VisualMediaSettings, projectId: string,
  source: Extract<VisualProductionMediaSource, { type: 'workflow' }>, kind: VisualProductionMediaKind): VisualProductionMediaOption {
  /** 精确解析连接，不以目录顺序猜测替代服务器。 */
  const connection = settings.connections.find(item => item.id === source.connectionId)
  if (!connection || connection.archivedAt !== undefined) throw new Error('VISUAL_MEDIA_CONNECTION_UNAVAILABLE')
  /** 历史版本仍可用于原作品；只禁止已归档或越项目的模板。 */
  const workflow = settings.workflows.find(item => item.id === source.workflowId && item.revision === source.workflowRevision)
  if (!workflow || settings.archivedWorkflowIds?.includes(workflow.id)
    || (workflow.projectId !== null && workflow.projectId !== projectId)) throw new Error('VISUAL_MEDIA_WORKFLOW_UNAVAILABLE')
  if (workflow.remoteSource) {
    /** 与资源服务 assertDescriptor 一致，防止跨连接、换实例或换远端用户后复用旧快照。 */
    const descriptor = workflow.remoteSource.descriptor
    if (descriptor.connectionId !== connection.id || descriptor.instanceGeneration !== connection.instanceGeneration
      || descriptor.remoteUser !== (connection.comfyUser ?? '')) throw new Error('VISUAL_MEDIA_REMOTE_WORKFLOW_STALE')
    if (descriptor.source !== 'user-data' || !descriptor.workflowPath || descriptor.id !== descriptor.workflowPath) throw new Error('VISUAL_MEDIA_WORKFLOW_INVALID')
  }
  /** 复用严格定义解析；不把缺失节点或声明外的输出当成可执行能力。 */
  let definition: typeof workflow.definition
  try { definition = parseMediaWorkflowDefinition(workflow.definition) } catch { throw new Error('VISUAL_MEDIA_WORKFLOW_INVALID') }
  if (definition.outputs.some(output => !definition.prompt[output.nodeId])
    || definition.bindings.some(binding => !definition.prompt[binding.nodeId])) throw new Error('VISUAL_MEDIA_WORKFLOW_INVALID')
  if (!definition.outputs.some(output => output.mediaType === kind)) throw new Error('VISUAL_MEDIA_WORKFLOW_OUTPUT_MISMATCH')
  /** 非媒体绑定的默认值只取保存图中的真实标量；媒体槽位由 Agent 按角色填写。 */
  const parameters: VisualProductionMediaParameter[] = definition.bindings.flatMap(binding => {
    if (binding.kind !== 'text' && binding.kind !== 'number' && binding.kind !== 'boolean') return []
    const type = binding.kind === 'text' ? 'string' : binding.kind
    const value = definition.prompt[binding.nodeId]?.inputs[binding.input]
    return [{ key: binding.key, label: binding.field?.label ?? binding.key, type,
      ...(typeof value === type ? { defaultValue: value as VisualProductionMediaParameterValue } : {}),
      ...(binding.field?.min !== undefined ? { min: binding.field.min } : {}), ...(binding.field?.max !== undefined ? { max: binding.field.max } : {}),
    }]
  })
  /** available 是本地配置事实；真实服务兼容性在 prepare 阶段校验。 */
  const available = connection.enabled && (connection.auth.kind === 'none' || connection.credentialConfigured)
  return {
    id: optionId(JSON.stringify([connection.id, workflow.id, workflow.revision, kind])), name: `${connection.name} · ${workflow.name}`.slice(0, 200), kind,
    source: { ...source }, parameters: {}, available,
    ...(available ? {} : { unavailableReason: !connection.enabled ? '连接已停用' : '连接凭据未配置' }),
    constraints: { maxImageReferences: definition.bindings.filter(binding => binding.kind === 'image').length, parameters },
  }
}

/** 校验公开方案的参数类型、枚举和边界；未知参数不允许静默丢弃。 */
function validateParameter(parameter: VisualProductionMediaParameter | undefined, value: VisualProductionMediaParameterValue): void {
  if (!parameter || typeof value !== parameter.type || (typeof value === 'number' && (!Number.isFinite(value) || (parameter.min !== undefined && value < parameter.min) || (parameter.max !== undefined && value > parameter.max))) || (typeof value === 'string' && value.length > 16_384) || (parameter.options && !parameter.options.includes(value))) throw new Error('VISUAL_MEDIA_PARAMETER_INVALID')
}

/** 在准备媒体执行前校验启用状态、参数及适配器当前参考图上限。 */
export function validateVisualMediaInputs(option: VisualProductionMediaOption, inputs: Record<string, MediaInputValue>): void {
  if (option.source.type === 'connection') throw new Error('VISUAL_MEDIA_WORKFLOW_REQUIRED')
  if (!option.available) throw new Error('VISUAL_MEDIA_UNAVAILABLE')
  /** 工作流的精确槽位与必填项由现有 Comfy 编译器继续校验。 */
  const assets = Object.values(inputs).filter((value) => value.kind === 'asset')
  const imageCount = assets.filter((value) => value.kind === 'asset' && value.asset.mediaKind === 'image').length
  if (option.constraints.maxImageReferences !== undefined && imageCount > option.constraints.maxImageReferences) throw new Error('VISUAL_MEDIA_REFERENCE_LIMIT_EXCEEDED')
  if (option.source.type === 'model' && assets.some((value) => value.kind === 'asset' && (option.kind === 'audio' || value.asset.mediaKind !== 'image'))) throw new Error('VISUAL_MEDIA_REFERENCE_TYPE_UNSUPPORTED')
  for (const [key, input] of Object.entries(inputs)) {
    if (['__proto__', 'constructor', 'prototype'].includes(key)) throw new Error('VISUAL_MEDIA_PARAMETER_INVALID')
    if (input.kind === 'asset' && option.constraints.parameters?.some((parameter) => parameter.key === key)) throw new Error('VISUAL_MEDIA_PARAMETER_INVALID')
    if (input.kind === 'scalar') validateParameter(option.constraints.parameters?.find((parameter) => parameter.key === key), input.value)
  }
}

/** 将适配器初始值、作品参数、当次输入依序合并，返回通过校验的新输入对象。 */
export function mergeVisualMediaInputs(option: VisualProductionMediaOption, parameters: Record<string, VisualProductionMediaParameterValue>, inputs: Record<string, MediaInputValue>): Record<string, MediaInputValue> {
  if (option.source.type === 'connection') throw new Error('VISUAL_MEDIA_WORKFLOW_REQUIRED')
  /** 不修改调用方对象，保证已冻结请求不受后续编辑影响。 */
  const merged: Record<string, MediaInputValue> = Object.create(null) as Record<string, MediaInputValue>
  for (const parameter of option.constraints.parameters ?? []) if (parameter.defaultValue !== undefined) merged[parameter.key] = { kind: 'scalar', value: parameter.defaultValue }
  for (const [key, value] of Object.entries(parameters)) {
    validateParameter(option.constraints.parameters?.find((parameter) => parameter.key === key), value)
    merged[key] = { kind: 'scalar', value }
  }
  Object.assign(merged, inputs)
  validateVisualMediaInputs(option, merged)
  return merged
}
