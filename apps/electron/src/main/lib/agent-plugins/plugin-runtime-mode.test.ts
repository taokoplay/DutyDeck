import { describe, expect, test } from 'bun:test'
import { resolvePluginRuntimeMode } from './plugin-runtime-mode'

describe('Given 插件运行时环境', () => {
  test('When 源码开发版 Then 始终使用隔离开发根并允许未签名包', () => {
    expect(resolvePluginRuntimeMode({ isPackaged: false, forceDevelopment: false })).toEqual({
      development: true,
      rootDirectory: 'plugin-runtime-v3-development',
    })
  })

  test('When 打包版默认 Then 使用正式根并要求签名', () => {
    expect(resolvePluginRuntimeMode({ isPackaged: true, forceDevelopment: false })).toEqual({
      development: false,
      rootDirectory: 'plugin-runtime-v3',
    })
  })

  test('When 打包版显式开发开关 Then 使用隔离开发根', () => {
    expect(resolvePluginRuntimeMode({ isPackaged: true, forceDevelopment: true })).toEqual({
      development: true,
      rootDirectory: 'plugin-runtime-v3-development',
    })
  })
})
