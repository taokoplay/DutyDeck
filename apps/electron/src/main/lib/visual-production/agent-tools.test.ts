import { describe, expect, test } from 'bun:test'
import { buildVisualProductionAgentTools, VISUAL_PRODUCTION_AGENT_TOOL_NAMES } from './agent-tools'
import type { VisualProductionResults } from '@proma/shared'
import { parseVisualProductionDraft } from '@proma/shared'

describe('Given 主 Agent 影像工具', () => {
  test('When 注册工具 Then 不提供正式保存采纳且写操作检查权限', async () => {
    const writes: boolean[] = []
    const tools = buildVisualProductionAgentTools({ sessionId: 'session', sdk: { defineTool: (definition: unknown) => definition } as Parameters<typeof buildVisualProductionAgentTools>[0]['sdk'], assertAccess: write => { writes.push(write) }, async execute<M extends keyof VisualProductionResults>(): Promise<VisualProductionResults[M]> { return largeSnapshot() as unknown as VisualProductionResults[M] } })
    expect(tools.map(tool => tool.name).sort()).toEqual([...VISUAL_PRODUCTION_AGENT_TOOL_NAMES].sort())
    expect(tools.some(tool => /adopt|save/.test(tool.name))).toBe(false)
    const create = tools.find(tool => tool.name === 'visual_production_create')!
    await create.execute('call', { title: '作品', kind: 'film' }, new AbortController().signal, undefined, {} as never)
    expect(writes).toEqual([true])
    await expect(create.execute('call', { title: '作品', kind: 'film', sessionId: 'other' }, new AbortController().signal, undefined, {} as never)).rejects.toThrow('INVALID_INPUT')
  })
})

/** 构造大型正式内容与候选，证明工具不会重复输出整个历史草稿。 */
function largeSnapshot(): import('@proma/shared').VisualProductionSnapshot {
  const document = { schemaVersion: 1 as const, id: 'production', revision: 1, createdAt: 1, updatedAt: 1, title: '作品', kind: 'film' as const, brief: '', ratio: '16:9', fps: 24, voice: '', music: '', episodes: [{ id: 'episode', title: '第一集' }], assets: [], shots: Array.from({ length: 12 }, (_, index) => ({ id: `shot${index}`, episodeId: 'episode', title: '镜头', duration: 5, scene: '画'.repeat(7000), motion: '', dialogue: '', assetIds: [], mediaId: null })) }
  return { document, media: [], assetVersions: {}, shotStates: {}, jobs: [], candidates: [{ id: 'candidate', baseRevision: 1, jobId: 'job', createdAt: 1, status: 'ready', summary: '候选', draft: document }] }
}

test('Given 大型作品与候选 When Agent默认读取 Then 仅返回有界概览不重复候选正文', async () => {
  const snapshot = largeSnapshot()
  const tools = buildVisualProductionAgentTools({ sessionId: 'session', sdk: { defineTool: (definition: unknown) => definition } as Parameters<typeof buildVisualProductionAgentTools>[0]['sdk'], assertAccess() {}, execute: (async () => snapshot) as Parameters<typeof buildVisualProductionAgentTools>[0]['execute'] })
  const result = await tools.find(tool => tool.name === 'visual_production_read')!.execute('call', { productionId: 'production' }, undefined, undefined, {} as never)
  const text = result.content.find(item => item.type === 'text')!
  expect(text.type === 'text' && text.text.length).toBeLessThanOrEqual(49152)
  expect(JSON.stringify(result.details)).not.toContain('画'.repeat(100))
})

test('Given 大型镜头集合 When Agent分页读取 Then 返回真实条目与下一页并遵守预算', async () => {
  const snapshot = largeSnapshot()
  const tools = buildVisualProductionAgentTools({ sessionId: 'session', sdk: { defineTool: (definition: unknown) => definition } as Parameters<typeof buildVisualProductionAgentTools>[0]['sdk'], assertAccess() {}, execute: (async () => snapshot) as Parameters<typeof buildVisualProductionAgentTools>[0]['execute'] })
  const result = await tools.find(tool => tool.name === 'visual_production_read')!.execute('call', { productionId: 'production', section: 'shots', offset: 0, limit: 12 }, undefined, undefined, {} as never)
  const details = result.details as { items: unknown[]; nextOffset: number }
  expect(details.items.length).toBeGreaterThan(0)
  expect(details.nextOffset).toBe(details.items.length)
  expect(JSON.stringify(result.details).length).toBeLessThanOrEqual(49152)
})

test('Given 多镜头作品 When 精确读取镜头 Then 只返回目标和已绑定资产并保留正式版本', async () => {
  /** 有意在其他镜头写入特征文本，检查该文本不会进入工具响应。 */
  const snapshot = largeSnapshot()
  snapshot.document.shots[0]!.scene = '无关镜头正文'
  snapshot.document.shots[2]!.assetIds = ['actor']
  snapshot.document.assets = [{ id: 'actor', name: '角色', type: '角色', locked: true, description: '固定外观', mediaId: null }, { id: 'other', name: '其他资产', type: '道具', locked: false, description: '不要读取', mediaId: null }]
  snapshot.assetVersions.actor = 2
  const calls: unknown[] = []
  const tools = buildVisualProductionAgentTools({ sessionId: 'session', sdk: { defineTool: (definition: unknown) => definition } as Parameters<typeof buildVisualProductionAgentTools>[0]['sdk'], assertAccess() {}, execute: (async (method, input) => { calls.push({ method, input }); return snapshot }) as Parameters<typeof buildVisualProductionAgentTools>[0]['execute'] })
  const tool = tools.find(item => item.name === 'visual_production_read_shot')
  expect(tool).toBeDefined()
  const result = await tool!.execute('call', { productionId: 'production', shotId: 'shot2' }, undefined, undefined, {} as never)
  expect(calls).toEqual([{ method: 'load', input: { sessionId: 'session', productionId: 'production' } }])
  expect(result.details).toMatchObject({ productionId: 'production', revision: 1, shot: { id: 'shot2' }, assets: [{ id: 'actor', version: 2, locked: true }] })
  expect(JSON.stringify(result.details)).not.toContain('无关镜头正文')
  expect(JSON.stringify(result.details)).not.toContain('不要读取')
  await expect(tool!.execute('call', { productionId: 'production', shotId: 'absent' }, undefined, undefined, {} as never)).rejects.toThrow('镜头不存在')
})

test('Given 单镜头候选工具 When 提交 Then 仅透传目标输出并拒绝附带整片草稿', async () => {
  /** 用窄执行器记录传入参数，确保模型无法借新工具修改场景或其他镜头。 */
  const calls: unknown[] = []
  const writes: boolean[] = []
  const tools = buildVisualProductionAgentTools({ sessionId: 'session', sdk: { defineTool: (definition: unknown) => definition } as Parameters<typeof buildVisualProductionAgentTools>[0]['sdk'], assertAccess(write) { writes.push(write) }, execute: (async (method, input) => { calls.push({ method, input }); return { ...largeSnapshot().candidates[0]!, draft: largeSnapshot().document } }) as Parameters<typeof buildVisualProductionAgentTools>[0]['execute'] })
  const tool = tools.find(item => item.name === 'visual_production_propose_shot')
  expect(tool).toBeDefined()
  const input = { productionId: 'production', baseRevision: 1, jobId: 'job', shotId: 'shot2', mediaId: 'media', summary: '更新第三镜头' }
  const result = await tool!.execute('call', input, undefined, undefined, {} as never)
  expect(calls).toEqual([{ method: 'proposeShot', input: { ...input, sessionId: 'session' } }])
  expect(writes).toEqual([true])
  expect(JSON.stringify(result.details)).not.toContain('画'.repeat(100))
  await expect(tool!.execute('call', { ...input, draft: {} }, undefined, undefined, {} as never)).rejects.toThrow('INVALID_INPUT')
})

test.each(['普通文本', 'JSON转义文本'])('Given 合法最大镜头与200个长资产身份（%s） When 分页读取 Then 每页有界且可完整还原所有约束', async format => {
  /** 合法单条镜头足以超过常规列表分页预算，必须能沿引用游标续读。 */
  const snapshot = largeSnapshot()
  snapshot.document.assets = Array.from({ length: 200 }, (_, index) => ({ id: `asset${index}`.padEnd(128, 'x'), name: `资产${index}`, type: '角色', locked: true, description: '资产约束', mediaId: null }))
  snapshot.document.shots = [{ ...snapshot.document.shots[0]!, scene: (format === 'JSON转义文本' ? '\u0001' : '景').repeat(8000), motion: (format === 'JSON转义文本' ? '\u0002' : '动').repeat(8000), dialogue: (format === 'JSON转义文本' ? '\n' : '话').repeat(8000), assetIds: snapshot.document.assets.map(asset => asset.id) }]
  snapshot.document.brief = '目标'.repeat(8000)
  snapshot.document.voice = '声'.repeat(4000)
  snapshot.document.music = '乐'.repeat(4000)
  const { schemaVersion: _schema, id: _id, revision: _revision, createdAt: _created, updatedAt: _updated, ...draft } = snapshot.document
  expect(() => parseVisualProductionDraft(draft)).not.toThrow()
  const tools = buildVisualProductionAgentTools({ sessionId: 'session', sdk: { defineTool: (definition: unknown) => definition } as Parameters<typeof buildVisualProductionAgentTools>[0]['sdk'], assertAccess() {}, execute: (async () => snapshot) as Parameters<typeof buildVisualProductionAgentTools>[0]['execute'] })
  const tool = tools.find(item => item.name === 'visual_production_read_shot')!
  const ids: string[] = []
  let offset: number | null = 0
  do {
    /** 每一引用页先完成长文本续读，正文、设定和资产描述逐字段还原。 */
    let textOffset: number | null = 0
    let nextReference: number | null = null
    const restored = { scene: '', motion: '', dialogue: '', brief: '', voice: '', music: '' }
    const descriptions = new Map<string, string>()
    do {
      const result = await tool.execute('call', { productionId: 'production', shotId: 'shot0', referenceOffset: offset, referenceLimit: 20, textOffset }, undefined, undefined, {} as never)
      const page = result.details as { shot: typeof snapshot.document.shots[number]; settings: { brief: string; voice: string; music: string }; referencePage: { nextOffset: number | null }; textPage: { nextOffset: number | null }; assets: Array<{ id: string; description: string }> }
      expect(JSON.stringify(page).length).toBeLessThanOrEqual(49152)
      expect(page.shot.assetIds).toEqual(page.assets.map(asset => asset.id))
      if (textOffset === 0) ids.push(...page.assets.map(asset => asset.id))
      else expect(page.referencePage.nextOffset).toBe(nextReference)
      for (const field of ['scene', 'motion', 'dialogue'] as const) restored[field] += page.shot[field]
      for (const field of ['brief', 'voice', 'music'] as const) restored[field] += page.settings[field]
      for (const asset of page.assets) descriptions.set(asset.id, (descriptions.get(asset.id) ?? '') + asset.description)
      if (page.textPage.nextOffset !== null) expect(page.textPage.nextOffset).toBeGreaterThan(textOffset)
      textOffset = page.textPage.nextOffset
      nextReference = page.referencePage.nextOffset
    } while (textOffset !== null)
    expect(restored).toEqual({ scene: draft.shots[0]!.scene, motion: draft.shots[0]!.motion, dialogue: draft.shots[0]!.dialogue, brief: draft.brief, voice: draft.voice, music: draft.music })
    for (const [id, description] of descriptions) expect(description).toBe(draft.assets.find(asset => asset.id === id)!.description)
    if (nextReference !== null) expect(nextReference).toBeGreaterThan(offset)
    offset = nextReference
  } while (offset !== null)
  expect(ids).toEqual(draft.shots[0]!.assetIds)
})

test('Given 已保存制作配置 When Agent读取 Then 返回分页启用范围、默认与参数且不允许写配置', async () => {
  /** 创作正文很大时，制作配置仍有独立的有界读取入口。 */
  const snapshot = largeSnapshot()
  snapshot.mediaConfiguration = { revision: 2, entries: [{ id: 'source', name: '图片模型', kind: 'image', source: { type: 'model', modelRef: 'media:image:openai-images:profile:model' }, parameters: { size: '1536x1024' } }], defaults: { image: 'source' } }
  const calls: unknown[] = []
  const tools = buildVisualProductionAgentTools({ sessionId: 'session', sdk: { defineTool: (definition: unknown) => definition } as Parameters<typeof buildVisualProductionAgentTools>[0]['sdk'], assertAccess(write) { expect(write).toBe(false) }, execute: (async (method, input) => { calls.push({ method, input }); return snapshot }) as Parameters<typeof buildVisualProductionAgentTools>[0]['execute'] })
  const result = await tools.find(tool => tool.name === 'visual_production_read_media_configuration')!.execute('call', { productionId: 'production', offset: 0, limit: 1 }, undefined, undefined, {} as never)
  expect(result.details).toMatchObject({ revision: 2, inherited: false, defaults: { image: 'source' }, entries: [{ id: 'source', parameters: { size: '1536x1024' } }], total: 1, nextOffset: null })
  expect(calls).toEqual([{ method: 'load', input: { sessionId: 'session', productionId: 'production' } }])
  expect(JSON.stringify(result.details)).not.toContain('画'.repeat(100))
  expect(tools.some(tool => tool.name.includes('save_media'))).toBe(false)
})

test('Given 大目录 When Agent分页 Then 返回能力与真实参考限制', async () => {
  /** 目录分页不把工具分页字段混入IPC严格信封。 */
  const options = Array.from({ length: 4 }, (_, index) => ({ id: `model${index}`, name: `模型${index}`, kind: 'image', source: { type: 'model', modelRef: `ref${index}` }, parameters: {}, available: true, constraints: { maxImageReferences: 1, parameters: [] } }))
  const calls: unknown[] = []
  const tools = buildVisualProductionAgentTools({ sessionId: 'session', sdk: { defineTool: (definition: unknown) => definition } as Parameters<typeof buildVisualProductionAgentTools>[0]['sdk'], assertAccess() {}, execute: (async (method, input) => { calls.push({ method, input }); return options }) as Parameters<typeof buildVisualProductionAgentTools>[0]['execute'] })
  const result = await tools.find(tool => tool.name === 'visual_production_media_catalog')!.execute('call', { productionId: 'production', offset: 1, limit: 2 }, undefined, undefined, {} as never)
  expect(result.details).toMatchObject({ entries: [{ id: 'model1', constraints: { maxImageReferences: 1 } }, { id: 'model2' }], total: 4, nextOffset: 3 })
  expect(calls).toEqual([{ method: 'mediaCatalog', input: { sessionId: 'session', productionId: 'production' } }])
})
