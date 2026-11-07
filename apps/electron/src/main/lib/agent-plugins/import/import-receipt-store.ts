import { join } from 'node:path'
import { readdirSync } from 'node:fs'
import { readBoundedFile } from '@dutydeck/plugin-kit/filesystem'
import { readAtomicFileState, writeJsonFileAtomicSecure } from '../../safe-file'
import { acquireMediaFileLock } from '../../media/media-file-lock'
import { PluginDataDirectory } from '../plugin-data-directory'

import type { PluginImportReceipt, PluginImportStepReceipt } from '@dutydeck/shared'
export type { PluginImportReceipt, PluginImportStepReceipt } from '@dutydeck/shared'
const HASH = /^[a-f0-9]{64}$/
const MAX_BYTES = 32 * 1024
function isReceipt(value: unknown): value is PluginImportReceipt {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const record = value as Record<string, unknown>
  return Object.keys(record).every(key => ['formatVersion', 'id', 'planHash', 'workspaceId', 'revision', 'updatedAt', 'steps'].includes(key))
    && record.formatVersion === 1 && typeof record.id === 'string' && HASH.test(record.id)
    && typeof record.planHash === 'string' && HASH.test(record.planHash)
    && typeof record.workspaceId === 'string' && /^[A-Za-z0-9_.-]{1,128}$/.test(record.workspaceId)
    && Number.isSafeInteger(record.revision) && Number(record.revision) > 0
    && typeof record.updatedAt === 'string' && record.updatedAt.length <= 40 && Number.isFinite(Date.parse(record.updatedAt))
    && Array.isArray(record.steps) && record.steps.length > 0 && record.steps.length <= 2
    && new Set(record.steps.map(step => step?.id)).size === record.steps.length
    && record.steps.every((step: unknown) => {
      if (!step || typeof step !== 'object' || Array.isArray(step)) return false
      const item = step as Record<string, unknown>
      return Object.keys(item).every(key => ['id', 'status', 'fingerprint', 'resourceKey', 'error'].includes(key))
        && ['content', 'mcp'].includes(String(item.id))
        && ['pending', 'applying', 'created', 'reused', 'removed', 'blocked'].includes(String(item.status))
        && (item.fingerprint === undefined || typeof item.fingerprint === 'string' && HASH.test(item.fingerprint))
        && (item.resourceKey === undefined || typeof item.resourceKey === 'string' && HASH.test(item.resourceKey))
        && (!['created', 'reused'].includes(String(item.status)) || item.fingerprint !== undefined)
        && (item.error === undefined || typeof item.error === 'string' && /^PLUGIN_[A-Z0-9_]{1,120}$/.test(item.error))
    })
}

/** 分阶段导入所有权凭据。损坏时禁止借旧备份恢复删除权限。 */
export class PluginImportReceiptStore {
  private readonly directory: PluginDataDirectory
  constructor(root: string) { this.directory = new PluginDataDirectory(root) }
  get(id: string): PluginImportReceipt | null {
    const path = this.path(id)
    let bytes: Buffer
    try { bytes = readBoundedFile(path, MAX_BYTES) }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error }
    let record: unknown
    try { record = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) }
    catch { throw new Error('PLUGIN_IMPORT_RECEIPT_CORRUPT') }
    if (!isReceipt(record) || record.id !== id) throw new Error('PLUGIN_IMPORT_RECEIPT_CORRUPT')
    this.directory.assertCurrent()
    return record
  }
  put(input: Omit<PluginImportReceipt, 'revision' | 'updatedAt'>, expectedRevision: number): PluginImportReceipt {
    const path = this.path(input.id)
    const release = acquireMediaFileLock(`${path}.lock`)
    try {
      const state = readAtomicFileState(path)
      const previous = this.get(input.id)
      if (!Number.isSafeInteger(expectedRevision) || expectedRevision !== (previous?.revision ?? 0)) throw new Error('PLUGIN_IMPORT_RECEIPT_CONFLICT')
      if (previous && (previous.planHash !== input.planHash || previous.workspaceId !== input.workspaceId)) throw new Error('PLUGIN_IMPORT_RECEIPT_IDENTITY')
      const record: PluginImportReceipt = { ...structuredClone(input), revision: expectedRevision + 1, updatedAt: new Date().toISOString() }
      if (!isReceipt(record) || Buffer.byteLength(JSON.stringify(record, null, 2)) > MAX_BYTES) throw new Error('PLUGIN_IMPORT_RECEIPT_INVALID')
      writeJsonFileAtomicSecure(path, record, {
        expectedDestination: state ? { kind: 'state', state } : { kind: 'missing' },
        beforeRename: this.directory.assertCurrent,
      })
      return record
    } finally { release() }
  }
  /** 全局内容包可被多个工作区复用；撤销前有界扫描所有回执，损坏时保持失败关闭。 */
  hasOtherReference(id: string, kind: PluginImportStepReceipt['id'], resourceKey: string): boolean {
    this.path(id)
    const paths = readdirSync(this.directory.path).filter(name => name.endsWith('.json'))
    if (paths.length > 1024) throw new Error('PLUGIN_IMPORT_RECEIPT_LIMIT')
    return paths.some(path => {
      const otherId = path.slice(0, -5)
      if (otherId === id) return false
      const receipt = this.get(otherId)
      return Boolean(receipt?.steps.some(step => step.id === kind && step.status !== 'removed'
        && (!step.resourceKey || step.resourceKey === resourceKey)))
    })
  }
  async withOperation<T>(id: string, action: () => Promise<T>): Promise<T> {
    this.path(id)
    // 内容注册表是全局资源，不能只锁单个工作区回执，否则复用与撤销可以相互穿过。
    const release = acquireMediaFileLock(join(this.directory.path, 'import-operation.lock'))
    try { this.directory.assertCurrent(); return await action() } finally { release() }
  }
  private path(id: string): string {
    if (typeof id !== 'string' || !HASH.test(id)) throw new Error('PLUGIN_IMPORT_RECEIPT_ID_INVALID')
    this.directory.assertCurrent()
    return join(this.directory.path, `${id}.json`)
  }
}
