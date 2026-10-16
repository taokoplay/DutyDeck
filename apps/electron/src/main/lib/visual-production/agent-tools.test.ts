import { describe, expect, test } from 'bun:test'
import { buildVisualProductionAgentTools, VISUAL_PRODUCTION_AGENT_TOOL_NAMES } from './agent-tools'
import type { VisualProductionResults } from '@proma/shared'

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
