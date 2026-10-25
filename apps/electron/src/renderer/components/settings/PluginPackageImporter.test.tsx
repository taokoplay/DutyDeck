import { describe, expect, test } from 'bun:test'
import * as React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { PluginImportSuccess, PluginImportWaitingNotice } from './PluginPackageImporter'

describe('Given 插件导入成功状态', () => {
  test('When 显示安装结果 Then 包含类型、固定版本和会话启用提示', () => {
    const html = renderToStaticMarkup(
      <PluginImportSuccess
        result={{ kind: 'runtime', displayName: '交互设计插件试点', version: '1.0.1' }}
      />,
    )
    expect(html).toContain('已安装')
    expect(html).toContain('可执行模块插件')
    expect(html).toContain('交互设计插件试点')
    expect(html).toContain('v1.0.1')
    expect(html).toContain('仍需在当前会话中启用')
  })

  test('When Agent 忙碌 Then 明确自动等待且不暴露原始 IPC 错误', () => {
    const html = renderToStaticMarkup(<PluginImportWaitingNotice />)
    expect(html).toContain('Agent 正在运行')
    expect(html).toContain('自动安装')
    expect(html).toContain('不会打断')
    expect(html).not.toContain('invoking remote method')
    expect(html).not.toContain('AGENT_BUSY')
  })
})
