import { expect, test } from 'bun:test'
import * as React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { createStore, Provider } from 'jotai'
import { agentWorkspacesAtom, currentAgentWorkspaceIdAtom } from '@/atoms/agent-atoms'
import { LibTvSettings } from './LibTvSettings'

test('Given 尚未选择工作区 When 打开 LibTV Then 展示空态、禁用连接并明确 MCP 权限范围', () => {
  const html = renderToStaticMarkup(<Provider store={createStore()}><LibTvSettings /></Provider>)
  expect(html).toContain('请先选择工作区')
  expect(html).toContain('disabled=""')
  expect(html).toContain('LibTV 积分')
  expect(html).toContain('Agent 的 MCP 权限')
  expect(html).not.toContain('每次确认')
  expect(html).not.toContain('自动授权')
})

test('Given 选择工作区 B When 页面首次渲染 Then 显示 B 且不把未读取配置称为已连接', () => {
  const store = createStore()
  store.set(agentWorkspacesAtom, [{ id: 'b', slug: 'workspace-b', name: '工作区 B', createdAt: 1, updatedAt: 1 }])
  store.set(currentAgentWorkspaceIdAtom, 'b')
  const html = renderToStaticMarkup(<Provider store={store}><LibTvSettings navigation={<span>媒体导航</span>} /></Provider>)
  expect(html).toContain('工作区 B')
  expect(html).toContain('媒体导航')
  expect(html).toContain('尚未读取配置')
  expect(html).not.toContain('已连接')
})
