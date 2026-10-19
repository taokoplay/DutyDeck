import { describe, expect, test } from 'bun:test'
import { moduleCommandStatusLabel } from './AgentModuleCommandReceipt'

describe('模块命令回执', () => {
  test('状态文案能区分排队、运行、完成和失败', () => {
    expect(moduleCommandStatusLabel('queued')).toContain('排队')
    expect(moduleCommandStatusLabel('running')).toContain('执行')
    expect(moduleCommandStatusLabel('applied')).toContain('完成')
    expect(moduleCommandStatusLabel('failed')).toContain('失败')
  })
})
