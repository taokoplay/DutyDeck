import { describe, expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import type { MediaInputValue, MediaSettingsSnapshot, UnifiedMediaModelOption } from '@dutydeck/shared'
import { buildVisualProductionMediaCatalog, mergeVisualMediaInputs, validateVisualMediaInputs, resolveVisualProductionMediaWorkflow } from './media-catalog'

/** 无服务器和工作流时仍可显示真实 API 模型。 */
const empty: MediaSettingsSnapshot = { schemaVersion: 2, revision: 1, connections: [], workflows: [], profiles: [] }
/** 适配器已接入但未声称完成在线探测的模型 fixture。 */
const model: UnifiedMediaModelOption = { ref: 'media:image:openai-images:profile:image', name: '图片模型', kind: 'image', provider: 'openai-images', profileId: 'profile', modelId: 'image', capabilities: ['text-to-image', 'image-to-image'], available: true, adapterId: 'openai-images' }
/** 合法的媒体输入引用；目录校验不会读取图片。 */
const reference: MediaInputValue = { kind: 'asset', asset: { assetId: 'image', revision: 1, hash: 'a'.repeat(64), mediaKind: 'image' } }

/** 包含一个真实文字绑定与图片输出的已保存模板。 */
function workflowSettings(): MediaSettingsSnapshot {
  return { ...empty, connections: [{ id: 'server', name: '本地 ComfyUI', driver: 'comfyui', baseUrl: 'http://localhost:8188', enabled: true, auth: { kind: 'none' }, revision: 1, instanceGeneration: 'one', updatedAt: 1, credentialConfigured: false }], workflows: [{ id: 'workflow', name: '图片工作流', projectId: null, revision: 1, hash: 'a'.repeat(64), createdAt: 1, definition: { schemaVersion: 1, prompt: { '1': { class_type: 'CLIPTextEncode', inputs: { text: '原始提示词' } }, '2': { class_type: 'SaveImage', inputs: { images: ['1', 0] } } }, bindings: [{ key: 'prompt', kind: 'text', nodeId: '1', input: 'text' }], outputs: [{ key: 'image', nodeId: '2', outputIndex: 0, mediaType: 'image' }] } }] }
}

describe('影像作品媒体能力目录', () => {
  test('Given 已配置和停用模型 When 构建目录 Then 保留真实状态且只声明已接入参数', () => {
    const options = buildVisualProductionMediaCatalog([model, { ...model, ref: 'disabled', available: false, unavailableReason: '模型已停用' }], empty, 'project')
    expect(options[0]?.constraints).toEqual({ maxImageReferences: 1, parameters: [{ key: 'size', label: '图片尺寸', type: 'string', defaultValue: '1024x1024' }] })
    expect(options[1]?.available).toBe(false)
    expect(options[1]?.unavailableReason).toBe('模型已停用')
    expect(buildVisualProductionMediaCatalog([], empty, 'project')).toEqual([])
  })
  test('Given 音频或视频适配器 When 构建目录 Then 只列实际消费的声音参数且不伪造视频时长', () => {
    const options = buildVisualProductionMediaCatalog([
      { ...model, ref: 'audio', kind: 'audio', adapterId: 'xiaomi-speech', capabilities: ['text-to-speech'] },
      { ...model, ref: 'video', kind: 'video', adapterId: 'minimax-video', capabilities: ['text-to-video'] },
    ], empty, 'project')
    expect(options[0]?.constraints.maxImageReferences).toBe(0)
    expect(options[0]?.constraints.parameters?.map((parameter) => parameter.key)).toEqual(['voice', 'format'])
    expect(mergeVisualMediaInputs(options[0]!, {}, {}).voice).toEqual({ kind: 'scalar', value: 'mimo_default' })
    expect(options[1]?.constraints.parameters).toEqual([])
    expect(() => validateVisualMediaInputs(options[1]!, { image: reference })).toThrow('VISUAL_MEDIA_REFERENCE_LIMIT_EXCEEDED')
  })
  test('Given 很多本地模板 When 构建目录 Then 只按连接生成三类路由且名称不拼模板', () => {
    const settings = workflowSettings()
    settings.workflows = Array.from({ length: 50 }, (_, index) => ({ ...settings.workflows[0]!, id: `workflow-${index}` }))
    const options = buildVisualProductionMediaCatalog([], settings, 'project')
    expect(options).toHaveLength(3)
    expect(options.map(option => option.kind).sort()).toEqual(['audio', 'image', 'video'])
    expect(options.every(option => option.name === '本地 ComfyUI' && option.source.type === 'connection')).toBe(true)
    expect(options.every(option => Object.keys(option.constraints).length === 0 && Object.keys(option.parameters).length === 0)).toBe(true)
    expect(JSON.stringify(options)).not.toContain('workflow-')
    expect(JSON.stringify(options)).not.toContain('localhost')
  })
  test('Given 停用、缺凭据或归档连接 When 构建目录 Then 显示真实配置状态且不宣称输出已验证', () => {
    const settings = workflowSettings()
    settings.connections[0]!.enabled = false
    expect(buildVisualProductionMediaCatalog([], settings, 'project').every(option => !option.available)).toBe(true)
    settings.connections[0]!.enabled = true
    settings.connections[0]!.auth = { kind: 'bearer' }
    expect(buildVisualProductionMediaCatalog([], settings, 'project').every(option => !option.available)).toBe(true)
    settings.connections[0]!.credentialConfigured = true
    expect(buildVisualProductionMediaCatalog([], settings, 'project').every(option => option.available)).toBe(true)
    settings.connections[0]!.archivedAt = 0
    expect(buildVisualProductionMediaCatalog([], settings, 'project')).toEqual([])
  })
  test('Given 仅有服务路由 When 合并生成参数 Then 要求先由Agent选定真实工作流', () => {
    const option = buildVisualProductionMediaCatalog([], workflowSettings(), 'project')[0]!
    expect(() => mergeVisualMediaInputs(option, {}, {})).toThrow('VISUAL_MEDIA_WORKFLOW_REQUIRED')
  })
  test('Given 作品默认参数 When 合并当次参数 Then 当次覆盖且无效参数不被忽略', () => {
    const option = buildVisualProductionMediaCatalog([model], empty, 'project')[0]!
    expect(mergeVisualMediaInputs(option, {}, {})).toEqual({ size: { kind: 'scalar', value: '1024x1024' } })
    expect(mergeVisualMediaInputs(option, { size: '512x512' }, { size: { kind: 'scalar', value: 'auto' } }).size).toEqual({ kind: 'scalar', value: 'auto' })
    expect(() => mergeVisualMediaInputs(option, { invented: true }, {})).toThrow('VISUAL_MEDIA_PARAMETER_INVALID')
    expect(() => mergeVisualMediaInputs(option, { size: 42 }, {})).toThrow('VISUAL_MEDIA_PARAMETER_INVALID')
  })
  test('Given 超量图片、错误媒体或停用模型 When 校验执行输入 Then 在生成前拒绝', () => {
    const option = buildVisualProductionMediaCatalog([model], empty, 'project')[0]!
    expect(() => validateVisualMediaInputs(option, { first: reference, second: reference })).toThrow('VISUAL_MEDIA_REFERENCE_LIMIT_EXCEEDED')
    expect(() => validateVisualMediaInputs(option, { audio: { kind: 'asset', asset: { ...reference.asset, mediaKind: 'audio' } } })).toThrow('VISUAL_MEDIA_REFERENCE_TYPE_UNSUPPORTED')
    expect(() => validateVisualMediaInputs({ ...option, available: false }, {})).toThrow('VISUAL_MEDIA_UNAVAILABLE')
  })
})

/** Agent 选中的精确来源，保留旧版本以验证不会静默升级。 */
const workflowSource = { type: 'workflow' as const, connectionId: 'server', workflowId: 'workflow', workflowRevision: 1 }

describe('影像Agent精确工作流解析', () => {
  test('Given 模板已有新版本 When 解析固定旧版本 Then 保留旧参数与旧稳定ID', () => {
    const settings = workflowSettings()
    const updated = structuredClone(settings.workflows[0]!)
    updated.revision = 2
    updated.definition.prompt['1']!.inputs.text = '新版提示词'
    settings.workflows.push(updated)
    const option = resolveVisualProductionMediaWorkflow(settings, 'project', workflowSource, 'image')
    expect(option.source).toEqual(workflowSource)
    expect(option.id).toBe(`media-${createHash('sha256').update(JSON.stringify(['server', 'workflow', 1, 'image'])).digest('hex').slice(0, 32)}`)
    expect(mergeVisualMediaInputs(option, {}, {}).prompt).toEqual({ kind: 'scalar', value: '原始提示词' })
    expect(() => resolveVisualProductionMediaWorkflow(settings, 'project', { ...workflowSource, workflowRevision: 3 }, 'image')).toThrow('VISUAL_MEDIA_WORKFLOW_UNAVAILABLE')
  })
  test('Given 当前项目模板 When 解析 Then 可用但其他项目或归档模板明确拒绝', () => {
    const settings = workflowSettings()
    settings.workflows[0]!.projectId = 'project'
    expect(resolveVisualProductionMediaWorkflow(settings, 'project', workflowSource, 'image').available).toBe(true)
    expect(() => resolveVisualProductionMediaWorkflow(settings, 'other', workflowSource, 'image')).toThrow('VISUAL_MEDIA_WORKFLOW_UNAVAILABLE')
    settings.archivedWorkflowIds = ['workflow']
    expect(() => resolveVisualProductionMediaWorkflow(settings, 'project', workflowSource, 'image')).toThrow('VISUAL_MEDIA_WORKFLOW_UNAVAILABLE')
  })
  test('Given 连接状态变化 When 解析 Then 停用或缺凭据不可用且归档明确拒绝', () => {
    const settings = workflowSettings()
    settings.connections[0]!.enabled = false
    expect(resolveVisualProductionMediaWorkflow(settings, 'project', workflowSource, 'image').available).toBe(false)
    settings.connections[0]!.enabled = true
    settings.connections[0]!.auth = { kind: 'bearer' }
    expect(resolveVisualProductionMediaWorkflow(settings, 'project', workflowSource, 'image').unavailableReason).toBe('连接凭据未配置')
    settings.connections[0]!.archivedAt = 0
    expect(() => resolveVisualProductionMediaWorkflow(settings, 'project', workflowSource, 'image')).toThrow('VISUAL_MEDIA_CONNECTION_UNAVAILABLE')
  })
  test('Given 真实输入绑定 When 解析 Then 暴露参数类型范围及图片槽数且接受尚未填充loader字段', () => {
    const settings = workflowSettings()
    const definition = settings.workflows[0]!.definition
    definition.prompt['3'] = { class_type: 'LoadImage', inputs: {} }
    definition.bindings.push({ key: 'reference', kind: 'image', nodeId: '3', input: 'image', loader: 'LoadImage' })
    definition.prompt['4'] = { class_type: 'NumberNode', inputs: { strength: 0.5 } }
    definition.bindings.push({ key: 'strength', kind: 'number', nodeId: '4', input: 'strength', field: { classType: 'NumberNode', valueKind: 'number', label: '强度', controlType: 'number', required: true, min: 0, max: 1 } })
    const option = resolveVisualProductionMediaWorkflow(settings, 'project', workflowSource, 'image')
    expect(option.constraints.maxImageReferences).toBe(1)
    expect(option.constraints.parameters?.find(field => field.key === 'strength')).toMatchObject({ type: 'number', defaultValue: 0.5, min: 0, max: 1 })
    expect(() => mergeVisualMediaInputs(option, { strength: 2 }, {})).toThrow('VISUAL_MEDIA_PARAMETER_INVALID')
    expect(() => resolveVisualProductionMediaWorkflow(settings, 'project', workflowSource, 'video')).toThrow('VISUAL_MEDIA_WORKFLOW_OUTPUT_MISMATCH')
    definition.outputs[0]!.nodeId = 'missing'
    expect(() => resolveVisualProductionMediaWorkflow(settings, 'project', workflowSource, 'image')).toThrow('VISUAL_MEDIA_WORKFLOW_INVALID')
  })
  test('Given 损坏或没有输出的模板 When 解析 Then 明确拒绝而非静默组合为可用能力', () => {
    const settings = workflowSettings()
    settings.workflows[0]!.definition.outputs = []
    expect(() => resolveVisualProductionMediaWorkflow(settings, 'project', workflowSource, 'image')).toThrow('VISUAL_MEDIA_WORKFLOW_OUTPUT_MISMATCH')
    settings.workflows[0]!.definition.bindings[0]!.nodeId = 'missing'
    expect(() => resolveVisualProductionMediaWorkflow(settings, 'project', workflowSource, 'image')).toThrow('VISUAL_MEDIA_WORKFLOW_INVALID')
  })
  test('Given 从远端发现并缓存的工作流 When 解析 Then 仅允许原服务实例和用户且不进入服务目录', () => {
    const settings = workflowSettings()
    settings.workflows[0]!.projectId = 'project'
    settings.workflows[0]!.remoteSource = { contentHash: 'a'.repeat(64), descriptor: { connectionId: 'server', instanceGeneration: 'one', remoteUser: '', source: 'user-data', id: 'workflows/film.json', workflowPath: 'workflows/film.json' } }
    expect(resolveVisualProductionMediaWorkflow(settings, 'project', workflowSource, 'image').available).toBe(true)
    expect(buildVisualProductionMediaCatalog([], settings, 'project')).toHaveLength(3)
    for (const field of ['connectionId', 'instanceGeneration', 'remoteUser'] as const) {
      const changed = structuredClone(settings)
      changed.workflows[0]!.remoteSource!.descriptor[field] = 'different'
      expect(() => resolveVisualProductionMediaWorkflow(changed, 'project', workflowSource, 'image')).toThrow('VISUAL_MEDIA_REMOTE_WORKFLOW_STALE')
    }
    settings.workflows[0]!.remoteSource!.descriptor.workflowPath = 'other.json'
    expect(() => resolveVisualProductionMediaWorkflow(settings, 'project', workflowSource, 'image')).toThrow('VISUAL_MEDIA_WORKFLOW_INVALID')
  })
})

test('Given 即梦图片执行器 When 显示制作参数 Then 支持十张参考且不覆盖全局分辨率', () => {
  const options = buildVisualProductionMediaCatalog([
    { ...model, modelId: '5.0Pro', adapterId: 'dreamina-image' },
    { ...model, modelId: '3.0', adapterId: 'dreamina-image', capabilities: ['text-to-image'] },
  ], empty, 'project')
  expect(options[0]?.constraints.maxImageReferences).toBe(10)
  expect(options[1]?.constraints.maxImageReferences).toBe(0)
  const fields = options[0]!.constraints.parameters!
  expect(fields.find(field => field.key === 'resolution_type')).toMatchObject({ options: ['1.5k', '2k', '4k'] })
  expect(fields.find(field => field.key === 'resolution_type')?.defaultValue).toBeUndefined()
  expect(fields.find(field => field.key === 'ratio')?.options).toHaveLength(8)
  expect(fields.find(field => field.key === 'count')).toMatchObject({ min: 1, max: 4 })
  expect(fields.map(field => field.key)).toEqual(['ratio', 'count', 'resolution_type', 'width', 'height'])
  expect(mergeVisualMediaInputs(options[0]!, {}, {}).resolution_type).toBeUndefined()
})
