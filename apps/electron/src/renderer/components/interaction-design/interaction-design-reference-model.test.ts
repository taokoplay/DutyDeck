import { describe, expect, test } from 'bun:test'
import type { PrototypeAsset, PrototypeDocument } from '@dutydeck/shared'
import { addPrototypeAssetReferences, addPrototypeReference, isInteractionReferenceImageFile, removePrototypeReference, setPrototypeReferencePages } from './interaction-design-reference-model'

const asset: PrototypeAsset = { id: 'asset-1', name: 'home.png', hash: 'a'.repeat(64), mime: 'image/png', byteSize: 10, createdAt: 1 }
const document: PrototypeDocument = {
  schemaVersion: 1, id: 'prototype-1', revision: 3, createdAt: 1, updatedAt: 2,
  name: '原型', platform: 'mobile', brief: '', groups: [{ id: 'g', name: '页面' }], entryPageId: 'home',
  pages: [{ id: 'home', groupId: 'g', name: '首页', html: '<h1>首页</h1>' }, { id: 'detail', groupId: 'g', name: '详情', html: '<h1>详情</h1>' }],
  flows: [],
}

describe('参考图草稿编辑', () => {
  test('Given 已登记图片 When 添加为结构参考 Then 生成稳定身份并关联目标页', () => {
    const next = addPrototypeReference(document, asset, { id: 'reference-1', title: '首页结构', role: 'structure', pageIds: ['home'], source: 'Figma' })
    expect(next.references).toEqual([{ id: 'reference-1', assetId: 'asset-1', title: '首页结构', role: 'structure', source: 'Figma', usages: [{ pageId: 'home' }] }])
    expect(document.references).toBeUndefined()
  })
  test('Given 参考图已关联页面 When 修改关联 Then 保留参考身份并替换页面集合', () => {
    const source = addPrototypeReference(document, asset, { id: 'reference-1', title: '视觉', role: 'visual', pageIds: ['home'] })
    const next = setPrototypeReferencePages(source, 'reference-1', ['detail'])
    expect(next.references?.[0]?.usages).toEqual([{ pageId: 'detail' }])
  })
  test('Given 删除参考图 When 编辑草稿 Then 只移除参考关系并保留资产', () => {
    const source = addPrototypeReference(document, asset, { id: 'reference-1', title: '结构', role: 'structure', pageIds: ['home'] })
    expect(removePrototypeReference(source, 'reference-1').references).toEqual([])
    expect(asset.id).toBe('asset-1')
  })
  test('Given 多张拖入资产 When 自动登记 Then 关联当前页并跳过已有图片', () => {
    const source = addPrototypeReference(document, asset, { id: 'reference-1', title: '已有视觉', role: 'visual', pageIds: ['home'] })
    const second: PrototypeAsset = { ...asset, id: 'asset-2', name: 'detail.webp', hash: 'b'.repeat(64), mime: 'image/webp' }
    const next = addPrototypeAssetReferences(source, [asset, second], 'detail')
    expect(next?.references).toHaveLength(2)
    expect(next?.references?.[1]).toMatchObject({ assetId: 'asset-2', title: 'detail', role: 'visual', source: '拖入图片', usages: [{ pageId: 'detail' }] })
    expect(addPrototypeAssetReferences(next!, [second], 'detail')).toBeNull()
  })
  test('Given 外部拖入文件 When 判断可导入性 Then 只接受受限被动图片', () => {
    expect(isInteractionReferenceImageFile({ name: 'photo.PNG', type: '', size: 1024 })).toBe(true)
    expect(isInteractionReferenceImageFile({ name: 'photo.svg', type: 'image/svg+xml', size: 1024 })).toBe(false)
    expect(isInteractionReferenceImageFile({ name: 'photo.png', type: 'image/png', size: 20 * 1024 * 1024 + 1 })).toBe(false)
  })
})
