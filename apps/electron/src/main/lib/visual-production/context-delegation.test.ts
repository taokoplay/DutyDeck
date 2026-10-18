import { describe, expect, test } from 'bun:test'
import { createVisualContextDelegation } from './context-delegation'
import type { HeadlessAgentRunCallbacks } from '../agent-headless-runner-registry'
import type { AgentRunExtensions } from '../agent-run-extensions'

/** 构造可观察真实终态、撤销和权限的最小宿主。 */
function fixture(terminalMissing = false) {
  let active = true
  let callbacks: HeadlessAgentRunCallbacks | undefined
  let extensions: AgentRunExtensions | undefined
  const stopped: string[] = []
  let disposed = false
  const delegation = createVisualContextDelegation({
    parentSessionId: 'parent', workspaceId: 'workspace', channelId: 'channel', modelId: 'model',
    assertActive: () => { if (!active) throw new Error('scope revoked') },
    assertContext: async (id) => { if (id !== 'scope' || !active) throw new Error('scope revoked') },
    createSession: () => 'child',
    createTools: async () => ({ tools: [], policy: { runId: 'child-run', initialContextId: 'child-scope' }, prompt: 'frozen scope', hasObservation: () => true, dispose: () => { disposed = true } }),
    run: async (_input, cb, ext) => { callbacks = cb; extensions = ext; if (!terminalMissing) await new Promise<void>(() => {}) },
    stop: (id) => { stopped.push(id) },
  })
  return { delegation, stopped, revoke: () => { active = false }, callbacks: () => callbacks!, extensions: () => extensions!, disposed: () => disposed }
}

describe('影像受限子任务', () => {
  test('Given运行已返回但未提供终态 When查询 Then明确失败而非永久显示运行中', async () => {
    const f = fixture(true)
    const receipt = await f.delegation.start('scope', '检查')
    await Promise.resolve()
    expect((await f.delegation.read(receipt.id)).status).toBe('failed')
    expect(f.disposed()).toBe(true)
  })
  test('Given 固定范围 When 委派 Then 禁用普通工具与Skills且不继承父会话历史', async () => {
    const f = fixture()
    const receipt = await f.delegation.start('scope', '检查角色一致性')
    expect(receipt.status).toBe('running')
    expect(f.extensions().allowedToolNamesMode).toBe('replace')
    expect(f.extensions().allowedToolNames).toEqual([])
    expect(f.extensions().skillsMode).toBe('disabled')
    f.callbacks().onComplete([], { status: 'completed', stoppedByUser: false, startedAt: 1, resultSubtype: 'success' })
    expect((await f.delegation.read(receipt.id)).status).toBe('completed')
    expect(f.disposed()).toBe(true)
  })

  test('Given 子任务返回错误终态但没有onError When 读取回执 Then 不宣称成功', async () => {
    const f = fixture()
    const receipt = await f.delegation.start('scope', '检查')
    f.callbacks().onComplete([], { status: 'errored', stoppedByUser: false, startedAt: 1, resultErrors: ['budget'], resultSubtype: 'error_during_execution' })
    const result = await f.delegation.read(receipt.id)
    expect(result.status).toBe('failed')
    expect(result.error).toContain('budget')
  })

  test('Given 父范围已撤销 When 子任务迟到完成 Then 不能读取或复用旧授权', async () => {
    const f = fixture()
    const receipt = await f.delegation.start('scope', '检查')
    f.revoke()
    f.delegation.dispose()
    f.callbacks().onComplete([], { status: 'completed', stoppedByUser: false, startedAt: 1, resultSubtype: 'success' })
    expect(f.stopped).toEqual(['child'])
    expect(f.disposed()).toBe(true)
    await expect(f.delegation.read(receipt.id)).rejects.toThrow()
    expect(() => f.extensions().beforeToolCall?.('visual_production_inspect_media', {})).toThrow()
  })
})
