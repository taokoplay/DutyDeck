import { describe, expect, it } from 'bun:test'
import * as React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { createStore, Provider } from 'jotai'
import type { AgentModuleManifest } from '@dutydeck/shared'
import { agentModulesAtom, agentModulesLoadedAtom, agentModulesErrorAtom } from '@/atoms/agent-module-atoms'
import { listBuiltinAgentModules } from '../../../main/lib/agent-modules/module-registry'
import { AgentPluginRegistry } from '../../../main/lib/agent-modules/plugin-registry'
import { PluginSettings } from './PluginSettings'

/** 使用生产注册表赋予可信来源，返回当前宿主目录。 */
function builtinCatalog(): AgentModuleManifest[] {
  const registry = new AgentPluginRegistry()
  registry.registerBuiltinModules(listBuiltinAgentModules())
  return registry.listModules()
}

/** 用隔离 Store 渲染真实页面；仅提取内置区域，避免外部包管理按钮干扰断言。 */
function builtinMarkup(modules: AgentModuleManifest[], loaded = true, error: string | null = null): string {
  const store = createStore()
  store.set(agentModulesAtom, modules)
  store.set(agentModulesLoadedAtom, loaded)
  store.set(agentModulesErrorAtom, error)
  const html = renderToStaticMarkup(<Provider store={store}><PluginSettings /></Provider>)
  return html.match(/<section[^>]*aria-labelledby="builtin-plugins-title"[\s\S]*?<\/section>/)?.[0] ?? ''
}

describe('插件设置入口', () => {
  it('Given 宿主内置目录，When 打开插件管理，Then 显示六个专业模块及资源归属，不提供虚假的开关或卸载', () => {
    const html = builtinMarkup(builtinCatalog())
    for (const name of ['交互设计', '影像创作', '画布', '服务器运维', '接口工作台', '编排工厂']) expect(html).toContain(name)
    expect((html.match(/<article/g) ?? []).length).toBe(6)
    expect(html).toContain('内置 · 随应用更新')
    expect(html).toContain('模块版本 v1.0.0')
    expect(html).toContain('canvas-production')
    expect(html).toContain('canvas.system.v1')
    expect(html).toContain('builtin.canvas')
    expect(html).toContain('未声明 Skill')
    expect(html).toContain('不代表当前项目已加载')
    expect(html).not.toContain('in-app-browser')
    expect(html).not.toContain('terminal.system.v1')
    expect(html).not.toContain('关闭插件')
    expect(html).not.toContain('卸载')
    expect(html).not.toContain('role="switch"')
  })

  it('Given 混合来源目录，When 显示内置区域，Then 不以插件名或缺省来源猜测内置身份', () => {
    const original = builtinCatalog()[0]!
    const html = builtinMarkup([original,
      { ...original, id: 'custom', displayName: '外部同名资源', source: 'installed', pluginId: 'builtin.fake' },
      { ...original, id: 'legacy', displayName: '来源未知资源', source: undefined },
    ])
    expect((html.match(/<article/g) ?? []).length).toBe(1)
    expect(html).not.toContain('外部同名资源')
    expect(html).not.toContain('来源未知资源')
  })

  it('Given 内置目录读取失败，When 渲染页面，Then 提供重试且不伪装为空目录或继续加载', () => {
    const html = builtinMarkup([], false, '目录读取失败')
    expect(html).toContain('role="alert"')
    expect(html).toContain('重试读取内置模块')
    expect(html).not.toContain('正在读取内置模块')
    expect(html).not.toContain('暂无内置专业模块')
  })

  it('Given 目录读取成功但无内置专业模块，When 渲染页面，Then 展示真实空状态', () => {
    expect(builtinMarkup([])).toContain('暂无内置专业模块')
    expect(builtinMarkup([], false)).toContain('正在读取内置模块')
  })

  it('Given 已有目录缓存，When 再次读取失败，Then 保留可查看目录并提示缓存来源', () => {
    const html = builtinMarkup(builtinCatalog(), true, '目录读取失败')
    expect(html).toContain('显示上次读取的目录')
    expect(html).toContain('交互设计')
    expect(html).toContain('role="alert"')
  })

  it('Given 未读取插件目录，When 打开设置，Then 解释显式选择边界并提供真实本地安装入口', () => {
    const html = renderToStaticMarkup(<Provider><PluginSettings /></Provider>)
    expect(html).toContain('从本地包安装 / 更新')
    expect(html).toContain('正在读取插件')
    expect(html).toContain('发送消息时明确选择模块')
    expect(html).toContain('插件市场与团队私有源尚未开放')
    expect(html).not.toContain('尚未安装内容插件')
    expect(html).not.toContain('信任并安装')
  })
})
