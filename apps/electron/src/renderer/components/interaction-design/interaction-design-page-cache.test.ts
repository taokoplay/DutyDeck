import { describe, expect, test } from 'bun:test'
import { retainPrototypePage, type PrototypePageCache } from './interaction-design-page-cache'

/** 每条测试从空缓存开始，记录顺序对应真实 DOM 插入顺序。 */
function emptyCache(): PrototypePageCache { return { entries: [], activePageId: '', refresh: 0, clock: 0 } }

/** 生成有明确内存与画板成本的测试页面。 */
function page(pageId: string, assetBytes = 1, frames = 1) { return { pageId, assetBytes, frames } }

describe('交互预览页面缓存', () => {
  test('Given 已打开 A/B When 返回 A Then 保留实例与 DOM 顺序且同页重复渲染不改缓存', () => {
    /** 原页面实例与切页后的缓存。 */
    const first = retainPrototypePage(emptyCache(), page('a'), 0)
    const second = retainPrototypePage(first, page('b'), 0)
    const returned = retainPrototypePage(second, page('a'), 0)
    expect(returned.entries.map(entry => entry.pageId)).toEqual(['a', 'b'])
    expect(returned.entries[0]!.instance).toBe(first.entries[0]!.instance)
    expect(retainPrototypePage(returned, page('a'), 0)).toBe(returned)
  })

  test('Given 最近访问 A/B/C/A When 打开 D Then 淘汰最久未用 B且已有 DOM 不重排', () => {
    /** 通过真实访问顺序推进最近使用记录。 */
    let cache = emptyCache()
    for (const id of ['a', 'b', 'c', 'a', 'd']) cache = retainPrototypePage(cache, page(id), 0)
    expect(cache.entries.map(entry => entry.pageId)).toEqual(['a', 'c', 'd'])
    expect(cache.activePageId).toBe('d')
  })

  test('Given 缓存 A/B When 刷新 B Then 仅替换 B 的体验实例', () => {
    /** 刷新前后两份缓存。 */
    const before = retainPrototypePage(retainPrototypePage(emptyCache(), page('a'), 0), page('b'), 0)
    const after = retainPrototypePage(before, page('b'), 1)
    expect(after.entries[0]!.instance).toBe(before.entries[0]!.instance)
    expect(after.entries[1]!.instance).not.toBe(before.entries[1]!.instance)
    expect(retainPrototypePage(after, page('a'), 1).entries[0]!.instance).toBe(before.entries[0]!.instance)
  })

  test('Given 多状态或大图缓存 When 超出总预算 Then 提前淘汰旧页并始终保留当前页', () => {
    /** 图像预算与画板预算独立约束，单个超限当前页由资源加载器显示占位反馈。 */
    const megabyte = 1024 * 1024
    const large = retainPrototypePage(retainPrototypePage(emptyCache(), page('a', 40 * megabyte), 0), page('b', 30 * megabyte), 0)
    expect(large.entries.map(entry => entry.pageId)).toEqual(['b'])
    const states = retainPrototypePage(retainPrototypePage(emptyCache(), page('a', 1, 13), 0), page('b', 1, 4), 0)
    expect(states.entries.map(entry => entry.pageId)).toEqual(['b'])
    expect(retainPrototypePage(large, page('oversized', 80 * megabyte), 0).entries.map(entry => entry.pageId)).toEqual(['oversized'])
    expect(retainPrototypePage(large, page('invalid', Number.NaN), 0).entries.map(entry => entry.pageId)).toEqual(['invalid'])
  })
})
