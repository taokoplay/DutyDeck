import { expect, test } from 'bun:test'
import { createAgentRunIdentity } from '../agent-run-identity'
import { assertPluginRunModule, createPluginRunBinding } from './plugin-run-binding'

test('Given 准备阶段尚无代次 When 编排器准入后绑定 Then 使用真实 generation 且旧运行不继承新代次', () => {
  const binding = createPluginRunBinding('session-1')
  expect(() => binding.current()).toThrow('PLUGIN_RUN_NOT_BOUND')
  const first = createAgentRunIdentity('session-1', 8, () => true)
  binding.bind(first)
  expect(binding.current().runId).toBe('session-1:8')
  expect(binding.current().signal).toBe(first.signal)
  first.abort()
  expect(() => binding.current()).toThrow()
  expect(() => binding.bind(createAgentRunIdentity('session-1', 9, () => true))).toThrow('PLUGIN_RUN_ALREADY_BOUND')
})

test('Given 不同会话运行 When 尝试绑定 Then 明确拒绝而不恢复 Date.now 身份', () => {
  const binding = createPluginRunBinding('session-1')
  expect(() => binding.bind(createAgentRunIdentity('other', 1, () => true))).toThrow('PLUGIN_RUN_IDENTITY_INVALID')
})

test('Given 本条消息显式选择模块 When 绑定本轮身份 Then 可以执行但不继承到其它轮或不同包', () => {
  const module = { moduleId: 'acme.echo.assistant', moduleVersion: '1.0.0', packageHash: 'a'.repeat(64), explicit: true }
  const binding = createPluginRunBinding('explicit-session', [module])
  const identity = createAgentRunIdentity('explicit-session', 5, () => true)
  binding.bind(identity)
  const policy = { mode: 'available' as const, pinnedModuleIds: [], revision: 1, updatedAt: 0, enabledModuleIds: [], disabledModuleIds: [] }
  expect(() => assertPluginRunModule('explicit-session', 'explicit-session:5', module, policy)).not.toThrow()
  expect(() => assertPluginRunModule('explicit-session', 'explicit-session:6', module, policy)).toThrow()
  expect(() => assertPluginRunModule('explicit-session', 'explicit-session:5', { ...module, packageHash: 'b'.repeat(64) }, policy)).toThrow()
  expect(() => assertPluginRunModule('explicit-session', 'explicit-session:5', module, { ...policy, disabledModuleIds: [module.moduleId] })).toThrow()
  identity.abort()
  expect(() => assertPluginRunModule('explicit-session', 'explicit-session:5', module, policy)).toThrow()
})
