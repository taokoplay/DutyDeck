import { expect, test } from 'bun:test'
import { isPluginModuleAttached } from './plugin-session-access'

const module = { moduleId: 'acme.echo.assistant', moduleVersion: '2.0.0', packageHash: 'b'.repeat(64) }

test('Given 会话仍附着旧包 When 新包请求 Surface 写入 Then 拒绝直到重新接入精确身份', () => {
  const policy = { mode: 'available' as const, pinnedModuleIds: [], revision: 1, updatedAt: 0, enabledModuleIds: [module.moduleId], disabledModuleIds: [], moduleBindings: [{ ...module, moduleVersion: '1.0.0', packageHash: 'a'.repeat(64) }] }
  expect(isPluginModuleAttached(module, policy)).toBe(false)
  expect(isPluginModuleAttached(module, { ...policy, moduleBindings: [module] })).toBe(true)
  expect(isPluginModuleAttached(module, { ...policy, moduleBindings: [module], disabledModuleIds: [module.moduleId] })).toBe(false)
  expect(isPluginModuleAttached(module, { ...policy, moduleBindings: undefined })).toBe(false)
})
