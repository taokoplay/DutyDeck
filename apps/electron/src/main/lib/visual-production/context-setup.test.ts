import { describe, expect, test } from 'bun:test'
import { prepareVisualTaskContext } from './context-setup'
import type { VisualTaskContextRuntime, VisualTaskContextDescription } from './task-context'
import type { VisualProductionReference } from '@dutydeck/shared'

/** 宿主已核验引用固定为两个不同镜头，素材身份不得由标题推测。 */
const reference: VisualProductionReference = { workspaceId: 'w', productionId: 'p', productionRevision: 2, target: { kind: 'shot', shotId: 's' }, title: '镜头', productionTitle: '作品' }
/** 模拟域服务只返回该范围授权媒体，记录是否错误自动看图。 */
function fixture() {
  let current: VisualTaskContextDescription | undefined
  const runtime: VisualTaskContextRuntime = {
    assertContextActive() { if (!current) throw new Error('closed') },
    async open(input) { current = { contextId: `scope-${input.target.kind}`, workspaceId: 'w', sessionId: 'u', runId: 'r', openInput: input, observations: [], media: [{ id: 'media', hash: 'a'.repeat(64), name: '图', mime: 'image/png', kind: 'image', byteSize: 10, createdAt: 1 }] }; return { content: [], details: { visualTaskContext: { version: 1, action: 'open', contextId: current.contextId, runId: 'r' } } } },
    async describe() { if (!current) throw new Error('closed'); return current },
    async close({ contextId }) { current = undefined; return { content: [], details: { visualTaskContext: { version: 1, action: 'close', contextId, runId: 'r' } } } },
    async inspect() { throw new Error('must not read pixels before intent') },
    async record() { throw new Error('must not write observations') },
    dispose() { current = undefined },
  }
  return runtime
}
describe('影像首轮范围准备', () => {
  test('Given 单个明确引用 When 首次请求准备 Then绑定版本范围与可追溯旧图hash但不读图片', async () => {
    const result = await prepareVisualTaskContext(fixture(), 'r', [reference])
    expect(result.policy.initialContextId).toBe('scope-shot')
    expect(result.policy.legacyMedia).toEqual([{ mediaId: 'media', hash: 'a'.repeat(64) }])
    expect(result.prompt).toContain('productionRevision')
  })
  test('Given 多对象引用 When 准备 Then不擅自将最后一个对象当任务目标', async () => {
    const result = await prepareVisualTaskContext(fixture(), 'r', [reference, { ...reference, target: { kind: 'asset', assetId: 'a' } }])
    expect(result.policy.initialContextId).toBeUndefined()
    expect(result.policy.legacyMedia).toHaveLength(1)
    expect(result.prompt).toContain('open_context')
  })
})
