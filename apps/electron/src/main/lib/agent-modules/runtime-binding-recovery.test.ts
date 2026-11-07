import { describe, expect, test } from 'bun:test'
import { normalizeAgentSessionModulePolicy, type AgentModuleManifest } from '@dutydeck/shared'
import { resolveActiveModuleContext, resolveActiveModuleIds } from './module-skill-resolver'
import { projectAgentSessionModuleEntries } from './session-module-catalog-projection'
const runtime: AgentModuleManifest & { runtimeKind: 'module-runtime' } = {
  id: 'acme.runtime.main', version: '1.0.0', apiVersion: 1, displayName: 'Runtime', description: '自有fixture', icon: 'box', scope: 'project',
  contributions: ['surface', 'tool'], skillRefs: [], promptRefs: [], toolRefs: ['echo'], artifactTypes: [], surfaceIds: ['plugin:acme.runtime:workspace'], requiredPermissions: [],
  activation: 'session-toggle', source: 'installed', pluginId: 'acme.runtime', packageHash: 'a'.repeat(64), runtimeKind: 'module-runtime',
}
const policy = normalizeAgentSessionModulePolicy({ enabledModuleIds: [runtime.id], pinnedModuleIds: [runtime.id] })
describe('Given 旧会话缺少V3精确包绑定', () => {
  test('When 投影/prepare解析 Then 显示重新接入且排除运行和提示注入', () => {
    expect(projectAgentSessionModuleEntries([runtime], policy)[0]).toMatchObject({ state: 'available', reason: '可执行插件缺少精确包绑定，请重新接入' })
    expect(resolveActiveModuleIds({ sessionId: 's', policy }, [runtime])).toEqual([])
    const context = resolveActiveModuleContext({ sessionId: 's', policy }, { listModules: () => [runtime] })
    expect(context.modules).toEqual([])
    expect(context.unavailable).toEqual([{ moduleId: runtime.id, reason: 'AGENT_MODULE_IDENTITY_CHANGED' }])
  })
  test('When 用户明确选择本轮或重新绑定 Then 本轮可选但不改变旧策略', () => {
    expect(resolveActiveModuleIds({ sessionId: 's', policy, explicitModuleIds: [runtime.id] }, [runtime])).toEqual([runtime.id])
    const attached = { ...policy, moduleBindings: [{ moduleId: runtime.id, moduleVersion: runtime.version, packageHash: runtime.packageHash }] }
    expect(resolveActiveModuleIds({ sessionId: 's', policy: attached }, [runtime])).toEqual([runtime.id])
    expect(projectAgentSessionModuleEntries([runtime], attached)[0]?.state).toBe('attached')
    expect(policy.moduleBindings?.length ?? 0).toBe(0)
  })
  test('When 内置模块或纯内容合同 Then 不扩大本次V3迁移门禁', () => {
    const { runtimeKind: _runtimeKind, ...content } = runtime
    expect(resolveActiveModuleIds({ sessionId: 's', policy }, [content])).toEqual([content.id])
  })
})
