import { describe, expect, test } from 'bun:test'
import * as React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { Provider, createStore } from 'jotai'
import type { AgentModuleManifest } from '@dutydeck/shared'
import { agentModulesAtom, agentPluginHealthAtom, agentSessionModulePolicyAtomFamily, agentModulePolicyBusyAtomFamily, agentModulePolicyErrorAtomFamily } from '@/atoms/agent-module-atoms'
import { AgentModuleBar } from './AgentModuleBar'

const module: AgentModuleManifest = {
  id: 'canvas', version: '1.0.0', apiVersion: 1, displayName: '画布', description: '创建画布', icon: 'layout-dashboard', scope: 'project',
  contributions: ['surface', 'tool'], skillRefs: [], promptRefs: [], toolRefs: ['canvas.create_node'], artifactTypes: [], surfaceIds: ['canvas'], requiredPermissions: [],
}

describe('Agent 会话模块栏', () => {
  test('显示已启用模块，并以健康状态提示宿主失败', () => {
    const store = createStore()
    store.set(agentModulesAtom, [module])
    store.set(agentPluginHealthAtom, [{ pluginId: 'builtin.canvas', state: 'failed', updatedAt: 1, errorCode: 'AGENT_PLUGIN_HOST_LIFECYCLE_FAILED' }])
    store.set(agentSessionModulePolicyAtomFamily('s1'), { mode: 'pinned', enabledModuleIds: ['canvas'], disabledModuleIds: [], pinnedModuleIds: ['canvas'], revision: 1, updatedAt: 1 })
    const html = renderToStaticMarkup(<Provider store={store}><AgentModuleBar sessionId="s1" /></Provider>)
    expect(html).toContain('aria-pressed="true"')
    expect(html).toContain('画布')
    expect(html).toContain('1 个模块需要处理')
  })

  test('没有策略时模块按钮保持禁用，避免先于 Session 创建写入', () => {
    const store = createStore()
    store.set(agentModulesAtom, [module])
    const html = renderToStaticMarkup(<Provider store={store}><AgentModuleBar sessionId="s2" /></Provider>)
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>/)
  })

  test('策略正在加载时禁止点击，并显示加载反馈', () => {
    const store = createStore()
    store.set(agentModulesAtom, [module])
    store.set(agentSessionModulePolicyAtomFamily('busy'), { mode: 'auto', enabledModuleIds: [], disabledModuleIds: [], pinnedModuleIds: [], revision: 0, updatedAt: 1 })
    store.set(agentModulePolicyBusyAtomFamily('busy'), true)
    const html = renderToStaticMarkup(<Provider store={store}><AgentModuleBar sessionId="busy" /></Provider>)
    expect(html).toContain('正在加载模块')
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>/)
  })

  test('会话策略失败时提供可见重试入口', () => {
    const store = createStore()
    store.set(agentModulePolicyErrorAtomFamily('failed'), '连接失败')
    const html = renderToStaticMarkup(<Provider store={store}><AgentModuleBar sessionId="failed" /></Provider>)
    expect(html).toContain('模块不可用')
    expect(html).toContain('重试模块加载')
    expect(html).not.toContain('disabled=""')
  })

})
