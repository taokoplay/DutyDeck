import { describe, expect, test } from 'bun:test'
import * as React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { parsePluginManifestV3 } from '@dutydeck/plugin-sdk'
import {
  ModuleRuntimePluginSettings,
  PluginVersionHistory,
  RuntimePluginDetailView,
} from './ModuleRuntimePluginSettings'

describe('Given V3 plugin settings', () => {
  test('When 首次渲染 Then 解释安装不自动激活且提供本地安装入口', () => {
    const html = renderToStaticMarkup(<ModuleRuntimePluginSettings />)
    expect(html).toContain('可执行模块插件')
    expect(html).toContain('安装可执行插件')
    expect(html).toContain('仍需在当前会话中激活')
    expect(html).toContain('正在读取可执行插件')
  })

  test('When 展示版本历史 Then 当前版本不可回滚且历史版本提供回滚入口', () => {
    const html = renderToStaticMarkup(
      <PluginVersionHistory
        versions={[
          { version: '1.0.1', packageHash: 'a'.repeat(64), signatureVerified: false },
          { version: '1.0.0', packageHash: 'b'.repeat(64), signatureVerified: false },
        ]}
        currentPackageHash={'a'.repeat(64)}
        busy={false}
        onRollback={() => undefined}
      />,
    )
    expect(html).toContain('正在使用')
    expect(html).toContain('回滚到此版本')
    expect(html).toContain('开发包 · 未签名')
  })

  test('When 查看可执行插件详情 Then 使用与内置插件一致的四类 Tab 和管理动作', () => {
    const parsed = parsePluginManifestV3({
      formatVersion: 3,
      apiVersion: '1.0.0',
      id: 'dutydeck.demo',
      publisherId: 'dutydeck',
      version: '1.0.1',
      displayName: '演示插件',
      description: '演示说明',
      license: 'MIT',
      profile: 'module-runtime',
      compatibility: { hostApi: '^1.0.0', runtimeProtocol: 1, platforms: ['darwin'], architectures: ['arm64'] },
      runtime: { entry: 'runtime/main.mjs', format: 'module-esm' },
      modules: [{
        id: 'workspace', displayName: '演示模块', description: '模块说明', icon: 'package', activation: 'session-toggle',
        skillRefs: [], promptRefs: [], tools: ['inspect'], surfaces: ['workspace'], services: [], artifacts: [],
      }],
      tools: [{
        id: 'inspect', ownerModuleId: 'workspace', title: '检查', description: '检查项目',
        inputSchema: { type: 'object', properties: {}, additionalProperties: false },
        annotations: { readOnly: true, destructive: false, idempotent: true, openWorld: false },
        approval: 'none', timeoutMs: 1000,
      }],
      surfaces: [{
        id: 'workspace', ownerModuleId: 'workspace', title: '工作区', entry: 'surfaces/workspace/index.html',
        apiVersion: 1, defaultPlacement: 'right-panel', methods: ['load'],
      }],
      services: [], artifacts: [], prompts: [], settings: [],
      capabilities: ['project.files.read'], dependencies: [], exports: [],
    })
    if (!parsed.ok) throw new Error('fixture')
    const html = renderToStaticMarkup(
      <RuntimePluginDetailView
        plugin={{
          manifest: parsed.value,
          packageHash: 'a'.repeat(64),
          enabled: true,
          installedAt: new Date(0).toISOString(),
        }}
        busy={false}
        onRefresh={() => undefined}
        onToggle={() => undefined}
        onVersions={() => undefined}
        onUninstall={() => undefined}
      />,
    )
    for (const label of ['说明', '工具', 'Surface 与服务', '权限与版本']) expect(html).toContain(`>${label}</button>`)
    expect(html).toContain('检查')
    expect(html).toContain('project.files.read')
    expect(html).toContain('停用插件')
    expect(html).toContain('版本历史')
    expect(html).toContain('卸载')
    expect(html).not.toContain('尚未安装可执行模块插件')
  })
})
