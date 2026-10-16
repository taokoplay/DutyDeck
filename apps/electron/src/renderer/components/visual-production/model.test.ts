import { describe, expect, it } from 'bun:test'
import { copyVisualDraft, reorderVisualShot, VisualRequestGate, VisualScopeEpoch } from './model'
import type { VisualProductionDraft, VisualShot } from '@proma/shared'
/** 最小镜头夹具用于验证跨集排序边界。 */
const shot = (id: string, episodeId: string): VisualShot => ({ id, episodeId, title: id, duration: 3, scene: '', motion: '', dialogue: '', assetIds: [], mediaId: null })
describe('影像创作编辑模型', () => {
  it('当重排当前集镜头时，应保留其他集位置且边界不越界', () => {
    const source = [shot('a', 'one'), shot('x', 'two'), shot('b', 'one')]
    expect(reorderVisualShot(source, 'a', 1).map(item => item.id)).toEqual(['b', 'x', 'a'])
    expect(reorderVisualShot(source, 'a', -1)).toBe(source)
    expect(source[0]!.id).toBe('a')
  })
  it('当编辑草稿时，不应污染正式镜头与资产引用', () => {
    const source: VisualProductionDraft = { title: '作品', kind: 'film', brief: '', ratio: '16:9', fps: 24, voice: '', music: '', episodes: [{ id: 'one', title: '第一集' }], assets: [], shots: [shot('a', 'one')] }
    const draft = copyVisualDraft(source)
    draft.shots[0]!.assetIds.push('new')
    expect(source.shots[0]!.assetIds).toEqual([])
  })
  it('切换作品或新读取后拒绝旧异步结果', () => {
    const gate = new VisualRequestGate()
    const old = gate.next()
    expect(gate.accepts(old)).toBe(true)
    const current = gate.next()
    expect(gate.accepts(old)).toBe(false)
    expect(gate.accepts(current)).toBe(true)
  })
})

describe('影像工作区往返隔离', () => {
  it('A 保存期间切到 B 再回 A，旧写结果不可清掉新草稿', () => {
    const scope = new VisualScopeEpoch()
    scope.enter('A')
    const saved = scope.capture()
    scope.enter('B')
    scope.enter('A')
    expect(scope.accepts(saved)).toBe(false)
    const current = scope.capture()
    scope.enter('A')
    expect(scope.accepts(current)).toBe(true)
    scope.invalidate()
    expect(scope.accepts(current)).toBe(false)
  })
})
