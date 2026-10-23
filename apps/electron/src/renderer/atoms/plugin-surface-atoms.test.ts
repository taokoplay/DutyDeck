import { describe, expect, test } from 'bun:test'
import { forgetPluginSurface, rememberPluginSurface, type PluginSurfaceInstance } from './plugin-surface-atoms'

/** 构造一个已打开的插件 Surface。 */
function instance(): PluginSurfaceInstance {
  return {
    sessionId: 'session-1',
    moduleId: 'acme.echo.assistant',
    tabId: 'plugin:acme.echo:workspace',
    surfaceId: 'workspace',
    title: 'Echo',
    token: 'token-1',
    sourceUrl: 'dutydeck-plugin://token-1/surfaces/workspace/index.html',
    readOnly: false,
  }
}

describe('Given plugin Surface renderer state', () => {
  test('When 打开同 tab 新 token Then 替换旧实例', () => {
    const first = rememberPluginSurface({}, instance())
    const second = rememberPluginSurface(first, { ...instance(), token: 'token-2' })
    expect(second['plugin:acme.echo:workspace']?.token).toBe('token-2')
  })

  test('When 关闭 tab Then 删除实例', () => {
    const opened = rememberPluginSurface({}, instance())
    expect(forgetPluginSurface(opened, 'plugin:acme.echo:workspace')).toEqual({})
  })
})
