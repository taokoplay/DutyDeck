import { describe, expect, test } from 'bun:test'
import { EventEmitter } from 'node:events'
import type { IpcMainInvokeEvent } from 'electron'
import type { MediaGenerationSnapshot } from '@dutydeck/shared'
import { registerMediaGenerationPreviewIpc } from './media-generation-preview-ipc'

/** 构造已授权会话和受管产物的最小 IPC 环境。 */
function fixture() {
  const handlers = new Map<string, (event: IpcMainInvokeEvent, input: unknown) => unknown>()
  const sender = Object.assign(new EventEmitter(), { isDestroyed: () => false })
  const event = { sender } as unknown as IpcMainInvokeEvent
  const revoked: string[] = []
  const paths: string[] = []
  const snapshot: MediaGenerationSnapshot = { id: 'run', projectId: 'project', revision: 1, phase: 'succeeded', modelRef: 'media:video:test:profile:model', mediaKind: 'video', createdAt: 1, updatedAt: 1, error: null, outputs: [{ outputKey: 'video', asset: { assetId: 'asset', revision: 1, hash: 'a'.repeat(64), mediaKind: 'video' } }] }
  const registration = registerMediaGenerationPreviewIpc({
    ipc: { handle: (channel, handler) => { handlers.set(channel, handler) }, removeHandler: (channel) => { handlers.delete(channel) } },
    assertSession: (incoming, sessionId) => { if (incoming.sender !== event.sender || sessionId !== 'owner') throw new Error('DENIED'); return 'project' },
    getSource: (sessionId, runId) => { if (sessionId !== 'owner' || runId !== 'run') throw new Error('NOT_OWNED'); return { snapshot } },
    resolveAsset: () => ({ filename: 'result.mp4', path: '/managed/result.mp4' }),
    registerFile: (path) => { paths.push(path); return 'proma-file://lease' },
    revokeUrl: (url) => { revoked.push(url) },
  })
  return { snapshot, registration, event, sender, paths, revoked, invoke: (channel: string, input: unknown, incoming = event) => handlers.get(channel)!(incoming, input) }
}

const readChannel = 'media:read-generation-preview'
const releaseChannel = 'media:release-generation-preview'
const target = { sessionId: 'owner', runId: 'run', outputKey: 'video' }

describe('会话媒体产物预览授权', () => {
  test('Given 属于会话的真实产物 When 预览 Then 只注册主进程文件并在释放时撤销', () => {
    const f = fixture()
    const preview = f.invoke(readChannel, target) as { leaseId: string; mediaUrl: string }
    expect(preview.mediaUrl).toBe('proma-file://lease')
    expect(f.paths).toEqual(['/managed/result.mp4'])
    f.invoke(releaseChannel, { sessionId: 'owner', leaseId: preview.leaseId })
    expect(f.revoked).toEqual(['proma-file://lease'])
  })
  test('Given 伪造会话、任务、产物、路径或窗口 When 请求 Then 不创建授权', () => {
    const f = fixture()
    for (const input of [{ ...target, sessionId: 'other' }, { ...target, runId: 'other' }, { ...target, outputKey: 'other' }, { ...target, path: '/secret' }]) {
      expect(() => f.invoke(readChannel, input)).toThrow()
    }
    expect(() => f.invoke(readChannel, target, { sender: { isDestroyed: () => false } } as IpcMainInvokeEvent)).toThrow()
    expect(f.paths).toEqual([])
  })
  test('Given 会话项目改变或任务未成功 When 预览 Then 拒绝', () => {
    const f = fixture()
    f.snapshot.projectId = 'other'
    expect(() => f.invoke(readChannel, target)).toThrow()
    f.snapshot.projectId = 'project'
    f.snapshot.phase = 'running'
    expect(() => f.invoke(readChannel, target)).toThrow()
  })
  test('Given 已打开预览 When 其它窗口释放 Then 拒绝；原窗口销毁回收全部授权', () => {
    const f = fixture()
    const preview = f.invoke(readChannel, target) as { leaseId: string }
    expect(() => f.invoke(releaseChannel, { sessionId: 'owner', leaseId: preview.leaseId }, { sender: {} } as IpcMainInvokeEvent)).toThrow()
    f.sender.emit('destroyed')
    expect(f.revoked).toEqual(['proma-file://lease'])
    f.registration.dispose()
    expect(f.revoked).toHaveLength(1)
  })
})
