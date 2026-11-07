import { describe, expect, test } from 'bun:test'
import { assertPluginCapabilityPolicy, composePluginApprovalPolicy } from './plugin-runtime-policy'

describe('Given 插件与既有工具审批组合', () => {
  test('When 媒体策略 automatic Then 插件 per-call 仍逐次询问而媒体保持原策略', () => {
    const policy = composePluginApprovalPolicy(['plugin_echo'], [{ toolNames: ['media_execute'], toolApprovalPolicy: { getMode: () => 'automatic', subscribe: () => () => undefined } }])
    expect(policy.getMode('plugin_echo')).toBe('ask')
    expect(policy.getMode('plugin_echo')).toBe('ask')
    expect(policy.getMode('media_execute')).toBe('automatic')
    expect(policy.getMode('unknown')).toBe('ask')
  })
  test('When 同名策略冲突 Then 更严格的 ask 优先', () => {
    const policy = composePluginApprovalPolicy([], [
      { toolNames: ['shared'], toolApprovalPolicy: { getMode: () => 'automatic', subscribe: () => () => undefined } },
      { toolNames: ['shared'], toolApprovalPolicy: { getMode: () => 'ask', subscribe: () => () => undefined } },
    ])
    expect(policy.getMode('shared')).toBe('ask')
  })
  test('When Surface 只读 Then 写入与迁移均拒绝，读取仍允许', () => {
    expect(() => assertPluginCapabilityPolicy('artifact.migrate', true)).toThrow('PLUGIN_CAPABILITY_READ_ONLY')
    expect(() => assertPluginCapabilityPolicy('artifact.write', true)).toThrow('PLUGIN_CAPABILITY_READ_ONLY')
    expect(() => assertPluginCapabilityPolicy('plugin.state.write', true)).toThrow('PLUGIN_CAPABILITY_READ_ONLY')
    expect(() => assertPluginCapabilityPolicy('artifact.read', true)).not.toThrow()
  })
})
