import { describe, expect, test } from 'bun:test'
import * as React from 'react'
import { createStore, Provider } from 'jotai'
import { renderToStaticMarkup } from 'react-dom/server'
import { allPendingExitPlanRequestsAtom } from '@/atoms/agent-atoms'
import { ExitPlanModeBanner } from './ExitPlanModeBanner'

describe('计划审批预览入口', () => {
  test('Given 审批绑定文档 When 展示横幅 Then 明示文件并提供查看计划', () => {
    const store = createStore()
    store.set(allPendingExitPlanRequestsAtom, new Map([['s', [{
      requestId: 'r', sessionId: 's', toolInput: {}, allowedPrompts: [],
      planDocument: { filePath: '/workbench/plan/方案.md', displayName: '方案.md', contentHash: 'a'.repeat(64) },
    }]]]))
    const html = renderToStaticMarkup(<Provider store={store}><ExitPlanModeBanner sessionId="s" onStop={() => undefined} /></Provider>)
    expect(html).toContain('查看计划')
    expect(html).toContain('方案.md')
  })
  test('Given 无请求 When 展示 Then 不占用空间', () => {
    expect(renderToStaticMarkup(<Provider store={createStore()}><ExitPlanModeBanner sessionId="s" onStop={() => undefined} /></Provider>)).toBe('')
  })
})
