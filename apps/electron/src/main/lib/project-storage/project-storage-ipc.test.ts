import { describe, expect, test } from 'bun:test'
import { PATH_MANAGEMENT_IPC_CHANNELS } from '@dutydeck/shared'
import type { DataRootStartupMode, WorkspacePathState } from '@dutydeck/shared'
import { registerPathManagementIpcHandlers } from '../path-management-ipc'
import { createWorkspaceOperationRegistry } from '../workspace-operation-lock'

/** 主窗口受信任状态；renderer 无权指定项目路径。 */
const workspace: WorkspacePathState = {
  workspaceId: 'project', name: '项目', sourceRoot: '/project', kind: 'external', availability: 'available', relocation: null,
  projectStorageMigration: { state: 'legacy', directories: [{ directory: 'knowledge', state: 'legacy' }], retainedLegacyEntries: [] },
}

/** 记录模式、窗口授权、互斥门禁和重启行为。 */
function harness(mode: DataRootStartupMode = 'normal') {
  /** 与生产一致查询所有工作区写租约，覆盖跨项目退出风险。 */
  const registry = createWorkspaceOperationRegistry()
  const handlers = new Map<string, (event: unknown, ...args: unknown[]) => unknown>()
  const owner = { send: () => undefined }
  const events: string[] = []
  let active = false
  let storageActive = false
  let otherInstance = false
  let fail = false
  let latestWorkspace = workspace
  registerPathManagementIpcHandlers({
    mode, ipc: { handle: (channel, handler) => { handlers.set(channel, handler) }, removeHandler: () => undefined },
    app: { relaunch: () => { events.push('relaunch') }, quit: () => { events.push('quit') } },
    coordinator: {
      getStatus: () => ({ activeRoot: '/data', availability: 'available', deviceType: 'local', migration: null }),
      createPlan: async () => { throw new Error('不应迁移用户级根') }, runPending: async () => undefined, resumePending: async () => undefined, cancel: async () => undefined,
    },
    getExpectedWebContents: () => owner,
    hasActiveTasks: () => active, hasActiveProjectStorageTasks: () => registry.hasActiveWorkspaceWrites() || storageActive, hasOtherPromaInstance: () => otherInstance,
    acquireMigrationGuard: () => ({ release: () => { events.push('release') } }),
    listWorkspacePathStates: () => [latestWorkspace],
    migrateProjectStorage: (workspaceId) => {
      events.push(`migrate:${workspaceId}`)
      if (fail) throw new Error('模拟安全失败')
      return { workspaceId, movedDirectories: [], retainedLegacyEntries: [] }
    },
  })
  return { registry, handlers, owner, events, setActive: () => { active = true }, setStorageActive: () => { storageActive = true }, setOther: () => { otherInstance = true }, setFail: () => { fail = true }, setWorkspace: (value: WorkspacePathState) => { latestWorkspace = value } }
}

describe('项目存储迁移 IPC', () => {
  test('Given 项目 B 正在等待异步导出 When 项目 A 请求迁移 Then 等待 B 结束后才能迁移或重启', async () => {
    /** A 与 B 使用不同工作区身份，全局重启门禁仍必须覆盖 B。 */
    const f = harness()
    const invoke = f.handlers.get(PATH_MANAGEMENT_IPC_CHANNELS.MIGRATE_PROJECT_STORAGE)!
    /** 手动完成编码等待，模拟尚未 settled 的生产导出。 */
    let finishExport: () => void = () => undefined
    const encoding = new Promise<void>((resolve) => { finishExport = resolve })
    const releaseExport = f.registry.acquireWorkspaceWriteLease('exporting-project-B')
    const exporting = encoding.finally(releaseExport)
    try {
      await expect(invoke({ sender: f.owner }, 'project')).rejects.toThrow()
      await expect(invoke({ sender: f.owner }, 'project')).rejects.toThrow()
      expect(f.events).toEqual(['release', 'release'])
    } finally {
      finishExport()
      await exporting
    }
    await invoke({ sender: f.owner }, 'project')
    expect(f.events).toEqual(['release', 'release', 'migrate:project', 'release'])
  })

  test('Given 用户确认恢复迁移 When 旧目录已移动 Then 仍重建运行时且释放实例guard', async () => {
    const f = harness()
    f.setWorkspace({ ...workspace, projectStorageMigration: { state: 'current', directories: [], retainedLegacyEntries: [], recoveryRequired: true } })
    const invoke = f.handlers.get(PATH_MANAGEMENT_IPC_CHANNELS.MIGRATE_PROJECT_STORAGE)!
    await invoke({ sender: f.owner }, 'project')
    expect(f.events).toEqual(['migrate:project', 'relaunch', 'quit', 'release'])
    const noop = harness()
    noop.setWorkspace({ ...workspace, projectStorageMigration: { state: 'current', directories: [], retainedLegacyEntries: [] } })
    await noop.handlers.get(PATH_MANAGEMENT_IPC_CHANNELS.MIGRATE_PROJECT_STORAGE)!({ sender: noop.owner }, 'project')
    expect(noop.events).toEqual(['migrate:project', 'release'])
  })

  test('Given 非主窗口或伪造路径 When 调用 Then 没有迁移写入', async () => {
    const f = harness()
    const invoke = f.handlers.get(PATH_MANAGEMENT_IPC_CHANNELS.MIGRATE_PROJECT_STORAGE)!
    expect(() => invoke({ sender: {} }, 'project')).toThrow('当前窗口无权')
    await expect(invoke({ sender: f.owner }, { workspaceId: 'project', path: '/other' })).rejects.toThrow('工作区 ID 无效')
    await expect(invoke({ sender: f.owner }, '/arbitrary/path')).rejects.toThrow('项目不可用')
    expect(f.events.filter((event) => event.startsWith('migrate'))).toEqual([])
  })

  test('Given 活跃任务、后台媒体、其他实例、离线或冲突 When 迁移 Then 每种情况均阻断', async () => {
    for (const setup of [
      (f: ReturnType<typeof harness>) => f.setActive(),
      (f: ReturnType<typeof harness>) => f.setStorageActive(),
      (f: ReturnType<typeof harness>) => f.setOther(),
      (f: ReturnType<typeof harness>) => f.setWorkspace({ ...workspace, availability: 'missing' }),
      (f: ReturnType<typeof harness>) => f.setWorkspace({ ...workspace, projectStorageMigration: { state: 'conflict', directories: [], retainedLegacyEntries: [] } }),
    ]) {
      const f = harness()
      setup(f)
      await expect(f.handlers.get(PATH_MANAGEMENT_IPC_CHANNELS.MIGRATE_PROJECT_STORAGE)!({ sender: f.owner }, 'project')).rejects.toThrow()
      expect(f.events).toEqual(['release'])
    }
  })

  test('Given 引擎失败 When 返回 Then 不重启并释放guard，轻量窗口无迁移入口', async () => {
    const f = harness()
    f.setFail()
    await expect(f.handlers.get(PATH_MANAGEMENT_IPC_CHANNELS.MIGRATE_PROJECT_STORAGE)!({ sender: f.owner }, 'project')).rejects.toThrow('模拟安全失败')
    expect(f.events).toEqual(['migrate:project', 'release'])
    for (const mode of ['data-root-migration', 'data-root-recovery'] as const) {
      expect(harness(mode).handlers.has(PATH_MANAGEMENT_IPC_CHANNELS.MIGRATE_PROJECT_STORAGE)).toBe(false)
    }
  })
})
