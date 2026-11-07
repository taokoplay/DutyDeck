import type { IpcMain, IpcMainInvokeEvent } from 'electron'
import { PLUGIN_STATIC_IMPORT_IPC_CHANNELS as C } from '@dutydeck/shared'
import type { StaticPluginImportService, StaticImportWorkspace } from './mcp-importer'
export interface StaticPluginImportIpcOptions {
  ipc: Pick<IpcMain, 'handle'>
  service: Pick<StaticPluginImportService, 'list' | 'preview' | 'apply' | 'undo'>
  isAuthorizedSender: (event: IpcMainInvokeEvent) => boolean
  resolveWorkspace: (id: string) => StaticImportWorkspace
}
/** 只有主窗口主frame可操作，预览token同时绑定创建窗口；不接收任意配方或字节。 */
export function registerStaticPluginImportIpc(options: StaticPluginImportIpcOptions): void {
  const owners = new Map<string, { senderId: number; expiresAt: number }>()
  const authorize = (event: IpcMainInvokeEvent): void => { if (!options.isAuthorizedSender(event)) throw new Error('PLUGIN_IMPORT_ACCESS_DENIED') }
  const input = (value: unknown, allowed: string[]): Record<string, unknown> => {
    if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !allowed.includes(key))) throw new Error('PLUGIN_IMPORT_INPUT_INVALID')
    return value as Record<string, unknown>
  }
  const string = (value: unknown, pattern: RegExp): string => {
    if (typeof value !== 'string' || !pattern.test(value)) throw new Error('PLUGIN_IMPORT_INPUT_INVALID')
    return value
  }
  const ownedToken = (event: IpcMainInvokeEvent, value: unknown): string => {
    const token = string(value, /^[A-Za-z0-9-]{1,128}$/)
    const owner = owners.get(token)
    if (!owner || owner.senderId !== event.sender.id || owner.expiresAt < Date.now()) throw new Error('PLUGIN_IMPORT_ACCESS_DENIED')
    return token
  }
  options.ipc.handle(C.LIST, event => { authorize(event); return options.service.list() })
  options.ipc.handle(C.PREVIEW, (event, value: unknown) => {
    authorize(event)
    const query = input(value, ['planHash', 'workspaceId'])
    const planHash = string(query.planHash, /^[a-f0-9]{64}$/)
    const workspaceId = string(query.workspaceId, /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/)
    for (const [token, owner] of owners) if (owner.expiresAt < Date.now()) owners.delete(token)
    const preview = options.service.preview(planHash, options.resolveWorkspace(workspaceId))
    owners.set(preview.token, { senderId: event.sender.id, expiresAt: Date.now() + 10 * 60 * 1000 })
    return preview
  })
  options.ipc.handle(C.APPLY, (event, value: unknown) => {
    authorize(event)
    const request = input(value, ['token', 'confirmed', 'trustedKeyId'])
    if (typeof request.confirmed !== 'boolean') throw new Error('PLUGIN_IMPORT_INPUT_INVALID')
    const trustedKeyId = request.trustedKeyId === undefined ? undefined : string(request.trustedKeyId, /^[a-f0-9]{64}$/)
    return options.service.apply(ownedToken(event, request.token), { confirmed: request.confirmed, ...(trustedKeyId ? { trustedKeyId } : {}) })
  })
  options.ipc.handle(C.UNDO, (event, value: unknown) => {
    authorize(event)
    const request = input(value, ['token', 'confirmed'])
    if (typeof request.confirmed !== 'boolean') throw new Error('PLUGIN_IMPORT_INPUT_INVALID')
    return options.service.undo(ownedToken(event, request.token), request.confirmed)
  })
}
