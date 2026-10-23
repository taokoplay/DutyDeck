import { describe, expect, test } from 'bun:test'
import * as React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { ModuleRuntimePluginSettings } from './ModuleRuntimePluginSettings'

describe('Given V3 plugin settings', () => {
  test('When 首次渲染 Then 解释安装不自动激活且提供本地安装入口', () => {
    const html = renderToStaticMarkup(<ModuleRuntimePluginSettings />)
    expect(html).toContain('可执行模块插件')
    expect(html).toContain('安装可执行插件')
    expect(html).toContain('仍需在当前会话中激活')
    expect(html).toContain('正在读取可执行插件')
  })
})
