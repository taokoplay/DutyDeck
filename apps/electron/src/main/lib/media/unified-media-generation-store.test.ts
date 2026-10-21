import { describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { writeJsonFileAtomicSecure } from '../safe-file'
import { UnifiedMediaGenerationStore, mediaIdentityHash, mediaOperationRunId, type StoredMediaGeneration } from './unified-media-generation-store'

/** 独立磁盘夹具，所有输入均为非敏感测试数据。 */
function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'media-store-'))
  const request = { projectId: 'project', operationId: 'operation', modelRef: 'media:audio:minimax:profile:speech', prompt: '你好', inputs: {} }
  const id = mediaOperationRunId('owner', request)
  const record: StoredMediaGeneration = { version: 1, ownerSessionId: 'owner', request, intentHash: mediaIdentityHash(request), routeHash: 'a'.repeat(64), adapterId: 'fake', snapshot: { id, projectId: 'project', modelRef: request.modelRef, mediaKind: 'audio', revision: 0, phase: 'prepared', createdAt: 1, updatedAt: 1, outputs: [], error: null } }
  return { directory, record, store: new UnifiedMediaGenerationStore(directory), cleanup: () => rmSync(directory, { recursive: true, force: true }) }
}

describe('媒体任务持久化边界', () => {
  test('Given 有效记录 When 原子保存与读取 Then 保留数据且拒绝另一会话和路径穿越', () => {
    const { store, record, cleanup } = fixture()
    try {
      store.save(record, null)
      expect(store.load('owner', record.snapshot.id)).toEqual(record)
      expect(() => store.load('other', record.snapshot.id)).toThrow('NOT_OWNED')
      expect(() => store.load('owner', '../escape')).toThrow('NOT_OWNED')
    } finally { cleanup() }
  })

  test('Given 已推进任务 When 陈旧快照或重复创建写入 Then 拒绝覆盖并保留新状态', () => {
    const { store, record, cleanup } = fixture()
    try {
      store.save(record, null)
      store.save({ ...record, snapshot: { ...record.snapshot, revision: 1, phase: 'running' } }, 0)
      expect(() => store.save(record, null)).toThrow('REVISION_CONFLICT')
      expect(() => store.save({ ...record, snapshot: { ...record.snapshot, revision: 1, phase: 'running' } }, 0)).toThrow('REVISION_CONFLICT')
      expect(store.load('owner', record.snapshot.id)?.snapshot.phase).toBe('running')
    } finally { cleanup() }
  })

  test('Given 磁盘任务被破坏 When 懒加载 Then 拒绝损坏而非当新任务处理', () => {
    const { store, record, directory, cleanup } = fixture()
    try {
      store.save(record, null)
      writeJsonFileAtomicSecure(join(directory, `${record.snapshot.id}.json`), { ...record, snapshot: { ...record.snapshot, id: 'wrong-id' } })
      expect(() => store.load('owner', record.snapshot.id)).toThrow('损坏')
    } finally { cleanup() }
  })

  test('Given 远端任务携带额外秘密字段 When 保存 Then 拒绝且无任何落盘内容', () => {
    const { store, record, cleanup } = fixture()
    try {
      const remoteTask = { taskId: 'remote', apiKey: 'must-not-save' }
      expect(() => store.save({ ...record, remoteTask }, null)).toThrow('STORAGE_INVALID')
      expect(store.load('owner', record.snapshot.id)).toBeNull()
    } finally { cleanup() }
  })

  test('Given 快照媒体类型与冻结模型矛盾 When 保存 Then 拒绝伪造恢复记录', () => {
    const { store, record, cleanup } = fixture()
    try {
      expect(() => store.save({ ...record, snapshot: { ...record.snapshot, mediaKind: 'video' } }, null)).toThrow('STORAGE_INVALID')
    } finally { cleanup() }
  })
})

test('Given 另一进程正在更新同一媒体任务 When 保存 Then 独占锁阻止竞争写入', async () => {
  const { store, record, directory, cleanup } = fixture()
  const { acquireMediaFileLock } = await import('./media-file-lock')
  const release = acquireMediaFileLock(join(directory, `${record.snapshot.id}.lock`))
  try { expect(() => store.save(record, null)).toThrow('MEDIA_FILE_BUSY') }
  finally { release(); cleanup() }
})

test('Given 冻结影像绑定已由另一实例保存 When 陈旧记录提交 Then 不得抹去绑定绕过权限', () => {
  const { store, record, cleanup } = fixture()
  try {
    store.save(record, null)
    store.save({ ...record, visualProduction: { productionId: 'production', jobId: 'job', baseRevision: 1 } }, 0)
    expect(() => store.save({ ...record, snapshot: { ...record.snapshot, phase: 'running', revision: 1 } }, 0)).toThrow('BINDING_CONFLICT')
  } finally { cleanup() }
})

test('Given 无法可靠 JSON 往返的数值或超预算输入 When 保存 Then 在写入前拒绝', () => {
  const { store, record, cleanup } = fixture()
  try {
    expect(() => store.save({ ...record, request: { ...record.request, inputs: { speed: { kind: 'scalar', value: Number.NaN } } } }, null)).toThrow('STORAGE_INVALID')
    expect(() => store.save({ ...record, request: { ...record.request, inputs: { text: { kind: 'scalar', value: 'a'.repeat(2 * 1024 * 1024) } } } }, null)).toThrow('STORAGE_INVALID')
  } finally { cleanup() }
})
