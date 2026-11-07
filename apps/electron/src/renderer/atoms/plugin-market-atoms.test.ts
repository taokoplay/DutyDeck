import { describe, expect, test } from 'bun:test'
import { createStore } from 'jotai'
import type { PluginMarketApi, PluginMarketPage, PluginMarketQuery, PluginCompatibilityReport } from '@dutydeck/shared'
import { pluginMarketAtom, pluginMarketSearchAtom, runPluginMarketActionAtom } from './plugin-market-atoms'
const page: PluginMarketPage = { sourceUrl: 'https://example.com/index.json', fetchedAt: null, snapshotHash: null, total: 0, entries: [], nextOffset: null, stale: false, error: null }
function api(): PluginMarketApi { return { list: async () => page, refresh: async () => page, detail: async () => { throw new Error('unavailable') }, analyze: async () => { throw new Error('unavailable') } } }
describe('Given 市场Jotai状态', () => {
  test('When 打开目录 Then 仅调用list，刷新失败保留缓存并提示错误', async () => {
    const store = createStore(); let refresh = 0
    const service = { ...api(), refresh: async () => { refresh++; throw new Error('offline') } }
    await store.set(runPluginMarketActionAtom, { api: service, kind: 'list' })
    expect(store.get(pluginMarketAtom).page).toEqual(page)
    expect(refresh).toBe(0)
    await store.set(runPluginMarketActionAtom, { api: service, kind: 'refresh' })
    expect(store.get(pluginMarketAtom)).toMatchObject({ page, busy: false, error: '目录请求失败，请重试；上次成功缓存保持不变。' })
  })
  test('When 修改未提交草稿后翻页或重新进入 Then 游标始终与已提交查询配对', async () => {
    const store = createStore(); const calls: Array<PluginMarketQuery | undefined> = []
    const service = { ...api(), list: async (query?: PluginMarketQuery) => { calls.push(query); return { ...page, fetchedAt: '2026-11-06', total: 65, nextOffset: 30 } } }
    await store.set(runPluginMarketActionAtom, { api: service, kind: 'list', query: { query: 'demo', offset: 0 } })
    store.set(pluginMarketSearchAtom, 'demo-1')
    await store.set(runPluginMarketActionAtom, { api: service, kind: 'list', query: { offset: 30 } })
    expect(calls.at(-1)).toMatchObject({ query: 'demo', offset: 30 })
    expect(store.get(pluginMarketAtom)).toMatchObject({ query: { query: 'demo', offset: 30 } })
    await store.set(runPluginMarketActionAtom, { api: service, kind: 'list' })
    expect(calls.at(-1)).toMatchObject({ query: 'demo', offset: 30 })
    expect(store.get(pluginMarketSearchAtom)).toBe('demo-1')
  })
  test('When 翻页请求跨重挂载返回 Then 页面与全局游标一同提交，失败不更改游标', async () => {
    const store = createStore(); let resolve!: (value: PluginMarketPage) => void
    const service = { ...api(), list: async () => new Promise<PluginMarketPage>(done => { resolve = done }) }
    const pending = store.set(runPluginMarketActionAtom, { api: service, kind: 'list', query: { offset: 30 } })
    await store.set(runPluginMarketActionAtom, { api: service, kind: 'list' })
    resolve({ ...page, nextOffset: 60 }); await pending
    expect(store.get(pluginMarketAtom)).toMatchObject({ query: { offset: 30 }, page: { nextOffset: 60 } })
    await store.set(runPluginMarketActionAtom, { api: { ...api(), list: async () => { throw new Error('offline') } }, kind: 'list', query: { offset: 60 } })
    expect(store.get(pluginMarketAtom)).toMatchObject({ query: { offset: 30 }, page: { nextOffset: 60 } })
  })
  test('When 已提交但持久性未确认 Then 不声称仍显示旧缓存', async () => {
    const store = createStore()
    await store.set(runPluginMarketActionAtom, { api: { ...api(), refresh: async () => ({ ...page, error: 'PLUGIN_CATALOG_COMMITTED_DURABILITY_UNCERTAIN' }) }, kind: 'refresh' })
    expect(store.get(pluginMarketAtom).error).toContain('新快照已提交')
    expect(store.get(pluginMarketAtom).error).not.toContain('保留上次成功缓存')
  })
  test('When 分析精确版本后关闭详情 Then 迟到结果不重新打开；失败保留旧报告', async () => {
    const store = createStore(); let resolve!: (report: PluginCompatibilityReport) => void
    const detail: PluginCompatibilityReport = { entry: { name: 'demo', title: 'demo', description: '', category: null, repository: null, versions: [{ version: '1.0.0', sourceType: 'npm', engines: {} }], compatibility: 'unassessed' }, sourceUrl: page.sourceUrl, snapshotHash: 'a'.repeat(64), packageHash: null, license: null, dependencies: null, status: 'unassessed', reasons: [] }
    store.set(pluginMarketAtom, { ...store.get(pluginMarketAtom), detail })
    const pending = store.set(runPluginMarketActionAtom, { api: { ...api(), analyze: async input => { expect(input).toMatchObject({ name: 'demo', version: '1.0.0', snapshotHash: detail.snapshotHash }); return new Promise(done => { resolve = done }) } }, kind: 'analyze', version: '1.0.0' })
    expect(store.get(pluginMarketAtom).busy).toBe(true)
    expect(typeof resolve).toBe('function') // 分析动作必须实际调用专用API，而不是误走list。
    store.set(pluginMarketAtom, { ...store.get(pluginMarketAtom), detail: null })
    resolve({ ...detail, packageHash: 'b'.repeat(64) }); await pending
    expect(store.get(pluginMarketAtom).detail).toBeNull()
    store.set(pluginMarketAtom, { ...store.get(pluginMarketAtom), detail })
    await store.set(runPluginMarketActionAtom, { api: api(), kind: 'analyze', version: '1.0.0' })
    expect(store.get(pluginMarketAtom).detail).toEqual(detail)
    expect(store.get(pluginMarketAtom).error).toContain('包静态分析失败')
  })
  test('When 同时点击刷新 Then 同步busy guard只发一个请求', async () => {
    const store = createStore(); let resolve: (value: PluginMarketPage) => void = () => undefined; let calls = 0
    const service = { ...api(), refresh: async () => { calls++; return new Promise<PluginMarketPage>(done => { resolve = done }) } }
    const first = store.set(runPluginMarketActionAtom, { api: service, kind: 'refresh' })
    const second = store.set(runPluginMarketActionAtom, { api: service, kind: 'refresh' })
    resolve(page); await Promise.all([first, second])
    expect(calls).toBe(1)
    expect(store.get(pluginMarketAtom).busy).toBe(false)
  })
})
