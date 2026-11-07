import { describe, expect, test } from 'bun:test'
import type { IpcMainInvokeEvent } from 'electron'
import { PLUGIN_STATIC_IMPORT_IPC_CHANNELS as C } from '@dutydeck/shared'
import { registerStaticPluginImportIpc, type StaticPluginImportIpcOptions } from './plugin-static-import-ipc'

describe('Given 固定配方导入IPC边界', () => {
  test('When 未授权frame、跨窗口token或额外参数 Then 拒绝；有效窗口只按宿主工作区和固定计划操作', async () => {
    const handlers = new Map<string, (event: IpcMainInvokeEvent, input?: unknown) => unknown>()
    let writes = 0; const tokens: string[] = []
    const options: StaticPluginImportIpcOptions = {
      ipc: { handle: (channel, handler) => { handlers.set(channel, handler) } },
      isAuthorizedSender: event => event.sender.id !== 3,
      resolveWorkspace: id => { if (id !== 'workspace-a') throw new Error('PLUGIN_IMPORT_WORKSPACE_INVALID'); return { id, slug: 'host-slug' } },
      service: {
        list: () => [],
        preview: (planHash, workspace) => { expect(workspace.slug).toBe('host-slug'); const token = `token-${tokens.length}`; tokens.push(token); return { token, planHash, workspaceId: workspace.id, conflicts: [], receipt: null } },
        apply: async () => { writes++; return { formatVersion: 1, id: 'b'.repeat(64), planHash: 'a'.repeat(64), workspaceId: 'workspace-a', revision: 1, updatedAt: new Date().toISOString(), steps: [{ id: 'mcp', status: 'pending' }] } },
        undo: async () => { throw new Error('fixture') },
      },
    }
    registerStaticPluginImportIpc(options)
    expect(handlers.size).toBe(4)
    const event = (id: number): IpcMainInvokeEvent => ({ sender: { id } }) as IpcMainInvokeEvent
    const invoke = async (channel: string, id: number, input?: unknown): Promise<unknown> => handlers.get(channel)!(event(id), input)
    await expect(invoke(C.LIST, 3)).rejects.toThrow('PLUGIN_IMPORT_ACCESS_DENIED')
    await expect(invoke(C.PREVIEW, 1, { planHash: 'a'.repeat(64), workspaceId: 'workspace-a', command: 'untrusted' })).rejects.toThrow('PLUGIN_IMPORT_INPUT_INVALID')
    await invoke(C.PREVIEW, 1, { planHash: 'a'.repeat(64), workspaceId: 'workspace-a' })
    await expect(invoke(C.APPLY, 2, { token: tokens[0], confirmed: true })).rejects.toThrow('PLUGIN_IMPORT_ACCESS_DENIED')
    await expect(invoke(C.APPLY, 1, { token: tokens[0], confirmed: true, url: 'https://attacker.example.com' })).rejects.toThrow('PLUGIN_IMPORT_INPUT_INVALID')
    await invoke(C.APPLY, 1, { token: tokens[0], confirmed: true })
    expect(writes).toBe(1)
  })
})
