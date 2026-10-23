import { describe, expect, test } from 'bun:test'
import * as React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { PluginSurfaceHost } from './PluginSurfaceHost'

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
})
