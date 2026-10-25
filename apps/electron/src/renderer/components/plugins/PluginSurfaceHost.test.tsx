import { describe, expect, test } from 'bun:test'
import * as React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { isPluginSurfaceReadyMessage, pluginSurfaceBridgeErrorCode, PluginSurfaceHost } from './PluginSurfaceHost'

describe('Given plugin Surface host', () => {
  test('When 渲染 Surface Then iframe 使用脚本沙箱且不授予同源', () => {
    const html = renderToStaticMarkup(
      <PluginSurfaceHost
        title="Echo"
        sourceUrl="dutydeck-plugin://acme.echo/surfaces/workspace/index.html?token=test"
        onBridgeRequest={async () => ({ ok: true })}
      />,
    )
    expect(html).toContain('sandbox="allow-scripts"')
    expect(html).not.toContain('allow-same-origin')
    expect(html).toContain('title="Echo"')
    expect(html).toContain('dutydeck-plugin://acme.echo/surfaces/workspace/index.html?token=test')
  })

  test('When 缺少入口 Then 显示可行动错误而不是空白 iframe', () => {
    const html = renderToStaticMarkup(
      <PluginSurfaceHost title="Echo" sourceUrl="" onBridgeRequest={async () => ({ ok: true })} />,
    )
    expect(html).toContain('PLUGIN_SURFACE_ENTRY_MISSING')
    expect(html).not.toContain('<iframe')
  })

  test('When Surface 主动请求连接 Then 只接受精确 ready 消息', () => {
    expect(isPluginSurfaceReadyMessage({ type: 'dutydeck.plugin.surface.ready' })).toBe(true)
    expect(isPluginSurfaceReadyMessage({ type: 'dutydeck.plugin.surface.ready', extra: true })).toBe(false)
    expect(isPluginSurfaceReadyMessage({ type: 'other' })).toBe(false)
  })

  test('When 只读模块 Surface 打开 Then 明确提示需要重新接入', () => {
    const html = renderToStaticMarkup(
      <PluginSurfaceHost
        title="交互设计试点"
        sourceUrl="dutydeck-plugin://acme.echo/surfaces/workspace/index.html?token=test"
        readOnly
        onBridgeRequest={async () => ({ ok: true })}
      />,
    )
    expect(html).toContain('当前会话尚未启用交互设计试点')
    expect(html).toContain('关闭此标签')
  })

  test('When IPC 包装能力错误 Then 只提取稳定插件错误码', () => {
    expect(pluginSurfaceBridgeErrorCode(
      new Error("Error invoking remote method 'module-runtime-plugin:invoke-surface': Error: PLUGIN_CAPABILITY_READ_ONLY"),
    )).toBe('PLUGIN_CAPABILITY_READ_ONLY')
    expect(pluginSurfaceBridgeErrorCode(new Error('/private/secret/path'))).toBe('PLUGIN_SURFACE_BRIDGE_DENIED')
  })
})
