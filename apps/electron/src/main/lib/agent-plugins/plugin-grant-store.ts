import { readBoundedFile } from '@dutydeck/plugin-kit/filesystem'
import { PluginDataDirectory } from './plugin-data-directory'
import { join } from 'node:path'
import { isPluginCapabilityId, type PluginCapabilityId } from '@dutydeck/plugin-sdk'
import { acquireMediaFileLock } from '../media/media-file-lock'
import { writeJsonFileAtomicSecure } from '../safe-file'

/** 用户确认的精确包身份；不能仅以清单声明推导授权。 */
export interface PluginGrantIdentity {
  pluginId: string
  pluginVersion: string
  packageHash: string
}

/** 空工作区集合只允许实例私有状态，不代表全部项目。 */
export interface PluginGrantRecord extends PluginGrantIdentity {
  revision: number
  capabilities: PluginCapabilityId[]
  workspaceIds: string[]
  revoked: boolean
  updatedAt: string
}

function isGrant(value: unknown): value is PluginGrantRecord {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const record = value as Record<string, unknown>
  return typeof record.pluginId === 'string' && /^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/.test(record.pluginId)
    && typeof record.pluginVersion === 'string' && record.pluginVersion.length <= 128
    && typeof record.packageHash === 'string' && /^[a-f0-9]{64}$/.test(record.packageHash)
    && Number.isSafeInteger(record.revision) && Number(record.revision) > 0
    && Array.isArray(record.capabilities) && record.capabilities.every(isPluginCapabilityId)
    && Array.isArray(record.workspaceIds) && record.workspaceIds.length <= 256
    && record.workspaceIds.every(id => typeof id === 'string' && /^[A-Za-z0-9_.-]{1,128}$/.test(id))
    && typeof record.revoked === 'boolean' && typeof record.updatedAt === 'string'
}

/** 与安装目录分离的授权记录。每次读取权威文件，撤销后旧内存快照不能复活。 */
export class PluginGrantStore {
  private readonly directory: PluginDataDirectory
  constructor(private readonly root: string) { this.directory = new PluginDataDirectory(root) }

  get(pluginId: string): PluginGrantRecord | null {
    // 执行授权不能使用普通数据的 tmp/bak 回退：撤权后恢复旧备份会复活权限。
    let bytes: Buffer
    try { bytes = readBoundedFile(this.path(pluginId), 64 * 1024) }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error }
    let record: unknown
    try { record = JSON.parse(bytes.toString('utf8')) } catch { throw new Error('PLUGIN_GRANT_CORRUPT') }
    if (!isGrant(record)) throw new Error('PLUGIN_GRANT_CORRUPT')
    if (record.pluginId !== pluginId) throw new Error('PLUGIN_GRANT_IDENTITY_INVALID')
    this.directory.assertCurrent()
    return record
  }

  set(identity: PluginGrantIdentity, capabilities: readonly PluginCapabilityId[], workspaceIds: readonly string[], expectedRevision: number): PluginGrantRecord {
    const release = acquireMediaFileLock(`${this.path(identity.pluginId)}.lock`)
    try {
      const previous = this.get(identity.pluginId)
      if (!Number.isSafeInteger(expectedRevision) || expectedRevision !== (previous?.revision ?? 0)) throw new Error('PLUGIN_GRANT_REVISION_CONFLICT')
      const record: PluginGrantRecord = {
        ...identity, capabilities: [...new Set(capabilities)], workspaceIds: [...new Set(workspaceIds)],
        revision: expectedRevision + 1, revoked: false, updatedAt: new Date().toISOString(),
      }
      if (!isGrant(record)) throw new Error('PLUGIN_GRANT_INPUT_INVALID')
      writeJsonFileAtomicSecure(this.path(identity.pluginId), record, { beforeRename: this.directory.assertCurrent })
      return record
    } finally { release() }
  }

  revoke(pluginId: string, expectedRevision: number): void {
    const release = acquireMediaFileLock(`${this.path(pluginId)}.lock`)
    try {
      const record = this.get(pluginId)
      if (!record || record.revision !== expectedRevision) throw new Error('PLUGIN_GRANT_REVISION_CONFLICT')
      writeJsonFileAtomicSecure(this.path(pluginId), { ...record, revision: record.revision + 1, revoked: true, updatedAt: new Date().toISOString() }, { beforeRename: this.directory.assertCurrent })
    } finally { release() }
  }

  assertGranted(identity: PluginGrantIdentity, workspaceId?: string | null): PluginGrantRecord {
    const record = this.get(identity.pluginId)
    if (!record || record.revoked || record.packageHash !== identity.packageHash || record.pluginVersion !== identity.pluginVersion) {
      throw new Error('PLUGIN_GRANT_REQUIRED')
    }
    if (workspaceId != null && !record.workspaceIds.includes(workspaceId)) throw new Error('PLUGIN_GRANT_SCOPE')
    return record
  }

  private path(pluginId: string): string {
    if (!/^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/.test(pluginId) || pluginId.length > 256) throw new Error('PLUGIN_ID_INVALID')
    this.directory.assertCurrent()
    return join(this.root, `${pluginId}.json`)
  }
}
