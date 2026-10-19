import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, test } from 'bun:test'
import { AgentRunJournalStore } from './agent-run-journal'

const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })

function createStore(): AgentRunJournalStore {
  const root = mkdtempSync(join(tmpdir(), 'dutydeck-journal-'))
  roots.push(root)
  return new AgentRunJournalStore({ resolvePath: (sessionId) => join(root, `${sessionId}.jsonl`), now: () => 100 })
}

describe('Agent Run Journal', () => {
  test('Given utility 进程明确中断 When 写入失败事实 Then 保留恢复计划，普通模型失败仍终结', () => {
    const store = createStore()
    store.append({ sessionId: 's1', runId: 'interrupted', branchId: 'pi-1', eventType: 'run_failed', payload: { recoverableInterruption: true } })
    store.append({ sessionId: 's1', runId: 'failed', branchId: 'pi-1', eventType: 'run_failed', payload: { error: '普通模型失败' } })
    expect(store.scanRecovery('s1').map((plan) => plan.runId)).toEqual(['interrupted'])
  })

  test('Given 两个实例读取同一日志 When 另一个实例追加终态 Then 恢复查询刷新而不保留旧计划', () => {
    /** 两个真实 store 模拟 IPC 查询器与 Agent 编排器。 */
    const root = mkdtempSync(join(tmpdir(), 'dutydeck-journal-refresh-'))
    roots.push(root)
    const options = { resolvePath: (sessionId: string) => join(root, `${sessionId}.jsonl`) }
    const writer = new AgentRunJournalStore(options)
    const reader = new AgentRunJournalStore(options)
    expect(reader.read('s1')).toEqual([])
    writer.append({ sessionId: 's1', runId: 'r1', branchId: 'b1', eventType: 'user_turn' })
    expect(reader.scanRecovery('s1')).toHaveLength(1)
    writer.append({ sessionId: 's1', runId: 'r1', branchId: 'b1', eventType: 'run_completed' })
    expect(reader.scanRecovery('s1')).toEqual([])
    expect(reader.append({ sessionId: 's1', runId: 'r2', branchId: 'b1', eventType: 'user_turn' }).sequence).toBe(1)
    expect(writer.read('s1')).toHaveLength(3)
  })

  test('Given 权限请求 When 同一 requestId 已有授权结果 Then 不继续显示待授权副作用', () => {
    const store = createStore()
    store.append({ sessionId: 's1', runId: 'r1', branchId: 'b1', eventType: 'permission_requested', payload: { requestId: 'p1', replaySafe: false } })
    store.append({ sessionId: 's1', runId: 'r1', branchId: 'b1', eventType: 'permission_resolved', payload: { requestId: 'p1', behavior: 'deny' } })
    expect(store.scanRecovery('s1')[0]?.pendingEventId).toBeUndefined()
  })

  test('Given 只有 Journal 没有实际文件绑定 When 检查恢复 Then 不声称三份事实源已一致', () => {
    const store = createStore()
    store.append({ sessionId: 's1', runId: 'r1', branchId: 'b1', eventType: 'user_turn' })
    expect(store.scanRecovery('s1')[0]?.reconciliation?.status).toBe('incomplete')
  })

  test('事件 sequence 连续且幂等键不重复写副作用', () => {
    const store = createStore()
    const first = store.append({ sessionId: 's1', runId: 'r1', branchId: 'b1', eventType: 'tool_started', idempotencyKey: 'k1', payload: { replaySafe: false } })
    expect(store.append({ sessionId: 's1', runId: 'r1', branchId: 'b1', eventType: 'tool_started', idempotencyKey: 'k1' }).eventId).toBe(first.eventId)
    expect(store.append({ sessionId: 's1', runId: 'r1', branchId: 'b1', eventType: 'checkpoint' }).sequence).toBe(2)
  })

  test('未完成非幂等工具要求用户确认，终态 run 不再恢复', () => {
    const store = createStore()
    store.append({ sessionId: 's1', runId: 'r1', branchId: 'b1', eventType: 'tool_started', payload: { moduleId: 'terminal', capabilityId: 'terminal.exec', replaySafe: false } })
    expect(store.scanRecovery('s1')[0]).toMatchObject({ action: 'confirm', moduleId: 'terminal', capabilityId: 'terminal.exec' })
    store.append({ sessionId: 's1', runId: 'r1', branchId: 'b1', eventType: 'run_stopped' })
    expect(store.scanRecovery('s1')).toEqual([])
  })

  test('幂等工具缺少实际文件绑定时仍须确认，不能只凭 replaySafe 恢复', () => {
    const store = createStore()
    store.append({ sessionId: 's1', runId: 'r1', branchId: 'b1', eventType: 'tool_started', payload: { replaySafe: true } })
    expect(store.scanRecovery('s1')[0]?.action).toBe('confirm')
  })

  test('工具结果通过 parentEventId 闭合工具调用后不再生成恢复计划', () => {
    const store = createStore()
    const started = store.append({ sessionId: 's1', runId: 'r1', branchId: 'b1', eventType: 'tool_started', payload: { replaySafe: false }, idempotencyKey: 'tool:t1:started' })
    store.append({ sessionId: 's1', runId: 'r1', branchId: 'b1', eventType: 'tool_result', parentEventId: started.eventId, payload: { replaySafe: true }, idempotencyKey: 'tool:t1:result' })
    expect(store.scanRecovery('s1')).toHaveLength(1)
    expect(store.scanRecovery('s1')[0]?.action).toBe('confirm')
  })

  test('assistant 已到达但展示 JSONL 尚未提交时禁止自动恢复', () => {
    const store = createStore()
    store.append({
      sessionId: 's1',
      runId: 'r1',
      branchId: 'pi-1',
      eventType: 'assistant_turn',
      payload: { messageUuid: 'assistant-1' },
    })
    const plan = store.scanRecovery('s1')[0]
    expect(plan?.action).toBe('confirm')
    expect(plan?.reconciliation).toMatchObject({ status: 'incomplete' })
  })

  test('展示 JSONL 与 Pi branch 身份不一致时直接放弃自动恢复', () => {
    const store = createStore()
    store.append({
      sessionId: 's1',
      runId: 'r1',
      branchId: 'pi-1',
      eventType: 'checkpoint',
      factBinding: {
        pi: { sessionId: 'pi-2', branchTipId: 'entry-2', entryBindings: { 'assistant-1': 'entry-2' } },
      },
    })
    const plan = store.scanRecovery('s1')[0]
    expect(plan?.action).toBe('abandon')
    expect(plan?.reconciliation).toMatchObject({ status: 'mismatch' })
  })

  test('assistant 与展示回执虽已声明但缺少真实 Pi 文件时不可自动恢复', () => {
    const store = createStore()
    store.append({
      sessionId: 's1',
      runId: 'r1',
      branchId: 'pi-1',
      eventType: 'assistant_turn',
      payload: { messageUuid: 'assistant-1' },
    })
    store.append({
      sessionId: 's1',
      runId: 'r1',
      branchId: 'pi-1',
      eventType: 'checkpoint',
      factBinding: {
        display: { byteOffset: 0, byteLength: 64, messages: [{ uuid: 'assistant-1', sha256: 'a'.repeat(64) }] },
        pi: { sessionId: 'pi-1', branchTipId: 'entry-1', entryBindings: { 'assistant-1': 'entry-1' } },
      },
    })
    const plan = store.scanRecovery('s1')[0]
    expect(plan?.action).toBe('confirm')
    expect(plan?.reconciliation).toMatchObject({ status: 'incomplete' })
  })

  test('恢复时校验展示 JSONL 字节范围和 SHA-256', () => {
    const root = mkdtempSync(join(tmpdir(), 'dutydeck-journal-display-'))
    roots.push(root)
    const line = JSON.stringify({ type: 'assistant', uuid: 'assistant-1', message: { content: [] } })
    const displayPath = join(root, 'messages.jsonl')
    writeFileSync(displayPath, `${line}\n`)
    const store = new AgentRunJournalStore({
      resolvePath: (sessionId) => join(root, `${sessionId}.journal.jsonl`),
      resolveDisplayPath: () => displayPath,
      now: () => 100,
    })
    store.append({
      sessionId: 's1', runId: 'r1', branchId: 'pi-1', eventType: 'assistant_turn', payload: { messageUuid: 'assistant-1' },
    })
    store.append({
      sessionId: 's1', runId: 'r1', branchId: 'pi-1', eventType: 'checkpoint',
      factBinding: {
        display: { byteOffset: 0, byteLength: Buffer.byteLength(`${line}\n`), messages: [{ uuid: 'assistant-1', sha256: createHash('sha256').update(line).digest('hex') }] },
        pi: { sessionId: 'pi-1', entryBindings: {} },
      },
    })
    expect(store.scanRecovery('s1')[0]?.reconciliation?.status).toBe('incomplete')
    writeFileSync(displayPath, `${line.replace('assistant-1', 'assistant-2')}\n`)
    expect(store.scanRecovery('s1')[0]?.action).toBe('abandon')
  })
})
