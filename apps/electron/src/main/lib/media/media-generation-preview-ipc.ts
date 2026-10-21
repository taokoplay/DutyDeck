import { randomUUID } from 'node:crypto'
import type { IpcMainInvokeEvent, WebContents } from 'electron'
import { MEDIA_IPC_CHANNELS } from '@dutydeck/shared'
import type { MediaAssetRef, MediaGenerationPreview, MediaGenerationSnapshot } from '@dutydeck/shared'

/** 预览只依赖宿主可信服务；Renderer 不提交资产、项目或路径。 */
export interface MediaGenerationPreviewIpcOptions {
  ipc: { handle(channel: string, handler: (event: IpcMainInvokeEvent, input: unknown) => unknown): void; removeHandler(channel: string): void }
  /** 核验当前窗口能访问消息所属会话，返回会话当前项目。 */
  assertSession(event: IpcMainInvokeEvent, sessionId: string): string
  /** 必须接统一服务的 getAttachmentSource，校验任务所属会话。 */
  getSource(sessionId: string, runId: string): { snapshot: MediaGenerationSnapshot }
  /** 从权威资产服务校验引用并解析单文件路径。 */
  resolveAsset(projectId: string, asset: MediaAssetRef): { filename: string; path: string }
  /** 使用已有 proma-file 单文件授权并 retain，支持播放器范围读取。 */
  registerFile(path: string): string
  revokeUrl(url: string): void
}

/** 仅接受已声明的非空标识字段，禁止额外 URL 或磁盘路径。 */
function parseInput(value: unknown, keys: string[]): Record<string, string> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('MEDIA_PREVIEW_INPUT_INVALID')
  const input = value as Record<string, unknown>
  if (Object.keys(input).length !== keys.length || keys.some((key) => typeof input[key] !== 'string'
    || !/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,255}$/.test(input[key] as string))) throw new Error('MEDIA_PREVIEW_INPUT_INVALID')
  return input as Record<string, string>
}

/** 每个预览租约绑定窗口和消息会话。 */
interface PreviewLease { sender: WebContents; sessionId: string; url: string }

/** 注册统一生成预览；租约随组件释放、窗口关闭或应用退出清理。 */
export function registerMediaGenerationPreviewIpc(options: MediaGenerationPreviewIpcOptions): { dispose(): void } {
  /** 有界授权集合，避免历史消息无限保留文件能力。 */
  const leases = new Map<string, PreviewLease>()
  /** 每个窗口只注册一次销毁监听。 */
  const listeners = new Map<WebContents, () => void>()
  /** 已卸载服务不能继续注册授权。 */
  let disposed = false
  /** 幂等撤销一个授权 URL。 */
  const release = (id: string): void => {
    const lease = leases.get(id)
    if (!lease) return
    leases.delete(id)
    options.revokeUrl(lease.url)
  }
  options.ipc.handle(MEDIA_IPC_CHANNELS.READ_GENERATION_PREVIEW, (event, value): MediaGenerationPreview => {
    const input = parseInput(value, ['sessionId', 'runId', 'outputKey'])
    if (disposed || event.sender.isDestroyed()) throw new Error('MEDIA_PREVIEW_ACCESS_DENIED')
    const projectId = options.assertSession(event, input.sessionId!)
    const { snapshot } = options.getSource(input.sessionId!, input.runId!)
    if (snapshot.id !== input.runId || snapshot.projectId !== projectId || snapshot.phase !== 'succeeded') throw new Error('MEDIA_PREVIEW_NOT_AVAILABLE')
    const output = snapshot.outputs.find((item) => item.outputKey === input.outputKey)
    if (!output) throw new Error('MEDIA_PREVIEW_NOT_AVAILABLE')
    if (leases.size >= 128 || [...leases.values()].filter((lease) => lease.sender === event.sender).length >= 24) throw new Error('MEDIA_PREVIEW_LIMIT')
    const record = options.resolveAsset(projectId, output.asset)
    const url = options.registerFile(record.path)
    try {
      if (!url.startsWith('proma-file://') || options.assertSession(event, input.sessionId!) !== projectId || event.sender.isDestroyed()) throw new Error('MEDIA_PREVIEW_ACCESS_DENIED')
      if (!listeners.has(event.sender)) {
        const cleanup = (): void => {
          for (const [id, lease] of leases) if (lease.sender === event.sender) release(id)
          listeners.delete(event.sender)
        }
        listeners.set(event.sender, cleanup)
        event.sender.once('destroyed', cleanup)
      }
      const leaseId = randomUUID()
      leases.set(leaseId, { sender: event.sender, sessionId: input.sessionId!, url })
      return { leaseId, mediaUrl: url, mediaKind: output.asset.mediaKind, filename: record.filename }
    } catch (error) {
      options.revokeUrl(url)
      throw error
    }
  })
  options.ipc.handle(MEDIA_IPC_CHANNELS.RELEASE_GENERATION_PREVIEW, (event, value) => {
    const input = parseInput(value, ['sessionId', 'leaseId'])
    const lease = leases.get(input.leaseId!)
    if (!lease) return
    if (lease.sender !== event.sender || lease.sessionId !== input.sessionId) throw new Error('MEDIA_PREVIEW_ACCESS_DENIED')
    release(input.leaseId!)
  })
  return { dispose: () => {
    disposed = true
    for (const id of leases.keys()) release(id)
    for (const [sender, cleanup] of listeners) sender.removeListener('destroyed', cleanup)
    listeners.clear()
    options.ipc.removeHandler(MEDIA_IPC_CHANNELS.READ_GENERATION_PREVIEW)
    options.ipc.removeHandler(MEDIA_IPC_CHANNELS.RELEASE_GENERATION_PREVIEW)
  } }
}
