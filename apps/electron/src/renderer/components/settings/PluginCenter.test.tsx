import { describe, expect, it } from 'bun:test'
import * as React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { createStore, Provider } from 'jotai'
import type { AgentModuleManifest } from '@dutydeck/shared'
import { agentModulesAtom, agentModulesLoadedAtom } from '@/atoms/agent-module-atoms'
import { listBuiltinAgentModules } from '../../../main/lib/agent-modules/module-registry'
import { AgentPluginRegistry } from '../../../main/lib/agent-modules/plugin-registry'
import { BuiltinPluginDetail, BuiltinPluginSettings } from './BuiltinPluginSettings'
import { BUILTIN_MODULE_DOCUMENTATION, getBuiltinModuleDocumentation } from './builtin-module-documentation'
import { ContentPluginManager } from './PluginSettings'
import { PluginCenter } from './PluginCenter'
import { PluginCreationGuide } from './PluginCreationGuide'

/** 使用生产注册表构造插件中心的内置目录，避免测试复制模块名称常量。 */
function builtinCatalog(): AgentModuleManifest[] {
  const registry = new AgentPluginRegistry()
  registry.registerBuiltinModules(listBuiltinAgentModules())
  return registry.listModules()
}

describe('插件中心', () => {
  it('Given 内置目录已加载，When 打开插件中心，Then 顶部显示已安装和市场 Tab，并以卡片排列插件', () => {
    const store = createStore()
    store.set(agentModulesAtom, builtinCatalog())
    store.set(agentModulesLoadedAtom, true)
    const html = renderToStaticMarkup(<Provider store={store}><PluginCenter /></Provider>)

    expect(html).toContain('插件中心')
    expect(html).toContain('专业模块需要在发送消息时明确选择')
    expect(html).toContain('已安装')
    expect(html).toContain('市场')
    expect(html).not.toContain('>技能<')
    expect(html).not.toContain('我的插件')
    expect(html).toContain('role="tablist"')
    expect(html).toContain('点击查看详情')
    for (const name of ['交互设计', '影像创作', '画布', '服务器运维', '接口工作台', '编排工厂']) expect(html).toContain(name)
    expect(html).toContain('搜索插件')
    expect(html).toContain('提示词 1 · Skills 2')
    expect((html.match(/role="button"/g) ?? []).length).toBe(6)
  })

  it('Given 选中一个内置模块，When 打开详情，Then 用 Tabs 分开展示说明、提示词、Skills 和权限资源', () => {
    const store = createStore()
    const catalog = builtinCatalog()
    store.set(agentModulesAtom, catalog)
    store.set(agentModulesLoadedAtom, true)
    const html = renderToStaticMarkup(<Provider store={store}><BuiltinPluginDetail moduleId={catalog[0]!.id} /></Provider>)

    expect(html).toContain('简介')
    expect(html).toContain('适用场景')
    expect(html).toContain('使用流程')
    expect(html).toContain('使用前准备')
    expect(html).toContain('模块说明.md')
    expect(html).toContain('aria-label="插件详情内容"')
    for (const tabLabel of ['说明', '提示词', 'Skills', '权限与资源']) expect(html).toContain(`>${tabLabel}</button>`)
    expect((html.match(/data-\[state=inactive\]:hidden/g) ?? []).length).toBe(4)
    expect(html).toContain('aria-label="提示词"')
    expect(html).toContain('aria-label="Skills"')
    expect(html).toContain('权限边界')
    expect(html).toContain('canvas.system.v1')
    expect(html).toContain('当前模块是画布。只有用户明确需要持续复用')
    expect(html).toContain('当前消息明确选择')
    expect(html).toContain('插件标识')
  })

  it('Given 六个内置专业模块，When 查看模块资料，Then 每个模块都有完整的可读说明并覆盖声明资源', () => {
    const catalog = builtinCatalog().filter(module => ['canvas', 'visual-production', 'interaction-design', 'server-ops', 'api-workbench', 'capability-factory'].includes(module.id))
    expect(catalog).toHaveLength(6)
    for (const module of catalog) {
      const documentation = getBuiltinModuleDocumentation(module.id)
      expect(documentation).toBeDefined()
      expect(documentation?.summary.length).toBeGreaterThan(20)
      expect(documentation?.useCases.length).toBeGreaterThan(0)
      expect(documentation?.workflow.length).toBeGreaterThan(0)
      expect(documentation?.requirements.length).toBeGreaterThan(0)
      expect(documentation?.capabilities.length).toBeGreaterThan(0)
      expect(documentation?.artifacts.length).toBeGreaterThan(0)
      expect(documentation?.limitations.length).toBeGreaterThan(0)
      for (const promptRef of module.promptRefs) expect(documentation?.promptDescriptions[promptRef]).toBeDefined()
      for (const skillRef of module.skillRefs) expect(documentation?.skillDescriptions[skillRef]).toBeDefined()
    }
    expect(Object.keys(BUILTIN_MODULE_DOCUMENTATION)).toHaveLength(6)
  })

  it('Given 影像创作详情，When 显示资源说明，Then 用途说明比内部 ID 更容易理解', () => {
    const store = createStore()
    store.set(agentModulesAtom, builtinCatalog())
    store.set(agentModulesLoadedAtom, true)
    const html = renderToStaticMarkup(<Provider store={store}><BuiltinPluginDetail moduleId="visual-production" /></Provider>)

    expect(html).toContain('aria-label="插件 影像创作 详情"')
    expect(html).not.toContain('<h2 id="builtin-plugin-detail-title">影像创作</h2>')
    expect(html).toContain('查看模块说明、实际提示词、Skills 和权限边界。')
    expect(html).toContain('先发现真实模型和配置')
    expect(html).toContain('媒体模型与生成流程')
    expect(html).toContain('生成或编辑图片、视频、语音和音频')
    expect(html).toContain('visual-production.system.v1')
    expect(html).toContain('媒体任务可能产生外部调用或资源消耗')
  })

  it('Given 没有 Skill 的服务器运维模块，When 查看详情，Then 保留明确的空状态和权限限制', () => {
    const store = createStore()
    store.set(agentModulesAtom, builtinCatalog())
    store.set(agentModulesLoadedAtom, true)
    const html = renderToStaticMarkup(<Provider store={store}><BuiltinPluginDetail moduleId="server-ops" /></Provider>)

    expect(html).toContain('该模块未声明 Skill。')
    expect(html).not.toContain('当前项目已安装并启用对应 Skill')
    expect(html).toContain('读取已授权资源清单和连接状态')
    expect(html).toContain('访问已授权的网络或远程资源')
  })

  it('Given 市场尚未配置来源，When 打开市场内容，Then 显示真实空状态并保留本地安装入口', () => {
    const html = renderToStaticMarkup(<Provider><ContentPluginManager mode="market" /></Provider>)

    expect(html).toContain('插件市场')
    expect(html).toContain('市场目录尚未开放')
    expect(html).toContain('从本地包安装 / 更新')
    expect(html).toContain('当前不发起网络请求')
    expect(html).not.toContain('官方推荐')
  })

  it('Given 插件中心，When 打开创建插件，Then 显示脚手架到安装的完整说明', () => {
    const html = renderToStaticMarkup(<Provider><PluginCreationGuide /></Provider>)

    expect(html).toContain('创建你的第一个插件')
    expect(html).toContain('创建插件工程')
    expect(html).toContain('签名打包')
    expect(html).toContain('安装与使用')
    expect(html).toContain('自定义可执行工具、独立 UI 和后台服务暂未开放')
    expect(html).toContain('dutydeck-plugin')
  })

  it('Given 已安装目录，When 输入部分名称搜索，Then 只过滤右侧展示而不改变模块目录来源', () => {
    const store = createStore()
    store.set(agentModulesAtom, builtinCatalog())
    store.set(agentModulesLoadedAtom, true)
    const html = renderToStaticMarkup(<Provider store={store}><BuiltinPluginSettings moduleFilter="交互" /></Provider>)

    expect((html.match(/<article/g) ?? []).length).toBe(1)
    expect(html).toContain('交互设计')
    expect(html).not.toContain('影像创作')
  })
})
