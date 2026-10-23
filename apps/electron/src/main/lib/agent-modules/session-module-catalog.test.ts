import { describe, expect, test } from 'bun:test'
import type { AgentModuleManifest, AgentSessionModulePolicy } from '@dutydeck/shared'
import type { AgentPluginRegistry } from './plugin-registry'
import { buildNextSessionModulePolicy } from './module-policy'
import { toggleAgentSessionModule } from './session-module-catalog'
import { projectAgentSessionModuleEntries } from './session-module-catalog-projection'

const policy: AgentSessionModulePolicy = {
  mode: 'auto', enabledModuleIds: ['canvas'], disabledModuleIds: [], pinnedModuleIds: [], revision: 4, updatedAt: 1,
}

function module(overrides: Partial<AgentModuleManifest> = {}): AgentModuleManifest {
  return {
    id: 'canvas', version: '1.0.0', apiVersion: 1, displayName: '画布', description: '画布', icon: 'layout',
    scope: 'project', contributions: ['surface'], skillRefs: [], promptRefs: [], toolRefs: [], artifactTypes: [],
    surfaceIds: ['canvas'], requiredPermissions: [], activation: 'session-toggle', source: 'builtin', ...overrides,
  }
}

describe('Session 模块右侧目录投影', () => {
  test('Given 已接入模块 When 投影目录 Then 保留面板身份和 attached 状态', () => {
    expect(projectAgentSessionModuleEntries([module()], policy)).toEqual([expect.objectContaining({
      id: 'canvas', surfaceId: 'canvas', state: 'attached', group: '专业工具', moduleVersion: '1.0.0',
    })])
  })

  test('Given 纯内容模块或未知面板 When 投影目录 Then 不伪造右侧入口', () => {
    const entries = projectAgentSessionModuleEntries([
      module({ id: 'notes', surfaceIds: [], source: 'installed', pluginId: 'notes' }),
      module({ id: 'unknown', surfaceIds: ['custom-panel'], source: 'installed', pluginId: 'custom' }),
    ], policy)
    expect(entries).toEqual([])
  })

  test('Given V3 动态 Surface When 投影目录 Then 保留 plugin 前缀供通用宿主渲染', () => {
    expect(projectAgentSessionModuleEntries([
      module({ id: 'acme.echo.assistant', surfaceIds: ['plugin:acme.echo:workspace'], source: 'installed', pluginId: 'acme.echo' }),
    ], policy)).toEqual([expect.objectContaining({
      id: 'acme.echo.assistant',
      surfaceId: 'plugin:acme.echo:workspace',
      group: '插件工具',
    })])
  })

  test('Given 旧清单缺少 session-toggle When 投影目录 Then 显示不可用并说明必须显式选择', () => {
    expect(projectAgentSessionModuleEntries([module({ id: 'legacy', activation: undefined })], policy)).toEqual([expect.objectContaining({
      state: 'unavailable', reason: '该模块仍需在消息中明确选择',
    })])
  })

  test('Given Session 模块版本已变化 When 投影目录 Then 保留可接入动作并提示重新接入', () => {
    expect(projectAgentSessionModuleEntries([module({ version: '2.0.0' })], {
      ...policy,
      moduleBindings: [{ moduleId: 'canvas', moduleVersion: '1.0.0' }],
    })).toEqual([expect.objectContaining({
      state: 'available', reason: '模块版本或包身份已变化，请重新接入',
    })])
  })

  test('Given Session 模块已禁用 When 投影目录 Then 仍允许从右侧菜单重新接入', () => {
    expect(projectAgentSessionModuleEntries([module()], {
      ...policy,
      enabledModuleIds: [],
      disabledModuleIds: ['canvas'],
      pinnedModuleIds: [],
    })).toEqual([expect.objectContaining({
      state: 'available', reason: '模块已被当前会话禁用，请重新接入',
    })])
  })

  test('Given 模块不存在或仍是 message-explicit When 右侧尝试接入 Then 主进程拒绝改变 Session 策略', () => {
    const missingRegistry = { getModule: () => undefined, listModules: () => [] } as unknown as AgentPluginRegistry
    const store = { get: () => policy, update: () => policy }
    expect(() => toggleAgentSessionModule({ sessionId: 's', moduleId: 'missing', enabled: true }, missingRegistry, store, 10)).toThrow('AGENT_MODULE_NOT_AVAILABLE')

    const explicit = module({ activation: 'message-explicit' })
    const explicitRegistry = { getModule: () => explicit, listModules: () => [explicit] } as unknown as AgentPluginRegistry
    expect(() => toggleAgentSessionModule({ sessionId: 's', moduleId: 'canvas', enabled: true }, explicitRegistry, store, 10)).toThrow('AGENT_MODULE_SESSION_TOGGLE_UNSUPPORTED')
  })

  test('Given 右侧目录 revision 已过期 When 接入模块 Then 以 CAS 拒绝写入', () => {
    const manifest = module()
    const registry = { getModule: () => manifest, listModules: () => [manifest] } as unknown as AgentPluginRegistry
    const store = { get: () => ({ ...policy, revision: 4 }), update: () => policy }
    expect(() => toggleAgentSessionModule({ sessionId: 's', moduleId: 'canvas', enabled: true, expectedRevision: 3 }, registry, store, 10)).toThrow('AGENT_MODULE_POLICY_REVISION_CONFLICT')
  })

  test('Given 合法 session-toggle 模块 When 右侧接入 Then 写入版本与包身份绑定并返回 attached 目录', () => {
    const manifest = module({ packageHash: 'a'.repeat(64) })
    const registry = { getModule: () => manifest, listModules: () => [manifest] } as unknown as AgentPluginRegistry
    let stored = policy
    const store = {
      get: () => stored,
      update: (_sessionId: string, requested: Partial<AgentSessionModulePolicy>, options?: { expectedRevision?: number; now?: number }) => {
        stored = buildNextSessionModulePolicy(stored, requested, options)
        return stored
      },
    }
    const result = toggleAgentSessionModule({ sessionId: 's', moduleId: 'canvas', enabled: true, expectedRevision: 4 }, registry, store, 10)
    expect(result.policy.moduleBindings).toEqual([{ moduleId: 'canvas', moduleVersion: '1.0.0', packageHash: 'a'.repeat(64) }])
    expect(result.entries).toEqual([expect.objectContaining({ id: 'canvas', state: 'attached', packageHash: 'a'.repeat(64) })])
  })
})
