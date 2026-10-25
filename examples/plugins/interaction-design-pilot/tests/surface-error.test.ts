import { describe, expect, test } from 'bun:test'
import { surfaceErrorMessage } from '../src/surface-error'

describe('Given 交互设计 Surface 错误提示', () => {
  test('When 模块只读 Then 引导关闭并重新接入而不是静默失败', () => {
    expect(surfaceErrorMessage(new Error('PLUGIN_CAPABILITY_READ_ONLY'), '创建失败')).toContain('重新接入')
  })

  test('When 项目或产物版本失效 Then 给出具体恢复动作', () => {
    expect(surfaceErrorMessage(new Error('PLUGIN_PROJECT_UNAVAILABLE'), '创建失败')).toContain('绑定项目')
    expect(surfaceErrorMessage(new Error('PLUGIN_ARTIFACT_REVISION_CONFLICT'), '创建失败')).toContain('刷新')
  })

  test('When 只有通用 Surface 错误 Then 保留操作上下文并可重试', () => {
    const message = surfaceErrorMessage(new Error('PLUGIN_SURFACE_FAILED'), '创建失败')
    expect(message).toContain('创建失败')
    expect(message).toContain('重新接入')
  })
})
