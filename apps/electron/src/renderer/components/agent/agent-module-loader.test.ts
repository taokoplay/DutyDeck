import { describe, expect, test } from 'bun:test'
import { createStore } from 'jotai'
import type { AgentSessionModuleCatalog, AgentSessionModulePolicy, AgentSessionModulePolicyUpdateInput } from '@dutydeck/shared'
import {
  agentModulesAtom, agentModulesLoadedAtom, agentModulesLoadingAtom, agentModulesErrorAtom,
  agentSessionModulePolicyAtomFamily, agentModulePolicyBusyAtomFamily, agentModulePolicyErrorAtomFamily, agentSessionModuleCatalogAtomFamily, agentSessionModuleCatalogErrorAtomFamily,
} from '@/atoms/agent-module-atoms'
import { attachAgentModule, detachAgentModule, loadAgentModuleCatalog, loadAgentModulePolicy, loadAgentSessionModuleCatalog, toggleAgentModule, type AgentModuleLoaderAPI } from './agent-module-loader'

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
  test('Given 旧目录请求未完成，When 插件变更强制刷新，Then 旧返回不能覆盖新快照', async () => {
    const store = createStore()
    const pending = deferred<Awaited<ReturnType<AgentModuleLoaderAPI['getAgentModules']>>>()
    const first = loadAgentModuleCatalog(store, api({ getAgentModules: () => pending.promise }))
    await loadAgentModuleCatalog(store, api(), true)
    pending.resolve([{ id: 'stale' } as Awaited<ReturnType<AgentModuleLoaderAPI['getAgentModules']>>[number]])
    await first
    expect(store.get(agentModulesAtom)).toEqual([])
    expect(store.get(agentModulesLoadingAtom)).toBe(false)
    expect(store.get(agentModulesLoadedAtom)).toBe(true)
  })

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

  test('Given Session 目录返回可接入模块，When 右侧菜单点击 Then 使用目录 revision 原子接入并更新目录', async () => {
    const store = createStore()
    const catalog: AgentSessionModuleCatalog = {
      sessionId: 'a', revision: 3, policy: { ...policy(), revision: 3 }, entries: [{
        id: 'canvas', displayName: '画布', description: '画布', icon: 'layout', group: '专业工具',
        surfaceId: 'canvas', moduleVersion: '1.0.0', activation: 'session-toggle', state: 'available',
      }],
    }
    let receivedRevision: number | undefined
    const next = { ...catalog, revision: 4, policy: { ...policy(['canvas']), revision: 4 }, entries: [{ ...catalog.entries[0]!, state: 'attached' as const }] }
    const bridge = api({
      getSessionModuleCatalog: async () => catalog,
      toggleSessionModule: async (input) => { receivedRevision = input.expectedRevision; return next },
    })
    await loadAgentSessionModuleCatalog(store, bridge, 'a')
    await attachAgentModule(store, bridge, 'a', 'canvas')
    expect(receivedRevision).toBe(3)
    expect(store.get(agentSessionModuleCatalogAtomFamily('a'))?.entries[0]?.state).toBe('attached')
    const detached = { ...next, revision: 5, policy: { ...policy(), revision: 5 }, entries: [{ ...next.entries[0]!, state: 'available' as const }] }
    const detachBridge = api({ toggleSessionModule: async (input) => { expect(input.enabled).toBe(false); return detached } })
    await detachAgentModule(store, detachBridge, 'a', 'canvas')
    expect(store.get(agentSessionModuleCatalogAtomFamily('a'))?.entries[0]?.state).toBe('available')
  })

  test('Given 目录 revision 已被其他窗口更新 When 右侧接入冲突 Then 自动刷新目录供下一次点击继续', async () => {
    const store = createStore()
    const stale: AgentSessionModuleCatalog = {
      sessionId: 'a', revision: 3, policy: { ...policy(), revision: 3 }, entries: [{
        id: 'canvas', displayName: '画布', description: '画布', icon: 'layout', group: '专业工具',
        surfaceId: 'canvas', moduleVersion: '1.0.0', activation: 'session-toggle', state: 'available',
      }],
    }
    const refreshed: AgentSessionModuleCatalog = {
      ...stale,
      revision: 4,
      policy: { ...policy(), revision: 4 },
    }
    const bridge = api({
      getSessionModuleCatalog: async () => refreshed,
      toggleSessionModule: async () => { throw new Error('AGENT_MODULE_POLICY_REVISION_CONFLICT') },
    })
    store.set(agentSessionModuleCatalogAtomFamily('a'), stale)
    await attachAgentModule(store, bridge, 'a', 'canvas')
    expect(store.get(agentSessionModuleCatalogAtomFamily('a'))?.revision).toBe(4)
    expect(store.get(agentModulePolicyErrorAtomFamily('a'))).toBeNull()
  })

  test('Given 右侧目录读取失败 When 策略仍可读取 Then 目录错误不污染策略错误', async () => {
    const store = createStore()
    await loadAgentSessionModuleCatalog(store, api({ getSessionModuleCatalog: async () => { throw new Error('catalog unavailable') } }), 'a')
    expect(store.get(agentSessionModuleCatalogErrorAtomFamily('a'))).toBe('catalog unavailable')
    expect(store.get(agentModulePolicyErrorAtomFamily('a'))).toBeNull()
    await loadAgentModulePolicy(store, api(), 'a')
    expect(store.get(agentSessionModuleCatalogErrorAtomFamily('a'))).toBe('catalog unavailable')
    expect(store.get(agentModulePolicyErrorAtomFamily('a'))).toBeNull()
  })
})


describe('同会话权威策略的乱序保护', () => {
  test('Given 旧策略读取未完成 When 新目录先返回 Then 旧策略不能回退最新 revision', async () => {
    /** 隔离 store 和可控旧读取。 */
    const store = createStore()
    const pending = deferred<AgentSessionModulePolicy>()
    const loading = loadAgentModulePolicy(store, api({ getSessionModulePolicy: () => pending.promise }), 'a')
    /** 模拟另一个窗口已完成接入后目录刷新得到的新事实。 */
    const latest = { ...policy(['canvas']), revision: 2 }
    await loadAgentSessionModuleCatalog(store, api({ getSessionModuleCatalog: async () => ({ sessionId: 'a', revision: 2, policy: latest, entries: [] }) }), 'a')
    pending.resolve(policy())
    await loading
    expect(store.get(agentSessionModulePolicyAtomFamily('a'))).toEqual(latest)
  })

  test('Given 旧目录读取未完成 When 策略 toggle 先保存 Then 旧目录不得覆盖策略或发布过期目录', async () => {
    /** 旧目录加载不占用策略 busy，因此该交错在现有控制器中真实可达。 */
    const store = createStore()
    store.set(agentSessionModulePolicyAtomFamily('a'), policy())
    const pending = deferred<AgentSessionModuleCatalog>()
    const loading = loadAgentSessionModuleCatalog(store, api({ getSessionModuleCatalog: () => pending.promise }), 'a')
    await toggleAgentModule(store, api(), 'a', 'canvas')
    pending.resolve({ sessionId: 'a', revision: 0, policy: policy(), entries: [] })
    await loading
    expect(store.get(agentSessionModulePolicyAtomFamily('a'))?.revision).toBe(1)
    expect(store.get(agentSessionModulePolicyAtomFamily('a'))?.enabledModuleIds).toEqual(['canvas'])
    expect(store.get(agentSessionModuleCatalogAtomFamily('a'))).toBeNull()
  })

  test('Given 策略保存未完成 When 更新目录已返回 Then 迟到保存响应不能回退策略', async () => {
    /** 保存返回前，另一个窗口可继续提交并由目录刷新带回更新 revision。 */
    const store = createStore()
    store.set(agentSessionModulePolicyAtomFamily('a'), policy())
    const pending = deferred<AgentSessionModulePolicy>()
    const saving = toggleAgentModule(store, api({ setSessionModulePolicy: () => pending.promise }), 'a', 'canvas')
    const latest = { ...policy(['interaction-design']), revision: 2 }
    await loadAgentSessionModuleCatalog(store, api({ getSessionModuleCatalog: async () => ({ sessionId: 'a', revision: 2, policy: latest, entries: [] }) }), 'a')
    pending.resolve({ ...policy(['canvas']), revision: 1 })
    await saving
    expect(store.get(agentSessionModulePolicyAtomFamily('a'))).toEqual(latest)
  })
})


test('Given 旧策略请求稍后失败 When 新目录已发布 Then 失败不得清空并发获得的权威策略', async () => {
  /** 用延迟异常复现不同 IPC 通道交错，不模拟被 busy 锁禁止的 attach。 */
  const store = createStore()
  const pending = deferred<void>()
  const loading = loadAgentModulePolicy(store, api({ getSessionModulePolicy: async () => { await pending.promise; throw new Error('offline') } }), 'a')
  const latest = { ...policy(['canvas']), revision: 2 }
  await loadAgentSessionModuleCatalog(store, api({ getSessionModuleCatalog: async () => ({ sessionId: 'a', revision: 2, policy: latest, entries: [] }) }), 'a')
  pending.resolve()
  await loading
  expect(store.get(agentSessionModulePolicyAtomFamily('a'))).toEqual(latest)
})
