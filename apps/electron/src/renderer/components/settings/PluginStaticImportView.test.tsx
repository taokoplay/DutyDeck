import { describe, expect, test } from 'bun:test'
import * as React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { Provider, createStore } from 'jotai'
import { pluginStaticImportAtom, type StaticImportState } from '@/atoms/plugin-static-import-atoms'
import { PluginStaticImportView } from './PluginStaticImportView'

function render(state: Partial<StaticImportState>): string {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'window')
  Object.defineProperty(globalThis, 'window', { configurable: true, value: { electronAPI: { pluginStaticImport: {} } } })
  try {
    const store = createStore()
    store.set(pluginStaticImportAtom, { workspaceId: null, plans: null, preview: null, busy: false, error: null, ...state })
    return renderToStaticMarkup(<Provider store={store}><PluginStaticImportView /></Provider>)
  } finally {
    if (descriptor) Object.defineProperty(globalThis, 'window', descriptor)
    else Reflect.deleteProperty(globalThis, 'window')
  }
}
describe('Given 固定配方列表状态', () => {
  test('When 未加载或读取失败 Then 不伪装成空配方且提供重试入口', () => {
    const loading = render({ busy: true })
    expect(loading).not.toContain('当前没有已登记的生产配方')
    const failed = render({ error: '读取失败' })
    expect(failed).not.toContain('当前没有已登记的生产配方')
    expect(failed).toContain('重新读取配方')
    expect(render({ plans: [] })).toContain('当前没有已登记的生产配方')
  })
})
