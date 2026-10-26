import { afterEach, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { writeJsonFileAtomic } from '../safe-file'
import { createWorkspaceOperationRegistry } from '../workspace-operation-lock'
import { migrateWorkspaceProjectStorageWithDependencies } from './workspace-project-storage-migration'

/** 本文件只迁移由测试创建的隔离项目。 */
const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })

/** 两个工作区指向相同实际目录，用于验证别名不能绕过写租约。 */
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'dutydeck-namespace-admission-'))
  roots.push(root)
  mkdirSync(join(root, '.proma', 'knowledge'), { recursive: true })
  writeJsonFileAtomic(join(root, '.proma', 'knowledge', 'sample.json'), { content: '原始数据' })
  const registry = createWorkspaceOperationRegistry()
  const dependencies = {
    listWorkspaces: () => [{ id: 'first', projectRoot: root }, { id: 'alias', projectRoot: root }],
    isActive: () => false,
    acquireOperation: (id: string) => registry.acquireWorkspaceOperation(id, 'project-storage-migration'),
  }
  return { root, registry, dependencies }
}

describe('项目内部目录迁移准入', () => {
  test('Given 两个工作区共享目录且别名仍在写 When 迁移 Then 不移动并释放已取得的锁', () => {
    const f = fixture()
    const releaseWrite = f.registry.acquireWorkspaceWriteLease('alias')
    expect(() => migrateWorkspaceProjectStorageWithDependencies('first', f.dependencies)).toThrow('仍有写入')
    expect(f.registry.getWorkspaceOperationKind('first')).toBeUndefined()
    expect(readFileSync(join(f.root, '.proma', 'knowledge', 'sample.json'), 'utf8')).toContain('原始数据')
    releaseWrite()
    expect(migrateWorkspaceProjectStorageWithDependencies('first', f.dependencies).movedDirectories).toEqual(['knowledge'])
    expect(readFileSync(join(f.root, '.dutydeck', 'knowledge', 'sample.json'), 'utf8')).toContain('原始数据')
  })

  test('Given 别名有 Agent 或锁后活动状态改变 When 迁移 Then 拒绝执行且锁全部释放', () => {
    const f = fixture()
    expect(() => migrateWorkspaceProjectStorageWithDependencies('first', { ...f.dependencies, isActive: (id) => id === 'alias' })).toThrow('仍有 Agent')
    let checks = 0
    expect(() => migrateWorkspaceProjectStorageWithDependencies('first', { ...f.dependencies, isActive: () => ++checks > 2 })).toThrow('仍有 Agent')
    expect(f.registry.getWorkspaceOperationKind('first')).toBeUndefined()
    expect(f.registry.getWorkspaceOperationKind('alias')).toBeUndefined()
    expect(() => migrateWorkspaceProjectStorageWithDependencies('missing', f.dependencies)).toThrow('项目不存在')
  })
})
