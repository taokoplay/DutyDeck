import { describe, expect, it } from 'bun:test'
import { parseVisualProductionCommand, parseVisualProductionDraft, parseVisualProductionRelativePath, parseVisualProductionMediaExecution, VISUAL_PRODUCTION_READ_METHODS } from './visual-production-validation'
import type { VisualProductionDraft } from './visual-production'

/** 最小真实作品，供边界测试独立修改。 */
const draft = (): VisualProductionDraft => ({ title: '第一支影片', kind: 'film', brief: '', ratio: '16:9', fps: 24, voice: '', music: '', episodes: [{ id: 'ep1', title: '第一集' }], assets: [{ id: 'a1', name: '主角', type: '角色', description: '', locked: false, mediaId: null }], shots: [{ id: 's1', episodeId: 'ep1', title: '开场', duration: 5, scene: '', motion: '', dialogue: '', assetIds: ['a1'], mediaId: null }] })

it('Given 自动采用与多图请求 When 解析 Then 写权限独立且拒绝重复、越界与伪造系统字段', () => {
  /** 自动采用只接收作品身份，调用者不能指定跳过检查的候选或输出数量。 */
  const target = { sessionId: 'session', productionId: 'production' }
  expect(parseVisualProductionCommand({ method: 'autoAdoptShots', input: target }).method).toBe('autoAdoptShots')
  expect(VISUAL_PRODUCTION_READ_METHODS).not.toContain('autoAdoptShots')
  expect(() => parseVisualProductionCommand({ method: 'autoAdoptShots', input: { ...target, candidateId: 'candidate' } })).toThrow()
  /** 单批最多十六张，各身份必须互异且仍不能指定 adopted 状态。 */
  const input = { ...target, baseRevision: 1, jobId: 'job', shotId: 'shot', mediaId: 'primary', summary: '多图' }
  for (const alternativeMediaIds of [['primary'], ['second', 'second'], Array.from({ length: 16 }, (_, index) => `media${index}`)]) expect(() => parseVisualProductionCommand({ method: 'proposeShot', input: { ...input, alternativeMediaIds } })).toThrow()
  expect(() => parseVisualProductionCommand({ method: 'proposeShot', input: { ...input, status: 'adopted' } })).toThrow()
})

it('Given 新旧媒体执行回执 When 解析真实输出数 Then 兼容缺省并拒绝无效数量', () => {
  /** 回执数量来自宿主，旧记录没有此字段时仍可正常读取。 */
  const receipt = { runId: 'run', engine: 'model', name: '模型', kind: 'image', source: { type: 'model', modelRef: 'image' }, parameters: {}, referenceAssets: [], phase: 'succeeded', createdAt: 1 }
  expect(parseVisualProductionMediaExecution(receipt).outputCount).toBeUndefined()
  expect(parseVisualProductionMediaExecution({ ...receipt, outputCount: 2 }).outputCount).toBe(2)
  for (const outputCount of [-1, 1.5, 501, '2']) expect(() => parseVisualProductionMediaExecution({ ...receipt, outputCount })).toThrow()
})

describe('影像创作请求合同', () => {
  it('Given 合法作品 When 解析保存请求 Then 保留关联且生成独立对象', () => {
    const input = draft()
    const result = parseVisualProductionCommand({ method: 'save', input: { sessionId: 'session1', productionId: 'p1', baseRevision: 1, draft: input } })
    expect(result.method).toBe('save')
    if (result.method !== 'save') throw new Error('错误命令')
    expect(result.input.draft).toEqual(input)
    expect(result.input.draft.shots).not.toBe(input.shots)
  })
  it('Given 断开的资产或集数引用 When 保存 Then 拒绝而不是静默丢失', () => {
    const input = draft()
    input.shots[0]!.assetIds = ['missing']
    expect(() => parseVisualProductionDraft(input)).toThrow()
    input.shots[0]!.assetIds = ['a1']
    input.shots[0]!.episodeId = 'missing'
    expect(() => parseVisualProductionDraft(input)).toThrow()
  })
  it('Given 未知字段、重复身份、原型属性身份或非法时长 Then 拒绝', () => {
    expect(() => parseVisualProductionDraft({ ...draft(), root: '/tmp' })).toThrow()
    const input = draft()
    input.assets.push({ ...input.assets[0]! })
    expect(() => parseVisualProductionDraft(input)).toThrow()
    expect(() => parseVisualProductionCommand({ method: 'load', input: { sessionId: 's', productionId: '__proto__' } })).toThrow()
    for (const duration of [0, -1, NaN, Infinity, 601]) {
      const value = draft()
      value.shots[0]!.duration = duration
      expect(() => parseVisualProductionDraft(value)).toThrow()
    }
  })
  it('Given 图片作品 When 时长为零 Then 允许静态作品', () => {
    const input = draft()
    input.kind = 'image'
    input.shots[0]!.duration = 0
    expect(parseVisualProductionDraft(input).shots[0]!.duration).toBe(0)
  })
  it('Given 来源路径穿越/绝对路径或未知方法 Then 拒绝', () => {
    for (const path of ['/tmp/a.png', '../a.png', 'x/../a.png', 'x/./a.png', 'C:\\a.png', 'https://example.com/a', 'a\0.png', '.proma/secret']) expect(() => parseVisualProductionRelativePath(path)).toThrow()
    expect(parseVisualProductionRelativePath('assets/主角.png')).toBe('assets/主角.png')
    expect(() => parseVisualProductionCommand({ method: 'removeRoot', input: { sessionId: 's' } })).toThrow()
    expect(() => parseVisualProductionCommand({ method: 'list', input: { sessionId: 's', projectRoot: '/tmp' } })).toThrow()
  })
  it('Given 候选/媒体导入 When 缺任务身份或媒体身份不匹配 Then 拒绝', () => {
    expect(() => parseVisualProductionCommand({ method: 'propose', input: { sessionId: 's', productionId: 'p', baseRevision: 1, draft: draft(), summary: '候选' } })).toThrow()
    expect(() => parseVisualProductionCommand({ method: 'importMedia', input: { sessionId: 's', productionId: 'p', reference: { assetId: 'm', revision: 1, hash: 'bad', mediaKind: 'image' } } })).toThrow()
  })
  it('Given 超预算正文 When 保存 Then 拒绝无界复制', () => {
    expect(() => parseVisualProductionDraft({ ...draft(), brief: '长'.repeat(16001) })).toThrow()
  })
})

it('Given 制作闭环命令 When 解析 Then 校验固定版本、任务和阶段且拒绝额外字段', () => {
  const base = { sessionId: 'session', productionId: 'production', baseRevision: 1, jobId: 'job' }
  for (const stage of ['preparing', 'generating', 'reviewing']) expect(parseVisualProductionCommand({ method: 'updateJob', input: { ...base, stage } }).method).toBe('updateJob')
  expect(() => parseVisualProductionCommand({ method: 'updateJob', input: { ...base, stage: 'completed' } })).toThrow()
  for (const method of ['referenceMedia', 'proposeShot'] as const) {
    const input = { ...base, mediaId: 'media', ...(method === 'proposeShot' ? { shotId: 'shot', summary: '只替换输出' } : {}) }
    expect(parseVisualProductionCommand({ method, input }).method).toBe(method)
    expect(() => parseVisualProductionCommand({ method, input: { ...input, baseRevision: 0 } })).toThrow()
    expect(() => parseVisualProductionCommand({ method, input: { ...input, jobId: '' } })).toThrow()
    expect(() => parseVisualProductionCommand({ method, input: { ...input, path: '/tmp/media' } })).toThrow()
  }
})

it('Given 合法外部媒体身份与 128 个参数 When 保存制作配置 Then 接受点号工作流和点号冒号参数但不放宽影像身份', () => {
  const entries = [{ id: 'entry', name: '工作流', kind: 'image', source: { type: 'workflow' as const, connectionId: 'comfy.local', workflowId: 'workflow.v2', workflowRevision: 2 }, parameters: Object.fromEntries(Array.from({ length: 128 }, (_, index) => [`node.${index}:seed`, index])) }]
  const input = { sessionId: 'session', productionId: 'production', expectedRevision: 0, entries, defaults: { image: 'entry' } }
  const parsed = parseVisualProductionCommand({ method: 'saveMediaConfiguration', input })
  expect(parsed.method).toBe('saveMediaConfiguration')
  if (parsed.method !== 'saveMediaConfiguration') throw new Error('错误命令')
  expect(parsed.input.entries[0]?.source).toEqual(entries[0]!.source)
  expect(Object.keys(parsed.input.entries[0]!.parameters)).toHaveLength(128)
  expect(() => parseVisualProductionCommand({ method: 'saveMediaConfiguration', input: { ...input, productionId: 'production.with.dot' } })).toThrow()
  expect(() => parseVisualProductionCommand({ method: 'saveMediaConfiguration', input: { ...input, entries: [{ ...entries[0], parameters: { constructor: 'bad' } }] } })).toThrow()
})

it('Given 媒体资产使用合法命名空间身份 When 导入引用 Then 保留外部身份且仍拒绝路径', () => {
  const reference = { assetId: 'asset.provider:output-1', revision: 1, hash: 'a'.repeat(64), mediaKind: 'image' }
  const input = { sessionId: 'session', productionId: 'production', reference }
  const result = parseVisualProductionCommand({ method: 'importMedia', input })
  expect(result.method).toBe('importMedia')
  if (result.method !== 'importMedia') throw new Error('错误命令')
  expect(result.input.reference.assetId).toBe(reference.assetId)
  expect(() => parseVisualProductionCommand({ method: 'importMedia', input: { ...input, reference: { ...reference, assetId: '../output' } } })).toThrow()
})

it('Given 服务授权与精确工作流 When 校验授权 Then 单向允许同服务工作流且回执不能只写服务', async () => {
  const { visualProductionMediaSourceAllows } = await import('./visual-production-media')
  const { parseVisualProductionMediaExecution } = await import('./visual-production-validation')
  const connection = { type: 'connection' as const, connectionId: 'comfy' }
  const workflow = { type: 'workflow' as const, connectionId: 'comfy', workflowId: 'flow', workflowRevision: 1 }
  expect(visualProductionMediaSourceAllows(connection, workflow)).toBe(true)
  expect(visualProductionMediaSourceAllows(workflow, connection)).toBe(false)
  expect(visualProductionMediaSourceAllows(workflow, { ...workflow, workflowRevision: 2 })).toBe(false)
  expect(visualProductionMediaSourceAllows(connection, { ...workflow, connectionId: 'other' })).toBe(false)
  expect(() => parseVisualProductionMediaExecution({ runId: 'run', engine: 'workflow', name: '错误服务回执', kind: 'image', source: connection, parameters: {}, referenceAssets: [], phase: 'prepared', createdAt: 1 })).toThrow()
  expect(() => parseVisualProductionCommand({ method: 'resolveMediaWorkflow', input: { sessionId: 'session', productionId: 'production', source: connection, kind: 'image' } })).toThrow()
})
