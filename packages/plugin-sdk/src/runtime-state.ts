import type { PluginCapabilityClient, PluginStateApi, PluginStateRecord } from './runtime-api.js'

/** 统一 SDK 状态合同，保留旧 read(key) 的 schema 1 默认值。 */
export function createPluginStateApi(client: PluginCapabilityClient): PluginStateApi {
  const readRecord = async <T>(key: string, options?: { schemaVersion: number }): Promise<PluginStateRecord<T> | null> => {
    const schemaVersion = options?.schemaVersion ?? 1
    if (!Number.isSafeInteger(schemaVersion) || schemaVersion < 1) throw new Error('PLUGIN_STATE_SCHEMA_INVALID')
    const record = await client.request<PluginStateRecord<T> | null>('plugin.state.read', { key, schemaVersion })
    if (record === null) return null
    if (!record || record.schemaVersion !== schemaVersion || !Number.isSafeInteger(record.revision) || record.revision < 1 || !Object.hasOwn(record, 'value')) throw new Error('PLUGIN_STATE_RESULT_INVALID')
    return record
  }
  return {
    readRecord,
    async read<T>(key: string, options?: { schemaVersion: number }): Promise<T | null> {
      return (await readRecord<T>(key, options))?.value ?? null
    },
    async write<T>(key: string, value: T, options: { schemaVersion: number; expectedRevision?: number }) {
      return client.request<{ revision: number }>('plugin.state.write', {
        key, value, schemaVersion: options.schemaVersion,
        ...(options.expectedRevision !== undefined ? { expectedRevision: options.expectedRevision } : {}),
      })
    },
  }
}
