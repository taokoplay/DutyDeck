import { expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { PrototypeDocument } from '@dutydeck/shared'
import type { InteractionAssetService } from './asset-service'
import { createInteractionDelivery, createInteractionHandoff } from './delivery-service'

test('Given 仅附加状态引用素材与token When 导出交接 Then 包含状态资源与元素', () => {
  /** 隔离临时交付目录，避免写入真实项目数据。 */
  const directory = mkdtempSync(join(tmpdir(), 'prototype-state-delivery-'))
  const document: PrototypeDocument = {
    schemaVersion: 1, id: 'p', revision: 1, createdAt: 1, updatedAt: 1, name: '测试', platform: 'mobile', brief: '', groups: [{ id: 'g', name: '页面' }], entryPageId: 'home', flows: [],
    pages: [{ id: 'home', groupId: 'g', name: '首页', html: '<p>默认</p>', defaultStateName: '有数据', states: [{ id: 'empty', name: '无数据', html: '<style>:root{--empty-color:red}</style><img data-prototype-element="empty-image" src="prototype-asset:empty">' }] }],
  }
  /** 只模拟已授权资源读取边界，断言请求资源身份。 */
  const requested: string[] = []
  const assets = {
    content(id: string) { requested.push(id); return { dataUrl: 'data:image/png;base64,AAAA' } },
    list() { return [{ id: 'empty' }] },
  } as unknown as InteractionAssetService
  try {
    const delivery = createInteractionDelivery(document, assets, directory)
    expect(requested).toEqual(['empty'])
    expect(delivery.html).toContain('data:image/png;base64,AAAA')
    const handoff = createInteractionHandoff(document, assets, directory)
    expect(handoff.designTokens['--empty-color']).toBe('red')
    expect(handoff.assets.map(asset => asset.id)).toEqual(['empty'])
    expect(handoff.pages[0]!.elementIds).toEqual(['empty-image'])
    expect(handoff.pages[0]!.states).toEqual([{ name: '有数据', elementIds: [] }, { id: 'empty', name: '无数据', elementIds: ['empty-image'] }])
  } finally { rmSync(directory, { recursive: true, force: true }) }
})

test('Given 设备基线与横屏游戏状态 When 开发交接 Then 尺寸安全区与状态继承一致且旧稿不变', () => {
  /** 交接仅写入本测试临时目录。 */
  const directory = mkdtempSync(join(tmpdir(), 'prototype-layout-delivery-'))
  const document: PrototypeDocument = { schemaVersion: 1, id: 'p', revision: 1, createdAt: 1, updatedAt: 1, name: '测试', platform: 'mobile', brief: '', groups: [{ id: 'g', name: '页面' }], entryPageId: 'home', flows: [], pages: [{ id: 'home', groupId: 'g', name: '首页', html: '<main>首页</main>' }] }
  const assets = { list: () => [] } as unknown as InteractionAssetService
  try {
    const legacy = createInteractionHandoff(document, assets, directory)
    expect(legacy.visualContract.viewport).toEqual({ width: 390, height: 844 })
    expect(legacy.pages[0]).not.toHaveProperty('presentation')
    document.environment = { schemaVersion: 1, target: 'ios', deviceId: 'iPhone 17' }
    document.pages[0]!.presentation = { schemaVersion: 1, contentLayout: 'safe', statusBar: 'dark', navigation: 'inline', orientation: 'portrait' }
    document.pages[0]!.states = [{ id: 'game', name: '游戏', html: '<main>游戏</main>', presentation: { schemaVersion: 1, contentLayout: 'edge-to-edge', statusBar: 'hidden', navigation: 'none', orientation: 'landscape' } }, { id: 'empty', name: '空态', html: '<main>空态</main>' }]
    const result = createInteractionHandoff(document, assets, directory)
    expect(result.visualContract.environment).toEqual(document.environment)
    expect(result.visualContract.viewport).toEqual({ width: 402, height: 874 })
    expect(result.pages[0]!.states![1]!.viewport).toEqual({ width: 874, height: 402 })
    expect(result.pages[0]!.states![1]!.safeArea!.left).toBeGreaterThan(0)
    expect(result.pages[0]!.states![1]!.safeArea!.top).toBe(0)
    expect(result.pages[0]!.states![2]!.presentation).toEqual(document.pages[0]!.presentation)
    expect(result.manifestHash).not.toBe(legacy.manifestHash)
    /** 横屏仍显示状态栏的页面，交接必须包含与运行时相同的24px顶部占位。 */
    for (const statusBar of ['dark', 'light'] as const) {
      document.pages[0]!.presentation = { ...document.pages[0]!.presentation, orientation: 'landscape', statusBar }
      const landscape = createInteractionHandoff(document, assets, directory)
      expect(landscape.pages[0]!.safeArea!.top).toBe(24)
      expect(landscape.pages[0]!.states![2]!.safeArea!.top).toBe(24)
      expect(landscape.pages[0]!.states![1]!.safeArea!.top).toBe(0)
    }
  } finally { rmSync(directory, { recursive: true, force: true }) }
})

test('Given 页面引用未进入正文的参考图 When 开发交接 Then 保留参考关系并加入资产元数据', () => {
  const directory = mkdtempSync(join(tmpdir(), 'prototype-reference-delivery-'))
  const document: PrototypeDocument = {
    schemaVersion: 1, id: 'p', revision: 2, createdAt: 1, updatedAt: 2, name: '测试', platform: 'mobile', brief: '',
    groups: [{ id: 'g', name: '页面' }], entryPageId: 'home', flows: [],
    pages: [{ id: 'home', groupId: 'g', name: '首页', html: '<main>首页</main>' }],
    references: [{ id: 'ref-1', assetId: 'asset-ref', title: '参考结构', role: 'structure', source: 'Figma', usages: [{ pageId: 'home' }] }],
  }
  const asset = { id: 'asset-ref', name: 'ref.png', hash: 'c'.repeat(64), mime: 'image/png', byteSize: 12, createdAt: 1 }
  const assets = { list: () => [asset] } as unknown as InteractionAssetService
  try {
    const handoff = createInteractionHandoff(document, assets, directory)
    expect(handoff.references).toEqual(document.references)
    expect(handoff.assets).toEqual([asset])
    expect(handoff.manifestHash).toHaveLength(64)
  } finally { rmSync(directory, { recursive: true, force: true }) }
})
