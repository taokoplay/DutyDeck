import { describe, expect, test } from 'bun:test'
import { createStore } from 'jotai'
import type { AgentSessionModulePolicy, AgentSessionModulePolicyUpdateInput } from '@dutydeck/shared'
import {
  agentModulesLoadedAtom, agentModulesLoadingAtom, agentModulesErrorAtom,
  agentSessionModulePolicyAtomFamily, agentModulePolicyBusyAtomFamily, agentModulePolicyErrorAtomFamily,
} from '@/atoms/agent-module-atoms'
import { loadAgentModuleCatalog, loadAgentModulePolicy, toggleAgentModule, type AgentModuleLoaderAPI } from './agent-module-loader'

/** 构造可独立修改的会话策略夹具。 */
function policy(enabled: string[] = []): AgentSessionModulePolicy {
  return { mode: 'auto', enabledModuleIds: enabled, disabledModuleIds: [], pinnedModuleIds: [], revision: 0, updatedAt: 1 }
}

/** 可控完成时机，用于模拟跨会话 IPC 乱序返回。 */
function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => { resolve = done })
  return { promise, resolve }
}

/** 默认只提供策略/目录 API，测试不具备发消息或执行 Skill 的入口。 */
function api(overrides: Partial<AgentModuleLoaderAPI> = {}): AgentModuleLoaderAPI {
  return {
    getAgentModules: async () => [], getAgentPluginHealth: async () => [],
    getSessionModulePolicy: async () => policy(),
    setSessionModulePolicy: async (input) => ({ ...policy(), ...input.policy, revision: 1 }),
    ...overrides,
  }
}

describe('模块栏实际使用的加载与保存控制器', () => {
  test('Given 首次加载及重复 Effect，When 目录返回，Then 结束 loading 并缓存空目录', async () => {
    const store = createStore()
    const pending = deferred<[]>()
    let calls = 0
    const bridge = api({ getAgentModules: () => { calls++; return pending.promise } })
    const first = loadAgentModuleCatalog(store, bridge)
    expect(store.get(agentModulesLoadingAtom)).toBe(true)
    await loadAgentModuleCatalog(store, bridge)
    expect(calls).toBe(1)
    pending.resolve([])
    await first
    expect(store.get(agentModulesLoadingAtom)).toBe(false)
    expect(store.get(agentModulesLoadedAtom)).toBe(true)
    await loadAgentModuleCatalog(store, bridge)
    expect(calls).toBe(1)
  })

  test('Given 已缓存目录，When 切换到 B 且 A 迟到，Then 两份策略各归原会话', async () => {
    const store = createStore()
    const pending = deferred<AgentSessionModulePolicy>()
    const bridge = api({ getSessionModulePolicy: (id) => id === 'a' ? pending.promise : Promise.resolve(policy(['browser'])) })
    await loadAgentModuleCatalog(store, bridge)
    const first = loadAgentModulePolicy(store, bridge, 'a')
    await loadAgentModulePolicy(store, bridge, 'b')
    pending.resolve(policy(['canvas']))
    await first
    expect(store.get(agentSessionModulePolicyAtomFamily('a'))?.enabledModuleIds).toEqual(['canvas'])
    expect(store.get(agentSessionModulePolicyAtomFamily('b'))?.enabledModuleIds).toEqual(['browser'])
    expect(store.get(agentModulePolicyBusyAtomFamily('a'))).toBe(false)
  })

  test('Given 目录和策略请求失败，When 重试，Then 清理错误并可重新交互', async () => {
    const store = createStore()
    const broken = api({ getAgentModules: async () => { throw new Error('catalog unavailable') }, getSessionModulePolicy: async () => { throw new Error('policy unavailable') } })
    await Promise.all([loadAgentModuleCatalog(store, broken), loadAgentModulePolicy(store, broken, 'a')])
    expect(store.get(agentModulesErrorAtom)).toBe('catalog unavailable')
    expect(store.get(agentModulePolicyErrorAtomFamily('a'))).toBe('policy unavailable')
    expect(store.get(agentModulesLoadingAtom)).toBe(false)
    expect(store.get(agentModulePolicyBusyAtomFamily('a'))).toBe(false)
    await Promise.all([loadAgentModuleCatalog(store, api()), loadAgentModulePolicy(store, api(), 'a')])
    expect(store.get(agentModulesErrorAtom)).toBeNull()
    expect(store.get(agentModulePolicyErrorAtomFamily('a'))).toBeNull()
    expect(store.get(agentSessionModulePolicyAtomFamily('a'))).not.toBeNull()
  })

  test('Given 模块显式禁用，When 启用，Then 只保存策略并移出禁用集合', async () => {
    const store = createStore()
    store.set(agentSessionModulePolicyAtomFamily('a'), { ...policy(), disabledModuleIds: ['canvas', 'browser'] })
    const writes: AgentSessionModulePolicyUpdateInput[] = []
    const bridge = api({ setSessionModulePolicy: async (input) => { writes.push(input); return { ...policy(), ...input.policy, revision: 1 } } })
    await toggleAgentModule(store, bridge, 'a', 'canvas')
    expect(writes).toEqual([{ sessionId: 'a', expectedRevision: 0, policy: { mode: 'pinned', enabledModuleIds: ['canvas'], disabledModuleIds: ['browser'], pinnedModuleIds: ['canvas'] } }])
    await toggleAgentModule(store, bridge, 'a', 'canvas')
    expect(store.get(agentSessionModulePolicyAtomFamily('a'))?.disabledModuleIds).toEqual(['browser', 'canvas'])
    expect(store.get(agentSessionModulePolicyAtomFamily('a'))?.enabledModuleIds).toEqual([])
  })

  test('Given A 保存中切到 B，When A 保存迟到并重复点击，Then B 不被污染且 A 只提交一次', async () => {
    const store = createStore()
    store.set(agentSessionModulePolicyAtomFamily('a'), policy())
    const pending = deferred<AgentSessionModulePolicy>()
    let writes = 0
    const bridge = api({ setSessionModulePolicy: () => { writes++; return pending.promise } })
    const saving = toggleAgentModule(store, bridge, 'a', 'canvas')
    await toggleAgentModule(store, bridge, 'a', 'canvas')
    await loadAgentModulePolicy(store, bridge, 'b')
    pending.resolve({ ...policy(['canvas']), revision: 1 })
    await saving
    expect(writes).toBe(1)
    expect(store.get(agentSessionModulePolicyAtomFamily('a'))?.enabledModuleIds).toEqual(['canvas'])
    expect(store.get(agentSessionModulePolicyAtomFamily('b'))?.enabledModuleIds).toEqual([])
  })

  test('Given 保存失败，When 重试加载持久化策略，Then 错误只影响原会话并恢复可写', async () => {
    const store = createStore()
    store.set(agentSessionModulePolicyAtomFamily('a'), policy())
    await toggleAgentModule(store, api({ setSessionModulePolicy: async () => { throw new Error('revision conflict') } }), 'a', 'canvas')
    expect(store.get(agentModulePolicyErrorAtomFamily('a'))).toBe('revision conflict')
    expect(store.get(agentModulePolicyErrorAtomFamily('b'))).toBeNull()
    expect(store.get(agentModulePolicyBusyAtomFamily('a'))).toBe(false)
    await loadAgentModulePolicy(store, api(), 'a')
    expect(store.get(agentModulePolicyErrorAtomFamily('a'))).toBeNull()
  })
})
