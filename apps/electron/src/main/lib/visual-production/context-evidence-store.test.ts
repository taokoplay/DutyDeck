import { afterEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createVisualContextEvidenceStore } from './context-evidence-store'
import type { VisualContextObservation } from './task-context'

/** 测试目录只保存摘要，不调用模型或写入用户项目。 */
const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })
/** 提供完整来源身份的模型观察。 */
function observation(): VisualContextObservation {
  return { version: 1, id: 'o1', workspaceId: 'w1', sessionId: 's1', runId: 'r1', contextId: 'c1', productionId: 'p1', productionRevision: 1, scopeKey: 'a'.repeat(64), target: { kind: 'production' }, objective: '检查', conclusion: '颜色一致', unchecked: ['声音'], evidence: [{ evidenceId: 'e1', mediaId: 'm1', mediaHash: 'a'.repeat(64), kind: 'image', unchecked: [] }], createdAt: 1 }
}
describe('视觉结论持久化', () => {
  test('Given检查记录达到预算 When继续追加 Then明确拒绝且完整保留旧结论', () => {
    const root = mkdtempSync(join(tmpdir(), 'visual-observations-')); roots.push(root)
    const store = createVisualContextEvidenceStore(root, () => {})
    for (let index = 0; index < 100; index++) store.append({ ...observation(), id: `o${index}` })
    expect(() => store.append({ ...observation(), id: 'overflow' })).toThrow('VISUAL_CONTEXT_EVIDENCE_LIMIT')
    expect(store.list('p1', 'a'.repeat(64))).toHaveLength(4)
    const oldFile = join(root, '.dutydeck', 'visual-production', 'projects', 'p1', 'visual-observations', 'a'.repeat(64), 'r1.json')
    const before = readFileSync(oldFile, 'utf8')
    expect(JSON.parse(before)).toHaveLength(100)
    store.append({ ...observation(), id: 'next', runId: 'r2' })
    expect(readFileSync(oldFile, 'utf8')).toBe(before)
    expect(store.list('p1', 'a'.repeat(64))[0]?.id).toBe('next')
  })
  test('Given空项目 When只读 Then不创建目录；写入后重建存储仍可追溯', () => {
    const root = mkdtempSync(join(tmpdir(), 'visual-observations-')); roots.push(root)
    const store = createVisualContextEvidenceStore(root, () => {})
    expect(store.list('p1', 'a'.repeat(64))).toEqual([])
    expect(existsSync(join(root, '.dutydeck'))).toBe(false)
    store.append(observation())
    expect(createVisualContextEvidenceStore(root, () => {}).list('p1', 'a'.repeat(64))).toEqual([observation()])
    expect(JSON.stringify(store.list('p1', 'a'.repeat(64)))).not.toContain('base64')
  })
  test('Given归属失效或链接目录 When存储 Then拒绝写出项目边界', () => {
    const root = mkdtempSync(join(tmpdir(), 'visual-observations-')); roots.push(root)
    expect(() => createVisualContextEvidenceStore(root, () => { throw new Error('changed') }).append(observation())).toThrow('changed')
    symlinkSync(tmpdir(), join(root, '.dutydeck'))
    expect(() => createVisualContextEvidenceStore(root, () => {}).append(observation())).toThrow('不安全')
  })
})

test('Given并行B追加四条 When按A运行查询 Then不被B覆盖且路径和索引严格校验', () => {
  const root = mkdtempSync(join(tmpdir(), 'visual-observations-')); roots.push(root)
  const store = createVisualContextEvidenceStore(root, () => {})
  const scope = 'a'.repeat(64)
  store.append({ ...observation(), runId: 'A', id: 'A-result' })
  for (let index = 0; index < 4; index++) store.append({ ...observation(), runId: 'B', id: `B-${index}` })
  expect(store.list('p1', scope, 'A').map(item => item.id)).toEqual(['A-result'])
  expect(store.list('p1', scope).map(item => item.id)).toEqual(['B-3', 'B-2', 'B-1', 'B-0'])
  expect(() => store.list('p1', '../bad')).toThrow('INVALID_SCOPE')
  expect(() => store.list('p1', scope, '../bad')).toThrow()
  const directory = join(root, '.dutydeck', 'visual-production', 'projects', 'p1', 'visual-observations', scope)
  writeFileSync(join(directory, 'runs.index.json'), JSON.stringify(['../outside']))
  expect(() => store.list('p1', scope)).toThrow('INDEX_CORRUPT')
})

test('Given分片正文身份或索引被篡改 When读取 Then拒绝跨范围并保留原文件', () => {
  const root = mkdtempSync(join(tmpdir(), 'visual-observations-')); roots.push(root)
  const store = createVisualContextEvidenceStore(root, () => {})
  const scope = 'a'.repeat(64)
  store.append(observation())
  const directory = join(root, '.dutydeck', 'visual-production', 'projects', 'p1', 'visual-observations', scope)
  writeFileSync(join(directory, 'r1.json'), JSON.stringify([{ ...observation(), scopeKey: 'b'.repeat(64) }]))
  expect(() => store.list('p1', scope, 'r1')).toThrow('EVIDENCE_CORRUPT')
  writeFileSync(join(directory, 'runs.index.json'), JSON.stringify(['r1', 'r1']))
  expect(() => store.list('p1', scope)).toThrow('INDEX_CORRUPT')
  expect(() => store.append({ ...observation(), scopeKey: 'abc' })).toThrow('INVALID_SCOPE')
  expect(() => store.append({ ...observation(), runId: 'runs.index' })).toThrow()
})
