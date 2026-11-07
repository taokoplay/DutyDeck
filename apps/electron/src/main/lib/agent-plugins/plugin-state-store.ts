import { mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { acquireMediaFileLock } from '../media/media-file-lock'
import { readJsonFileReadonly, writeJsonFileAtomicSecure } from '../safe-file'

const STATE_RECORD_MAX_BYTES = 1024 * 1024

/** 一条插件私有状态记录。 */
export interface PluginStateRecord<T = unknown> {
  schemaVersion: number
  revision: number
  value: T
}

/** 校验状态文件结构，防止损坏记录被当作空值。 */
function isStateRecord(value: unknown): value is PluginStateRecord {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const record = value as Record<string, unknown>
  return Number.isSafeInteger(record.schemaVersion) && Number(record.schemaVersion) >= 1
    && Number.isSafeInteger(record.revision) && Number(record.revision) >= 1
    && Object.hasOwn(record, 'value')
}

/**
 * 管理插件私有 JSON 状态；路径只由插件 ID、schema 和稳定 key 推导。
 */
export class PluginStateStore {
  private readonly root: string

  constructor(root: string) {
    this.root = root
    mkdirSync(root, { recursive: true, mode: 0o700 })
  }

  /** 读取指定 schema 的插件状态，不存在时返回 null。 */
  read<T = unknown>(pluginId: string, key: string, schemaVersion: number): PluginStateRecord<T> | null {
    const path = this.path(pluginId, key, schemaVersion)
    // 只读能力不能提升备份写回磁盘；主文件损坏时保留备份，等待显式恢复。
    const stored = readJsonFileReadonly(path, { validate: isStateRecord, description: '插件状态', maxBytes: STATE_RECORD_MAX_BYTES })
    if (!stored) return null
    if (stored.schemaVersion !== schemaVersion) throw new Error('PLUGIN_STATE_SCHEMA_MISMATCH')
    return stored as PluginStateRecord<T>
  }

  /** 使用 revision CAS 原子写入；省略 expectedRevision 时只允许新记录。 */
  write<T>(
    pluginId: string,
    key: string,
    schemaVersion: number,
    value: T,
    expectedRevision?: number,
    assertCurrent: () => void = () => undefined,
  ): { revision: number } {
    const encoded = JSON.stringify(value)
    if (Buffer.byteLength(encoded) > STATE_RECORD_MAX_BYTES) throw new Error('PLUGIN_STATE_TOO_LARGE')
    const path = this.path(pluginId, key, schemaVersion)
    assertCurrent()
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
    const release = acquireMediaFileLock(`${path}.lock`)
    try {
      const current = this.read<T>(pluginId, key, schemaVersion)
      if (expectedRevision === undefined ? current !== null : current?.revision !== expectedRevision) {
        throw new Error('PLUGIN_STATE_REVISION_CONFLICT')
      }
      const revision = (current?.revision ?? 0) + 1
      const record: PluginStateRecord = { schemaVersion, revision, value: JSON.parse(encoded) as unknown }
      // 与安全writer实际落盘格式一致，包含外层记录与缩进；成功写入必须能按读取预算读回。
      if (Buffer.byteLength(JSON.stringify(record, null, 2)) > STATE_RECORD_MAX_BYTES) throw new Error('PLUGIN_STATE_TOO_LARGE')
      assertCurrent()
      writeJsonFileAtomicSecure(path, record, {
        beforeRename: assertCurrent,
        ...(current ? { priorBackup: { filePath: `${path}.bak`, data: current } } : {}),
      })
      return { revision }
    } finally {
      release()
    }
  }

  /** 状态 key 不映射任意路径，插件 ID 与 schema 也使用严格格式。 */
  private path(pluginId: string, key: string, schemaVersion: number): string {
    if (!/^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/.test(pluginId)) throw new Error('PLUGIN_ID_INVALID')
    if (!/^[a-zA-Z][a-zA-Z0-9._-]{0,127}$/.test(key)) throw new Error('PLUGIN_STATE_KEY_INVALID')
    if (!Number.isSafeInteger(schemaVersion) || schemaVersion < 1 || schemaVersion > 1_000_000) {
      throw new Error('PLUGIN_STATE_SCHEMA_INVALID')
    }
    return join(this.root, pluginId, `v${schemaVersion}`, `${key}.json`)
  }
}
