import { describe, expect, test } from 'bun:test'
import { createStore } from 'jotai'
import type { PluginImportReceipt, PluginStaticImportApi, StaticImportPreview } from '@dutydeck/shared'
import { pluginStaticImportAtom, runStaticImportActionAtom } from './plugin-static-import-atoms'
const preview: StaticImportPreview = { token: 'token', planHash: 'a'.repeat(64), workspaceId: 'workspace-a', conflicts: [], receipt: null, content: { pluginId: 'convert.docs', packageHash: 'b'.repeat(64), keyId: 'c'.repeat(64) } }
const receipt: PluginImportReceipt = { formatVersion: 1, id: 'd'.repeat(64), planHash: preview.planHash, workspaceId: preview.workspaceId, revision: 1, updatedAt: new Date().toISOString(), steps: [{ id: 'content', status: 'created', fingerprint: 'e'.repeat(64) }] }
describe('Given 分阶段导入界面状态', () => {
  test('When 只读列表或预览失败 Then 提示读取失败而非本次操作已经部分提交', async () => {
    const store = createStore()
    const fail = async (): Promise<never> => { throw new Error('fixture read failed') }
    const api: PluginStaticImportApi = { list: fail, preview: fail, apply: fail, undo: fail }
    store.set(pluginStaticImportAtom, { workspaceId: 'workspace-a', plans: [], preview, busy: false, error: null })
    for (const kind of ['list', 'preview'] as const) {
      await store.set(runStaticImportActionAtom, { api, kind, planHash: preview.planHash })
      expect(store.get(pluginStaticImportAtom).error).toContain('读取失败')
      expect(store.get(pluginStaticImportAtom).error).not.toContain('部分提交')
      expect(store.get(pluginStaticImportAtom).preview).toBe(preview)
    }
  })
  test('When 未确认或并发连点 Then 不发送重复写入；成功后保留阶段回执', async () => {
    const store = createStore(); let calls = 0; let finish!: (value: PluginImportReceipt) => void
    const api: PluginStaticImportApi = { list: async () => [], preview: async () => preview, apply: async input => { calls++; expect(input.trustedKeyId).toBe(preview.content!.keyId); return new Promise(resolve => { finish = resolve }) }, undo: async () => receipt }
    store.set(pluginStaticImportAtom, { workspaceId: 'workspace-a', plans: [], preview, busy: false, error: null })
    await store.set(runStaticImportActionAtom, { api, kind: 'apply', confirmed: false })
    expect(calls).toBe(0)
    const running = store.set(runStaticImportActionAtom, { api, kind: 'apply', confirmed: true, trustPublisher: true })
    expect(calls).toBe(1)
    await store.set(runStaticImportActionAtom, { api, kind: 'apply', confirmed: true, trustPublisher: true })
    expect(calls).toBe(1); finish(receipt); await running
    expect(store.get(pluginStaticImportAtom).preview?.receipt).toEqual(receipt)
  })
  test('When 预览或写入期间切换工作区 Then 迟到结果不覆盖新工作区，失败也保留上次回执', async () => {
    const store = createStore(); let finish!: (value: StaticImportPreview) => void
    const api: PluginStaticImportApi = { list: async () => [], preview: () => new Promise(resolve => { finish = resolve }), apply: async () => { throw new Error('fixture error') }, undo: async () => receipt }
    store.set(pluginStaticImportAtom, { workspaceId: 'workspace-a', plans: [], preview: null, busy: false, error: null })
    const running = store.set(runStaticImportActionAtom, { api, kind: 'preview', planHash: preview.planHash })
    expect(store.get(pluginStaticImportAtom).busy).toBe(true)
    store.set(pluginStaticImportAtom, state => ({ ...state, workspaceId: 'workspace-b', preview: null }))
    finish(preview); await running
    expect(store.get(pluginStaticImportAtom).preview).toBeNull()
    store.set(pluginStaticImportAtom, state => ({ ...state, workspaceId: 'workspace-a', preview: { ...preview, receipt } }))
    await store.set(runStaticImportActionAtom, { api, kind: 'apply', confirmed: true })
    expect(store.get(pluginStaticImportAtom).preview?.receipt).toEqual(receipt)
    expect(store.get(pluginStaticImportAtom).error).toBeTruthy()
  })
})
