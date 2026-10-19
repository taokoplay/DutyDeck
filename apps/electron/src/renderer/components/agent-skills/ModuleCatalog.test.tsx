import { describe, expect, test } from 'bun:test'
import * as React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import type { AgentModuleManifest, AgentPluginHealth } from '@dutydeck/shared'
import { ModuleCatalog } from './ModuleCatalog'

const module: AgentModuleManifest = {
  id: 'canvas', version: '1.2.3', apiVersion: 1, displayName: '画布', description: '创建画布产物', icon: 'layout-dashboard', scope: 'project', source: 'builtin', pluginId: 'builtin.canvas',
  contributions: ['surface', 'skill', 'tool'], skillRefs: ['canvas-production'], promptRefs: ['canvas.system.v1'], toolRefs: ['canvas.create_node'], artifactTypes: ['canvas.document'], surfaceIds: ['canvas'], requiredPermissions: ['project.files.write'],
}

describe('Agent 模块目录', () => {
  test('显示模块合同、版本、来源和宿主健康状态', () => {
    const health: AgentPluginHealth[] = [{ pluginId: 'builtin.canvas', state: 'failed', updatedAt: 1, errorCode: 'AGENT_PLUGIN_HOST_LIFECYCLE_FAILED' }]
    const html = renderToStaticMarkup(<ModuleCatalog initialModules={[module]} initialHealth={health} />)
    expect(html).toContain('Agent 模块')
    expect(html).toContain('内置 · v1.2.3')
    expect(html).toContain('启动失败')
    expect(html).toContain('查看模块合同')
    expect(html).toContain('project.files.write')
  })

  test('空目录显示可理解的空状态', () => {
    expect(renderToStaticMarkup(<ModuleCatalog initialModules={[]} initialHealth={[]} />)).toContain('暂无可用模块')
  })

  test('尚未读取目录时显示加载态，不误报为空目录', () => {
    const html = renderToStaticMarkup(<ModuleCatalog />)
    expect(html).toContain('正在加载模块目录')
    expect(html).not.toContain('暂无可用模块')
  })

  test('安装插件按真实 pluginId 匹配健康状态', () => {
    const html = renderToStaticMarkup(<ModuleCatalog initialModules={[{ ...module, source: 'installed', pluginId: 'vendor.canvas' }]} initialHealth={[{ pluginId: 'vendor.canvas', state: 'failed', updatedAt: 1 }]} />)
    expect(html).toContain('已安装 · v1.2.3')
    expect(html).toContain('启动失败')
  })

  test('Given 已安装插件目录 When 展示 Then 提供预览安装、显式刷新和卸载确认入口', () => {
    const html = renderToStaticMarkup(<ModuleCatalog initialModules={[{ ...module, source: 'installed', pluginId: 'vendor.canvas' }]} initialHealth={[]} />)
    expect(html).toContain('安装本地插件')
    expect(html).toContain('刷新插件目录')
    expect(html).toContain('卸载插件')
    expect(html).not.toContain('确认卸载')
    expect(html).not.toContain('确认安装')
  })

  test('Given 已加载插件含非阻断警告 When 展示目录 Then 警告与来源都可见', () => {
    const html = renderToStaticMarkup(<ModuleCatalog initialModules={[module]} initialHealth={[]} initialCatalog={{ modules: [module], refreshedAt: 1, diagnostics: [{ pluginId: 'vendor.plugin', path: '/managed/plugin.json', status: 'loaded', warnings: ['未知声明被忽略'] }] }} />)
    expect(html).toContain('vendor.plugin 警告')
    expect(html).toContain('未知声明被忽略')
  })

  test('Given 当前项目 Skill 列表 When 展示依赖 Then 分别标识可用禁用与缺失', () => {
    const withDependencies = { ...module, skillRefs: ['ready', 'disabled', 'missing'] }
    const html = renderToStaticMarkup(<ModuleCatalog initialModules={[withDependencies]} initialHealth={[]} workspaceSlug="project-a" loadedWorkspaceSlug="project-a" skills={[{ slug: 'ready', name: '已安装', enabled: true }, { slug: 'disabled', name: '已禁用', enabled: false }]} />)
    expect(html).toContain('ready：可用')
    expect(html).toContain('disabled：已禁用（调用将被阻断）')
    expect(html).toContain('missing：缺失（调用将被阻断）')
  })

  test('Given 未选择项目 When 展示依赖 Then 要求选择项目而不误报缺失', () => {
    const html = renderToStaticMarkup(<ModuleCatalog initialModules={[module]} initialHealth={[]} />)
    expect(html).toContain('需选择项目后检查')
    expect(html).not.toContain('缺失（调用将被阻断）')
  })

  test('Given 切换项目但旧 Skill 快照仍在 When 展示依赖 Then 不借用旧项目可用状态', () => {
    const html = renderToStaticMarkup(<ModuleCatalog initialModules={[module]} initialHealth={[]} workspaceSlug="new" loadedWorkspaceSlug="old" skills={[{ slug: 'canvas-production', name: '画布', enabled: true }]} />)
    expect(html).toContain('当前项目数据尚未就绪')
    expect(html).not.toContain('canvas-production：可用')
  })

})
