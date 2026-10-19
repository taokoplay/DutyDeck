import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, test } from 'bun:test'
import { assertPiBranchBinding, readPiArtifactSnapshot } from './pi-artifact-reconciliation'

const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })

function writeFixture(): string {
  const root = mkdtempSync(join(tmpdir(), 'dutydeck-pi-artifact-'))
  roots.push(root)
  const path = join(root, 'session.jsonl')
  writeFileSync(path, [
    JSON.stringify({ type: 'session', version: 3, id: 'pi-1', timestamp: new Date(0).toISOString(), cwd: root }),
    JSON.stringify({ type: 'message', id: 'entry-1', parentId: null, timestamp: new Date(1000).toISOString(), message: { role: 'user' } }),
    JSON.stringify({ type: 'message', id: 'orphan', parentId: 'entry-1', timestamp: new Date(2000).toISOString(), message: { role: 'assistant' } }),
    JSON.stringify({ type: 'message', id: 'entry-2', parentId: 'entry-1', timestamp: new Date(3000).toISOString(), message: { role: 'assistant' } }),
  ].join('\n') + '\n')
  return path
}

describe('Pi artifact branch reconciliation', () => {
  test('读取真实 artifact 时只沿叶节点父链计算当前 branch，并生成文件摘要', () => {
    const snapshot = readPiArtifactSnapshot(writeFixture())
    expect(snapshot.sessionId).toBe('pi-1')
    expect(snapshot.branchEntryIds).toEqual(['entry-1', 'entry-2'])
    expect(snapshot.branchTipId).toBe('entry-2')
    expect(snapshot.artifactSha256).toMatch(/^[a-f0-9]{64}$/)
  })

  test('entry binding 不在当前 branch 或 tip 不一致时拒绝', () => {
    const branch = [
      { type: 'message', id: 'entry-1', parentId: null },
      { type: 'message', id: 'entry-2', parentId: 'entry-1' },
    ] as const
    expect(() => assertPiBranchBinding({ actualSessionId: 'pi-1', branch, entryBindings: { a: 'orphan' } })).toThrow('PI_ARTIFACT_ENTRY_NOT_IN_BRANCH')
    expect(() => assertPiBranchBinding({ actualSessionId: 'pi-1', branch, entryBindings: {}, expectedBranchTipId: 'orphan' })).toThrow('PI_ARTIFACT_BRANCH_TIP_MISMATCH')
    expect(() => assertPiBranchBinding({ expectedSessionId: 'pi-2', actualSessionId: 'pi-1', branch, entryBindings: {} })).toThrow('PI_ARTIFACT_SESSION_MISMATCH')
  })
})

/** 损坏的树形记录必须有限时间内拒绝，不能挂住恢复界面。 */
test('Given 重复 entry 或父链循环 When 读取 artifact Then 稳定拒绝', () => {
  const path = writeFixture()
  const header = JSON.stringify({ type: 'session', id: 'pi-1' })
  const entry = { type: 'message', id: 'e1', parentId: null, message: { role: 'user' } }
  writeFileSync(path, [header, JSON.stringify(entry), JSON.stringify(entry)].join('\n') + '\n')
  expect(() => readPiArtifactSnapshot(path)).toThrow('PI_ARTIFACT_ENTRY_DUPLICATE')
  writeFileSync(path, [header, JSON.stringify({ ...entry, parentId: 'e2' }), JSON.stringify({ ...entry, id: 'e2', parentId: 'e1' })].join('\n') + '\n')
  expect(() => readPiArtifactSnapshot(path)).toThrow('PI_ARTIFACT_BRANCH_CYCLE')
})
