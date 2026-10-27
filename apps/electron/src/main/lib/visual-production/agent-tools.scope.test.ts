import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { VisualCandidate, VisualJob } from '@dutydeck/shared'
import type { ToolDefinition } from '@earendil-works/pi-coding-agent'
import { Value } from 'typebox/value'
import { convertResponsesTools } from '@earendil-works/pi-ai/api/openai-responses-shared'
import { buildVisualProductionAgentTools } from './agent-tools'
import { VisualProductionService } from './store'

/** 本文件只使用隔离项目，不读取或修改真实作品。 */
const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })

/** 无入参；创建真实存储和 Agent 工具，返回用于验证任务范围与持久化的夹具。 */
async function fixture() {
  /** 中文和空格路径验证任务范围解析不依赖项目目录名称。 */
  const projectRoot = mkdtempSync(join(tmpdir(), '影像 scope '))
  roots.push(projectRoot)
  /** 通过生产服务执行全部工具请求，避免只验证 mock。 */
  const service = new VisualProductionService({ workspaceId: 'workspace', projectRoot })
  const target = { sessionId: 'session', productionId: (await service.invoke('create', { sessionId: 'session', title: '测试作品', kind: 'film' })).document.id }
  const tools = buildVisualProductionAgentTools({
    sessionId: target.sessionId,
    sdk: { defineTool: (definition: unknown) => definition } as Parameters<typeof buildVisualProductionAgentTools>[0]['sdk'],
    assertAccess() {},
    execute: (method, input, signal) => service.invoke(method, input, signal),
  })
  /** 入参为工具名和模型 JSON 参数；返回实际工具执行回执。 */
  const call = (name: string, input: Record<string, unknown>) => tools.find(tool => tool.name === name)!.execute('call', input, undefined, undefined, {} as never)
  return { service, target, call, tools: tools as ToolDefinition[] }
}

describe('Given 整集文本制作且没有正式镜头', () => {
  test.each([undefined, null])('When shotId 为 %s Then 可以创建任务并采用正式文本候选', async shotId => {
    const { service, target, call } = await fixture()
    /** null 是模型显式表达整作品范围的值，省略字段保持原有兼容性。 */
    const result = await call('visual_production_begin_job', { productionId: target.productionId, baseRevision: 1, instruction: '完善作品简介', ...(shotId === undefined ? {} : { shotId }) })
    const job = result.details as VisualJob
    expect(job.shotId).toBeUndefined()
    expect((await service.invoke('load', target)).jobs[0]?.shotId).toBeUndefined()
    /** 只投影可编辑字段，通过真实候选与采用链路验证写入。 */
    const { title, kind, ratio, fps, voice, music, episodes, assets, shots } = (await service.invoke('load', target)).document
    const proposed = await call('visual_production_propose', { productionId: target.productionId, baseRevision: 1, jobId: job.id, draft: { title, kind, brief: '雨夜中的规则怪谈。', ratio, fps, voice, music, episodes, assets, shots }, summary: '完善简介' })
    const candidate = proposed.details as VisualCandidate
    await call('visual_production_adopt_candidate', { productionId: target.productionId, baseRevision: 1, candidateId: candidate.id })
    expect((await service.invoke('load', target)).document.brief).toBe('雨夜中的规则怪谈。')
  })

  test('When 填写空、非法或不存在的镜头 Then 不扩大范围且提示整集任务的正确写法', async () => {
    const { service, target, call } = await fixture()
    for (const shotId of ['', '/', ' ', '整集', 'none', '../shot', 'shot-01', 'all', (await service.invoke('load', target)).document.episodes[0]!.id]) {
      await expect(call('visual_production_begin_job', { productionId: target.productionId, baseRevision: 1, instruction: '完善剧本', shotId })).rejects.toThrow(/shotId.*null/)
    }
    expect((await service.invoke('load', target)).jobs).toEqual([])
  })

  test('When 显式传入文本范围 Then 可以新增首个镜头并采用且不登记媒体发现', async () => {
    const { service, target, call } = await fixture()
    /** 两个 null 分别表达整作品范围与无媒体类别，兼容需要完整字段的模型。 */
    const result = await call('visual_production_begin_job', { productionId: target.productionId, baseRevision: 1, instruction: '创建第一集文本分镜', shotId: null, mediaKind: null })
    const job = result.details as VisualJob
    expect(job.shotId).toBeUndefined()
    expect(job.mediaKind).toBeUndefined()
    expect(job.workflowDiscovery).toBeUndefined()
    /** 沿真实候选/采用流程新增首个镜头，不直接写入作品文件。 */
    const { title, kind, brief, ratio, fps, voice, music, episodes, assets } = (await service.invoke('load', target)).document
    const proposed = await call('visual_production_propose', { productionId: target.productionId, baseRevision: 1, jobId: job.id, draft: { title, kind, brief, ratio, fps, voice, music, episodes, assets, shots: [{ id: 'shot-01', episodeId: episodes[0]!.id, title: '开场', duration: 3, scene: '雨夜石巷', motion: '灯下影子消失', dialogue: '', assetIds: [], mediaId: null }] }, summary: '新增开场分镜' })
    await call('visual_production_adopt_candidate', { productionId: target.productionId, baseRevision: 1, candidateId: (proposed.details as VisualCandidate).id })
    expect((await service.invoke('load', target)).document.shots.map(shot => shot.id)).toEqual(['shot-01'])
  })

  test('When Responses 序列化工具 Then 保留可选范围并拒绝日志中的非法 ID', async () => {
    const { tools, target } = await fixture()
    /** 真实 Pi 转换器用于验证传给 Responses 的 schema，无网络请求。 */
    /** Responses 转换器允许文件搜索联合工具，测试只读取函数工具的公共序列化字段。 */
    const converted = convertResponsesTools(tools) as unknown as Array<{ name: string; type: string; strict?: boolean; parameters: unknown }>
    const begin = converted.find(tool => tool.name === 'visual_production_begin_job')!
    expect(begin.type).toBe('function')
    if (begin.type !== 'function') throw new Error('应为函数工具')
    expect(begin.strict).toBe(false)
    const responsesParameters = begin.parameters as { required?: string[] }
    expect(responsesParameters.required ?? []).not.toContain('shotId')
    /** TypeBox 校验原始注册 schema，防止 provider 与宿主间再次出现格式错位。 */
    const parameters = tools.find(tool => tool.name === 'visual_production_begin_job')!.parameters
    const input = { productionId: target.productionId, baseRevision: 1, instruction: '整集文本' }
    for (const shotId of ['/', ' ', '../shot', '镜头一', 'a.b', 'a:b', 'constructor', 'prototype']) expect(Value.Check(parameters, { ...input, shotId })).toBe(false)
    for (const shotId of [undefined, null, 'shot-01', 'A_2']) expect(Value.Check(parameters, { ...input, ...(shotId === undefined ? {} : { shotId }) })).toBe(true)
  })

  test('When 内部 ID 收紧 Then 外部连接和媒体资产继续遵守各自身份合同', async () => {
    const { tools, target } = await fixture()
    /** 连接允许点号，媒体资产允许冒号和最长 256 字符，不能误套内部路径段格式。 */
    const discovery = tools.find(tool => tool.name === 'visual_production_record_workflow_discovery')!.parameters
    const input = { productionId: target.productionId, baseRevision: 1, jobId: 'job', status: 'blocked', connectionId: 'comfy.local', mediaKind: 'image', candidateCount: 0, blockedCount: 0, nextOffset: null, message: '离线' }
    expect(Value.Check(discovery, input)).toBe(true)
    expect(Value.Check(discovery, { ...input, connectionId: 'comfy:local' })).toBe(false)
    /** 媒体服务返回的完整资产身份具有独立长度预算。 */
    const importer = tools.find(tool => tool.name === 'visual_production_import_media')!.parameters
    const reference = { assetId: 'provider:asset.' + 'a'.repeat(241), revision: 1, hash: 'a'.repeat(64), mediaKind: 'image' }
    expect(reference.assetId.length).toBe(256)
    expect(Value.Check(importer, { productionId: target.productionId, reference })).toBe(true)
    expect(Value.Check(importer, { productionId: target.productionId, reference: { ...reference, assetId: reference.assetId + 'a' } })).toBe(false)
  })
})
