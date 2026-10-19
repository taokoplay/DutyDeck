import { describe, expect, test } from 'bun:test'
import * as React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { createStore, Provider } from 'jotai'
import { currentAgentSessionIdAtom } from '@/atoms/agent-atoms'
import { clearWorkspaceToolRequestAtom, requestWorkspaceToolAtom } from '@/atoms/workspace-tools'
import { WorkspaceToolReceipt } from './WorkspaceToolReceipt'

describe('动态工具可见回执', () => {
  test('Given 请求已发起 When 渲染和导航取消 Then 显示状态及原入口重试按钮', () => {
    /** 独立 store 保证回执不依赖真实 Electron 资源。 */
    const store = createStore()
    store.set(currentAgentSessionIdAtom, 'session-a')
    store.set(requestWorkspaceToolAtom, { sessionId: 'session-a', tool: 'browser' })
    /** 每次从同一个会话状态渲染，检查消费外的可见回执。 */
    const render = () => renderToStaticMarkup(<Provider store={store}><WorkspaceToolReceipt sessionId="session-a" /></Provider>)
    expect(render()).toContain('正在打开浏览器')
    expect(render()).toContain('role="status"')
    store.set(clearWorkspaceToolRequestAtom)
    expect(render()).toContain('已取消打开')
    expect(render()).toContain('重新打开浏览器')
    expect(renderToStaticMarkup(<Provider store={store}><WorkspaceToolReceipt sessionId="session-b" /></Provider>)).toBe('')
  })
})
