import { describe, expect, test } from 'bun:test'
import { createStore } from 'jotai'
import type { VisualProductionReference } from '@dutydeck/shared'
import { currentVisualProductionReferenceAtomFamily, resolveCurrentVisualProductionReference, snapshotVisualProductionReferences, visualProductionReferencesAtomFamily } from './visual-production-reference-atoms'

/** 构造两个作品的正式引用，避免依赖真实用户数据。 */
const reference = (productionId: string): VisualProductionReference => ({ workspaceId: 'workspace', productionId, productionRevision: 1, target: { kind: 'production' }, title: productionId, productionTitle: productionId })

describe('当前影像作品发送范围', () => {
  test('Given 两个作品 When 切换当前作品 Then 新消息使用新作品且会话隔离', () => {
    const store = createStore()
    store.set(currentVisualProductionReferenceAtomFamily('one'), reference('first'))
    store.set(currentVisualProductionReferenceAtomFamily('one'), reference('second'))
    expect(store.get(currentVisualProductionReferenceAtomFamily('one'))?.productionId).toBe('second')
    expect(store.get(currentVisualProductionReferenceAtomFamily('two'))).toBeNull()
  })
  test('Given 显式镜头或资产引用 When 发送 Then 不附加当前整作品范围', () => {
    for (const targetType of ['shot', 'asset'] as const) {
      const explicit: VisualProductionReference = { ...reference('first'), target: targetType === 'shot' ? { kind: 'shot', shotId: 'object' } : { kind: 'asset', assetId: 'object' } }
      expect(snapshotVisualProductionReferences([explicit], reference('second'), 'workspace')).toEqual([explicit])
    }
    expect(snapshotVisualProductionReferences([], reference('second'), 'other')).toEqual([])
    expect(snapshotVisualProductionReferences([], null, undefined)).toEqual([])
    expect(snapshotVisualProductionReferences([], reference('second'), 'workspace')[0]?.source).toBe('current-view')
    expect(snapshotVisualProductionReferences([reference('first')], reference('second'), 'workspace')[0]?.source).toBeUndefined()
  })
  test('Given 已冻结消息 When 切换作品并清理草稿 Then 原消息和当前作品均保留独立范围', () => {
    const store = createStore()
    const current = reference('first')
    store.set(currentVisualProductionReferenceAtomFamily('one'), current)
    const sent = snapshotVisualProductionReferences([], current, 'workspace')
    current.title = 'changed'
    store.set(currentVisualProductionReferenceAtomFamily('one'), reference('second'))
    store.set(visualProductionReferencesAtomFamily('one'), [])
    expect(sent[0]?.title).toBe('first')
    expect(store.get(currentVisualProductionReferenceAtomFamily('one'))?.productionId).toBe('second')
  })
  test('Given 新作品尚在加载 When 发送 Then 冻结新身份而非丢失目标或使用旧快照标题', () => {
    const old = reference('first')
    const selected = { ...reference('second'), title: '正在加载作品', productionTitle: '正在加载作品' }
    expect(resolveCurrentVisualProductionReference(true, 'new', 'old', old, selected)).toEqual({ ...selected, source: 'current-view' })
    expect(resolveCurrentVisualProductionReference(false, 'new', 'old', old, selected)).toBeNull()
    expect(resolveCurrentVisualProductionReference(true, 'same', 'same', old, old)).toEqual({ ...old, source: 'current-view' })
    expect(resolveCurrentVisualProductionReference(true, 'same', 'same', old, null)).toBeNull()
  })
})
