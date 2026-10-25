import { describe, expect, test } from 'bun:test'
import { isPluginHostApiCompatible } from '../src/index.js'

describe('Given 插件 Host API 版本范围', () => {
  test('When 宿主满足 caret 与比较范围 Then 接受', () => {
    expect(isPluginHostApiCompatible('^1.0.0', '1.4.2')).toBe(true)
    expect(isPluginHostApiCompatible('>=1.0.0 <2.0.0', '1.9.9')).toBe(true)
    expect(isPluginHostApiCompatible('~1.2.0', '1.2.9')).toBe(true)
  })

  test('When 宿主超出主版本或比较范围 Then 拒绝', () => {
    expect(isPluginHostApiCompatible('^1.0.0', '2.0.0')).toBe(false)
    expect(isPluginHostApiCompatible('~1.2.0', '1.3.0')).toBe(false)
    expect(isPluginHostApiCompatible('>=2.0.0', '1.9.9')).toBe(false)
  })

  test('When 范围格式无效 Then fail closed', () => {
    expect(isPluginHostApiCompatible('latest', '1.0.0')).toBe(false)
    expect(isPluginHostApiCompatible('^1.0', '1.0.0')).toBe(false)
    expect(isPluginHostApiCompatible('^1.0.0 ||', '1.0.0')).toBe(false)
  })
})
