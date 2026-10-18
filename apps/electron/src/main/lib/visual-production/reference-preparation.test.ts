import { describe, expect, test } from 'bun:test'
import type { VisualProductionReference, VisualProductionDocument } from '@dutydeck/shared'
import { prepareVisualProductionReferences } from './reference-preparation'

/** 固定作品，不读取磁盘或媒体。 */
const document = { id: 'p', revision: 3, title: '权威作品', shots: [{ id: 's', title: '权威镜头' }], assets: [] } as unknown as VisualProductionDocument
/** Renderer 提供的标题不得当成权威指令。 */
const reference: VisualProductionReference = { workspaceId: 'w', productionId: 'p', productionRevision: 3, target: { kind: 'shot', shotId: 's' }, title: '伪标题', productionTitle: '伪作品' }
describe('影像引用接管前校验', () => {
  test('Given 有效引用 When 接管 Then 替换不可信标题并只提供只读范围', async () => {
    const prepared = await prepareVisualProductionReferences({ sessionId: 'session', visualProductionReferences: [reference] }, { workspaceId: 'w', assertCurrent() {}, load: async () => document })
    expect(prepared.references[0]?.title).toBe('权威镜头')
    expect(prepared.references[0]?.productionTitle).toBe('权威作品')
    expect(prepared.prompt).toContain('引用本身不授权生成或修改')
    expect(prepared.prompt).not.toContain('伪标题')
  })
  test('Given 跨工作区或版本过期或目标删除 When 接管 Then 不降级为整部作品', async () => {
    for (const changed of [{ ...reference, workspaceId: 'other' }, { ...reference, productionRevision: 2 }, { ...reference, target: { kind: 'shot' as const, shotId: 'gone' } }]) {
      await expect(prepareVisualProductionReferences({ sessionId: 'session', visualProductionReferences: [changed] }, { workspaceId: 'w', assertCurrent() {}, load: async () => document })).rejects.toThrow()
    }
  })
  test('Given 读取期间身份漂移 When 接管 Then 异步返回后仍拒绝', async () => {
    let calls = 0
    await expect(prepareVisualProductionReferences({ sessionId: 'session', visualProductionReferences: [reference] }, { workspaceId: 'w', assertCurrent() { if (++calls > 1) throw new Error('身份变化') }, load: async () => document })).rejects.toThrow('身份变化')
  })
  test('Given 引用读取期间取消 When 底层返回 Then 传递信号且拒绝后续读取和结果', async () => {
    /** 模拟排队消息取消；只允许第一部作品开始读取。 */
    const controller = new AbortController()
    let reads = 0
    await expect(prepareVisualProductionReferences({ sessionId: 'session', visualProductionReferences: [reference, { ...reference, productionId: 'next' }] }, {
      workspaceId: 'w', assertCurrent() {},
      load: async (_productionId, signal) => {
        reads++
        expect(signal).toBe(controller.signal)
        controller.abort(new Error('取消引用准备'))
        return document
      },
    }, controller.signal)).rejects.toThrow('取消引用准备')
    expect(reads).toBe(1)
  })
})
