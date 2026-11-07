import { strict as assert } from 'node:assert'
import { createHash } from 'node:crypto'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { PluginRuntimeSupervisor, createPluginRuntimeSnapshot } from '../src/main/lib/agent-plugins/runtime-supervisor'

interface DshLifecycleEvidence {
  inFlightCancellation: boolean
  lateResultRejected: boolean
  crossSessionContext: boolean
  concurrentSessionContext: boolean
  synchronousHardTimeout: boolean
  unresponsiveCancellationExit: boolean
  naturalBlockDurationMs: number
  timeoutExitElapsedMs: number
  cancellationExitElapsedMs: number
}

/** 独立自有fixture：同步阻塞有界10秒，并要求观察到的退出显著早于自然结束。 */
export async function runDshLifecycleSmoke(root: string): Promise<DshLifecycleEvidence> {
  const packageRoot = join(root, 'own-lifecycle-fixture')
  mkdirSync(packageRoot, { recursive: true })
  const source = `export default { activate(host) {
    host.tools.handle('probe', async (input, call) => {
      if (input.mode === 'quick') return { mode: 'quick', sessionId: call.sessionId };
      call.progress({ message: input.mode });
      if (input.mode === 'block') {
        const end = performance.now() + 10000; while (performance.now() < end) {}
        return { mode: 'late-block' };
      }
      await new Promise(resolve => setTimeout(resolve, 150));
      if (input.mode === 'concurrent') return { mode: 'concurrent', sessionId: call.sessionId };
      host.events.emit({ type: 'fixture-late', payload: { aborted: call.signal.aborted } });
      return { mode: 'late-async' };
    });
  } };
`
  writeFileSync(join(packageRoot, 'main.mjs'), source)
  let entered: ((mode: string) => void) | undefined
  let late: ((aborted: boolean) => void) | undefined
  const supervisor = new PluginRuntimeSupervisor({
    invocationTimeoutGraceMs: 300,
    onEvent(event) {
      if (event.type === 'progress') entered?.(String(event.data?.message))
      if (event.type === 'fixture-late') late?.(event.data?.aborted === true)
    },
  })
  const snapshot = createPluginRuntimeSnapshot({
    pluginId: 'fixture.lifecycle', pluginVersion: '1.0.0', packageHash: createHash('sha256').update(source).digest('hex'),
    packageRoot, runtimeEntry: 'main.mjs', tools: ['probe'], surfaces: [], services: [],
    declaredModules: [{ id: 'fixture.lifecycle.probe', version: '1.0.0', activation: 'message-explicit' }], settingsRevision: 0, settings: {},
  })
  const invoke = (mode: string, deadline: number, signal = new AbortController().signal, sessionId = 'fixture-session') => supervisor.invokeTool({
    toolId: 'probe', input: { mode }, signal,
    context: { moduleId: 'fixture.lifecycle.probe', sessionId, projectId: null, runId: `${sessionId}:1`, settingsRevision: 0, settings: {}, deadline },
  })
  const bounded = async <T>(promise: Promise<T>): Promise<T> => {
    let timer: ReturnType<typeof setTimeout> | undefined
    try { return await Promise.race([promise, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('OWN_FIXTURE_WAIT_TIMEOUT')), 5000) })]) }
    finally { clearTimeout(timer) }
  }
  try {
    await supervisor.start(snapshot)
    assert.deepEqual(await invoke('quick', Date.now() + 5000, undefined, 'session-a'), { mode: 'quick', sessionId: 'session-a' })
    assert.deepEqual(await invoke('quick', Date.now() + 5000, undefined, 'session-b'), { mode: 'quick', sessionId: 'session-b' })
    const cancel = new AbortController()
    const started = new Promise<string>(resolve => { entered = resolve })
    const lateResult = new Promise<boolean>(resolve => { late = resolve })
    const cancelled = invoke('async', Date.now() + 5000, cancel.signal).then(() => null, error => error)
    assert.equal(await bounded(started), 'async')
    cancel.abort()
    assert.match(String(await cancelled), /PLUGIN_TOOL_CANCELLED/)
    assert.equal(await bounded(lateResult), true)
    assert.deepEqual(supervisor.listInvocations(), [])
    assert.deepEqual(await invoke('quick', Date.now() + 5000), { mode: 'quick', sessionId: 'fixture-session' })
    const sessions = await Promise.all(['session-a', 'session-b'].map(sessionId =>
      invoke('concurrent', Date.now() + 5000, undefined, sessionId)))
    assert.deepEqual(sessions, [
      { mode: 'concurrent', sessionId: 'session-a' }, { mode: 'concurrent', sessionId: 'session-b' },
    ])
    const blocked = new Promise<string>(resolve => { entered = resolve })
    const timeoutStartedAt = performance.now()
    const timeout = invoke('block', Date.now() + 150).then(() => null, error => error)
    assert.equal(await bounded(blocked), 'block')
    assert.match(String(await timeout), /PLUGIN_RPC_TIMEOUT/)
    assert.equal(supervisor.listHealth()[0]?.state, 'failed', '硬超时必须使仍阻塞的进程退出可调用状态')
    assert.deepEqual(supervisor.listInvocations(), [])
    const waitForExit = async (): Promise<void> => {
      const until = Date.now() + 5000
      while (!supervisor.listHealth()[0]?.errorCode?.startsWith('PLUGIN_RUNTIME_EXITED')) {
        if (Date.now() >= until) throw new Error('OWN_FIXTURE_PROCESS_DID_NOT_EXIT')
        await new Promise(resolve => setTimeout(resolve, 10))
      }
    }
    await waitForExit()
    const timeoutExitElapsedMs = performance.now() - timeoutStartedAt
    assert.ok(timeoutExitElapsedMs < 2500, `超时后退出耗时 ${timeoutExitElapsedMs}ms 必须早于10秒循环自然结束`)
    const priorEpoch = supervisor.listHealth()[0]!.epoch
    await supervisor.start(snapshot)
    assert.ok(supervisor.listHealth()[0]!.epoch > priorEpoch)
    assert.deepEqual(await invoke('quick', Date.now() + 5000), { mode: 'quick', sessionId: 'fixture-session' })
    const blockedAgain = new Promise<string>(resolve => { entered = resolve })
    const blockedCancel = new AbortController()
    const cancellationStartedAt = performance.now()
    const cancelTimeout = invoke('block', Date.now() + 5000, blockedCancel.signal).then(() => null, error => error)
    assert.equal(await bounded(blockedAgain), 'block')
    blockedCancel.abort()
    assert.match(String(await cancelTimeout), /PLUGIN_TOOL_CANCELLED/)
    await waitForExit()
    const cancellationExitElapsedMs = performance.now() - cancellationStartedAt
    assert.ok(cancellationExitElapsedMs < 2500, `取消后退出耗时 ${cancellationExitElapsedMs}ms 必须早于10秒循环自然结束`)
    assert.equal(supervisor.listHealth()[0]?.state, 'failed')
    console.log('[DSH own lifecycle fixture] PASS：取消与迟到结果拒收、并发会话上下文、阻塞自然结束前实际退出', { timeoutExitElapsedMs, cancellationExitElapsedMs })
    return { inFlightCancellation: true, lateResultRejected: true, crossSessionContext: true, concurrentSessionContext: true, synchronousHardTimeout: true, unresponsiveCancellationExit: true, naturalBlockDurationMs: 10000, timeoutExitElapsedMs, cancellationExitElapsedMs }

  } finally { await supervisor.stop() }
}
