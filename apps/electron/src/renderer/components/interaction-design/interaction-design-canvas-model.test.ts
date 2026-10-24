import { describe, expect, test } from 'bun:test'
import type { PrototypeDocument } from '@dutydeck/shared'
import { buildPrototypeCanvasLayout } from './interaction-design-canvas-model'

/** 固定三页流程与一个孤立页，验证列布局不依赖目录顺序。 */
const document: PrototypeDocument = {
  schemaVersion: 1,
  id: 'prototype-1',
  revision: 4,
  createdAt: 1,
  updatedAt: 4,
  name: '流程',
  platform: 'mobile',
  brief: '',
  groups: [{ id: 'g', name: '全部' }],
  pages: [
    { id: 'home', groupId: 'g', name: '首页', html: '<h1>首页</h1>' },
    { id: 'detail', groupId: 'g', name: '详情', html: '<h1>详情</h1>' },
    { id: 'success', groupId: 'g', name: '成功', html: '<h1>成功</h1>' },
    { id: 'orphan', groupId: 'g', name: '孤立页', html: '<h1>孤立</h1>' },
  ],
  entryPageId: 'home',
  flows: [
    { id: 'home-detail', fromPageId: 'home', elementId: 'open', targetPageId: 'detail' },
    { id: 'detail-success', fromPageId: 'detail', elementId: 'pay', targetPageId: 'success' },
  ],
}

describe('交互设计画布布局', () => {
  test('Given 有向页面流程 When 布局 Then 入口在首列且后续页面按跳转列展开', () => {
    const graph = buildPrototypeCanvasLayout(document, { width: 390, height: 844 }, 210)
    expect(graph.nodes.find(node => node.pageId === 'home')?.column).toBe(0)
    expect(graph.nodes.find(node => node.pageId === 'detail')?.column).toBe(1)
    expect(graph.nodes.find(node => node.pageId === 'success')?.column).toBe(2)
    expect(graph.edges).toHaveLength(2)
  })

  test('Given 孤立页面 When 布局 Then 仍生成可见位置且节点不重叠', () => {
    const graph = buildPrototypeCanvasLayout(document, { width: 390, height: 844 }, 210)
    const orphan = graph.nodes.find(node => node.pageId === 'orphan')
    expect(orphan).toBeDefined()
    for (let left = 0; left < graph.nodes.length; left++) {
      for (let right = left + 1; right < graph.nodes.length; right++) {
        const a = graph.nodes[left]!
        const b = graph.nodes[right]!
        const overlaps = a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y
        expect(overlaps).toBe(false)
      }
    }
  })

  test('Given 设备比例变化 When 布局 Then 页面卡片高度按真实视口比例变化', () => {
    const mobile = buildPrototypeCanvasLayout(document, { width: 390, height: 844 }, 210)
    const desktop = buildPrototypeCanvasLayout(document, { width: 1440, height: 900 }, 210)
    expect(mobile.nodes[0]!.height).toBeGreaterThan(desktop.nodes[0]!.height)
    expect(mobile.nodes[0]!.width).toBe(210)
    expect(desktop.nodes[0]!.width).toBe(210)
  })
})
