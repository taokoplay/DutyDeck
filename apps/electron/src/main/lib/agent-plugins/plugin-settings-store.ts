import { PluginDataDirectory } from './plugin-data-directory'
import { join } from 'node:path'
import type { PluginV3Manifest, PluginSettingValue } from '@dutydeck/plugin-sdk'
import { acquireMediaFileLock } from '../media/media-file-lock'
import { readJsonFileStrict, writeJsonFileAtomicSecure } from '../safe-file'

export interface PluginSettingsSnapshot {
  revision: number
  values: Record<string, PluginSettingValue>
}

function isSnapshot(value: unknown): value is PluginSettingsSnapshot {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const record = value as Record<string, unknown>
  return Number.isSafeInteger(record.revision) && Number(record.revision) >= 1
    && Boolean(record.values) && typeof record.values === 'object' && !Array.isArray(record.values)
}

/** 普通设置按精确包隔离；升级不会把旧 schema 的值静默用于新包。 */
export class PluginSettingsStore {
  private readonly directory: PluginDataDirectory
  constructor(private readonly root: string) { this.directory = new PluginDataDirectory(root) }

  read(manifest: PluginV3Manifest, packageHash: string): PluginSettingsSnapshot {
    const stored = readJsonFileStrict(this.path(manifest.id, packageHash), { description: '插件设置', validate: isSnapshot, secureRecovery: true, maxBytes: 64 * 1024 })
    return { revision: stored?.revision ?? 0, values: this.validate(manifest, stored?.values ?? {}, false) }
  }

  assertReady(manifest: PluginV3Manifest, packageHash: string): PluginSettingsSnapshot {
    if (manifest.settings.some(setting => setting.type === 'credentialRef')) throw new Error('PLUGIN_CREDENTIAL_BRIDGE_UNAVAILABLE')
    const snapshot = this.read(manifest, packageHash)
    this.validate(manifest, snapshot.values, true)
    return snapshot
  }

  save(manifest: PluginV3Manifest, packageHash: string, values: Record<string, unknown>, expectedRevision: number): PluginSettingsSnapshot {
    const path = this.path(manifest.id, packageHash)
    const release = acquireMediaFileLock(`${path}.lock`)
    try {
      const previous = this.read(manifest, packageHash)
      if (!Number.isSafeInteger(expectedRevision) || previous.revision !== expectedRevision) throw new Error('PLUGIN_SETTINGS_REVISION_CONFLICT')
      const next = { revision: previous.revision + 1, values: this.validate(manifest, values, true) }
      if (Buffer.byteLength(JSON.stringify(next)) > 64 * 1024) throw new Error('PLUGIN_SETTINGS_TOO_LARGE')
      writeJsonFileAtomicSecure(path, next, { beforeRename: this.directory.assertCurrent })
      return structuredClone(next)
    } finally { release() }
  }

  private validate(manifest: PluginV3Manifest, input: Record<string, unknown>, required: boolean): Record<string, PluginSettingValue> {
    if (!input || typeof input !== 'object' || Array.isArray(input) || Object.getPrototypeOf(input) !== Object.prototype) throw new Error('PLUGIN_SETTINGS_INVALID')
    if (Object.keys(input).some(key => !manifest.settings.some(setting => setting.key === key) || ['__proto__', 'prototype', 'constructor'].includes(key))) throw new Error('PLUGIN_SETTINGS_INVALID')
    const values: Record<string, PluginSettingValue> = {}
    for (const setting of manifest.settings) {
      if (setting.type === 'credentialRef') {
        if (Object.hasOwn(input, setting.key)) throw new Error('PLUGIN_CREDENTIAL_BRIDGE_UNAVAILABLE')
        continue
      }
      const value = Object.hasOwn(input, setting.key) ? input[setting.key] : setting.defaultValue
      if (value === undefined) {
        if (required && setting.required) throw new Error('PLUGIN_SETTINGS_REQUIRED')
        continue
      }
      const valid = setting.type === 'boolean' ? typeof value === 'boolean'
        : setting.type === 'integer' ? Number.isSafeInteger(value) && Number(value) >= (setting.minimum ?? Number.MIN_SAFE_INTEGER) && Number(value) <= (setting.maximum ?? Number.MAX_SAFE_INTEGER)
        : setting.type === 'enum' ? typeof value === 'string' && setting.enumValues.includes(value)
        : typeof value === 'string' && value.length <= (setting.maxLength ?? 4096)
      if (!valid || setting.required && value === '') throw new Error('PLUGIN_SETTINGS_INVALID')
      values[setting.key] = value as PluginSettingValue
    }
    return values
  }

  private path(pluginId: string, packageHash: string): string {
    if (!/^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/.test(pluginId) || !/^[a-f0-9]{64}$/.test(packageHash)) throw new Error('PLUGIN_SETTINGS_IDENTITY_INVALID')
    this.directory.assertCurrent()
    return join(this.root, `${pluginId}-${packageHash}.json`)
  }
}
