import { afterEach, describe, expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AgentRunJournalStore } from './agent-run-journal'
import { AgentRunRecoveryService } from './agent-run-recovery'
import { readPiArtifactSnapshot } from './pi-artifact-reconciliation'

/** 每个用例有独立数据根，结束时只移除本用例产生的临时文件。 */
const roots: string[] = []
afterEach(() => { roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true })) })

/** 写入真实可核验的展示/ artifact 字节，网络和执行由明确注入的宿主回调替代。 */
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'dutydeck-run-recovery-'))
  roots.push(root)
  const displayPath = join(root, 's1.messages.jsonl')
  const piPath = join(root, 'pi.jsonl')
  const line = JSON.stringify({ uuid: 'user-1', type: 'user', message: { role: 'user', content: '任务' } })
  writeFileSync(displayPath, `${line}\n`)
  writeFileSync(piPath, `${JSON.stringify({ type: 'session', id: 'pi-1' })}\n${JSON.stringify({ type: 'message', id: 'entry-1', parentId: null, message: { role: 'user' } })}\n`)
  const snapshot = readPiArtifactSnapshot(piPath)
  const options = { resolvePath: (id: string) => join(root, `${id}.journal.jsonl`), resolveDisplayPath: () => displayPath }
  const journal = new AgentRunJournalStore(options)
  journal.append({ sessionId: 's1', runId: 'r1', branchId: 'pi-1', eventType: 'user_turn', payload: { userMessageUuid: 'user-1' } })
  journal.append({ sessionId: 's1', runId: 'r1', branchId: 'pi-1', eventType: 'checkpoint', factBinding: {
    display: { byteOffset: 0, byteLength: Buffer.byteLength(`${line}\n`), messages: [{ uuid: 'user-1', sha256: createHash('sha256').update(line).digest('hex') }] },
    pi: { sessionId: 'pi-1', sessionFile: piPath, branchTipId: snapshot.branchTipId, artifactSha256: snapshot.artifactSha256, entryBindings: { 'user-1': 'entry-1' } },
  } })
  let busy = false
  let staleContext = false
  const service = new AgentRunRecoveryService({ journal, isBusy: () => busy, getSession: () => ({ sdkSessionId: 'pi-1', piSessionFile: piPath }), validateContinuation: (expected) => { expect(expected.artifactSha256).toBe(readPiArtifactSnapshot(piPath).artifactSha256) }, assertContextCurrent: () => { if (staleContext) throw new Error('AGENT_RUN_RECOVERY_CONTEXT_CHANGED') } })
  const input = { sessionId: 's1', runId: 'r1', branchId: 'pi-1', lastSequence: 2, operation: 'continue' as const }
  return { service, journal, options, input, piPath, setBusy: (value: boolean) => { busy = value }, setStaleContext: () => { staleContext = true } }
}

describe('精确运行恢复', () => {
  for (const sequences of [[2, 1], [1, 1]]) {
    test(`Given 损坏序列 ${sequences.join(',')} When 放弃并重启读取 Then 原始前缀保留且仅终结目标运行`, () => {
      /** 直接构造历史序列损坏，模拟旧版本写入或外部损坏。 */
      const { service, journal, options, input } = fixture()
      const corrupted = journal.read('s1').map((event, index) => ({ ...event, sequence: sequences[index]! }))
      const path = options.resolvePath('s1')
      writeFileSync(path, corrupted.map((event) => JSON.stringify(event)).join('\n') + '\n')
      journal.append({ sessionId: 's1', runId: 'r2', branchId: 'pi-1', eventType: 'user_turn' })
      const prefix = readFileSync(path)
      expect(service.list('s1').find((plan) => plan.runId === 'r1')?.action).toBe('abandon')
      expect(service.apply({ ...input, operation: 'abandon' }, async () => { throw new Error('不应执行') })).toEqual({ runId: 'r1', status: 'abandoned' })
      expect(readFileSync(path).subarray(0, prefix.length)).toEqual(prefix)
      const restarted = new AgentRunJournalStore(options)
      expect(restarted.scanRecovery('s1').map((plan) => plan.runId)).toEqual(['r2'])
      /** 合法放弃回执不能隐藏该运行后来产生的新事实。 */
      restarted.append({ sessionId: 's1', runId: 'r1', branchId: 'pi-1', eventType: 'checkpoint' })
      expect(new AgentRunJournalStore(options).scanRecovery('s1').map((plan) => plan.runId)).toContain('r1')
    })
  }

  test('Given 伪造或复制旧放弃回执 When 扫描 Then 不能遮蔽未核验事实', () => {
    const { service, journal, options, input } = fixture()
    service.apply({ ...input, operation: 'abandon' }, async () => {})
    /** 复制合法旧回执到新事件之后，摘要仍只覆盖更早的前缀。 */
    const receipt = journal.read('s1').at(-1)!
    journal.append({ sessionId: 's1', runId: 'r1', branchId: 'pi-1', eventType: 'checkpoint' })
    journal.append({ sessionId: 's1', runId: 'r1', branchId: 'pi-1', eventType: 'run_stopped', payload: receipt.payload })
    expect(new AgentRunJournalStore(options).scanRecovery('s1')[0]?.action).toBe('abandon')
    /** 即使序列连续且声称放弃，没有完整绑定也不能被当作有效终态。 */
    journal.append({ sessionId: 's1', runId: 'r2', branchId: 'pi-1', eventType: 'run_stopped', payload: { reason: 'recovery_abandoned', previousEventCount: 0, previousEventsSha256: 'forged' } })
    expect(new AgentRunJournalStore(options).scanRecovery('s1').map((plan) => plan.runId)).toEqual(['r1', 'r2'])
  })

  test('Given 放弃回调期间新增运行事实 When 写终止回执 Then 拒绝旧快照且保留恢复计划', () => {
    /** 注入取消回调中的新事实，验证取消与日志追加之间的版本窗口。 */
    const { journal, input } = fixture()
    const service = new AgentRunRecoveryService({
      journal, isBusy: () => false, getSession: () => null,
      validateContinuation: () => {}, assertContextCurrent: () => {},
      onAbandon: () => { journal.append({ sessionId: 's1', runId: 'r1', branchId: 'pi-1', eventType: 'checkpoint' }) },
    })
    expect(() => service.apply({ ...input, operation: 'abandon' }, async () => {})).toThrow('AGENT_RUN_RECOVERY_STALE')
    expect(journal.read('s1').some((event) => event.payload.reason === 'recovery_abandoned')).toBe(false)
    expect(journal.scanRecovery('s1').map((plan) => plan.runId)).toEqual(['r1'])
  })

  test('Given 事实完整 When 连续点击恢复并重启读取 Then 只领取一次且不新增 user_turn', async () => {
    const { service, journal, input, options } = fixture()
    let starts = 0
    expect(service.list('s1')[0]?.availableActions).toEqual(['continue', 'abandon'])
    expect(service.apply(input, async (context) => { starts += 1; expect(context.runId).toBe('r1') })).toEqual({ runId: 'r1', status: 'accepted' })
    expect(() => service.apply(input, async () => { starts += 1 })).toThrow('AGENT_RUN_RECOVERY_BUSY')
    await Promise.resolve()
    await Promise.resolve()
    expect(starts).toBe(1)
    expect(journal.read('s1').filter((event) => event.eventType === 'user_turn')).toHaveLength(1)
    expect(new AgentRunJournalStore(options).read('s1').at(-1)?.payload.stage).toBe('recovery-claimed')
    expect(service.list('s1')[0]?.availableActions).toEqual(['abandon'])
  })

  test('Given 旧 UI 版本或另一个会话的 run When 操作 Then 拒绝且没有执行', () => {
    const { service, input, journal } = fixture()
    expect(() => service.apply({ ...input, lastSequence: 1 }, async () => {})).toThrow('AGENT_RUN_RECOVERY_STALE')
    expect(() => service.apply({ ...input, sessionId: 'other' }, async () => {})).toThrow('AGENT_RUN_RECOVERY_STALE')
    expect(journal.read('s1')).toHaveLength(2)
  })

  test('Given 活动运行或变更的模块策略 When 恢复 Then 阻断', () => {
    const { service, input, setBusy, setStaleContext } = fixture()
    setBusy(true)
    expect(service.list('s1')).toEqual([])
    expect(() => service.apply(input, async () => {})).toThrow('AGENT_RUN_RECOVERY_BUSY')
    setBusy(false)
    setStaleContext()
    expect(service.list('s1')[0]?.availableActions).toEqual(['abandon'])
    expect(() => service.apply(input, async () => {})).toThrow('AGENT_RUN_RECOVERY_CONTEXT_CHANGED')
  })

  test('Given artifact 已变化或未确认工具 When 检查 Then 只允许保留记录并放弃', () => {
    const { service, input, piPath } = fixture()
    writeFileSync(piPath, '{}\n')
    expect(service.list('s1')[0]?.availableActions).toEqual(['abandon'])
    expect(() => service.apply(input, async () => {})).toThrow('AGENT_RUN_RECOVERY_UNCONFIRMED')
    expect(service.apply({ ...input, operation: 'abandon' }, async () => {})).toEqual({ runId: 'r1', status: 'abandoned' })
    expect(service.list('s1')).toEqual([])
  })

  test('Given 两个中断运行 When 放弃指定 run Then 只终结目标且不触发执行回调', () => {
    const { service, journal, input } = fixture()
    journal.append({ sessionId: 's1', runId: 'r2', branchId: 'pi-1', eventType: 'user_turn' })
    service.apply({ ...input, operation: 'abandon' }, async () => { throw new Error('不应启动') })
    expect(journal.scanRecovery('s1').map((plan) => plan.runId)).toEqual(['r2'])
  })
})
