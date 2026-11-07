import type { PluginMarketEntry, PluginMarketVersion } from '@dutydeck/shared'

const PACKAGE = /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/
const VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/
function invalid(): never { throw new Error('PLUGIN_CATALOG_INVALID') }
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return invalid()
  return value as Record<string, unknown>
}
function text(value: unknown, max: number): string {
  if (typeof value !== 'string' || value.length > max || value.includes('\0')) return invalid()
  return value
}
/** 只保留展示用本地化文本；未知locale按键排序回退，不解释HTML。 */
function localized(value: unknown, fallback: string, max: number): string {
  if (value === undefined) return fallback
  if (typeof value === 'string') return text(value, max)
  const record = object(value)
  if (Object.keys(record).length > 64) return invalid()
  for (const item of Object.values(record)) text(item, max)
  return String(record.zh ?? record['zh-CN'] ?? record.en ?? record[Object.keys(record).sort()[0] ?? ''] ?? fallback)
}
function version(value: unknown): PluginMarketVersion {
  const record = object(value)
  const exact = text(record.version, 128)
  if (!VERSION.test(exact)) return invalid()
  const sourceType = text(object(record.source).type, 64)
  if (!/^[a-z][a-z0-9-]*$/.test(sourceType)) return invalid()
  const engines = record.engines === undefined ? {} : object(record.engines)
  if (Object.keys(engines).length > 32) return invalid()
  return { version: exact, sourceType, engines: Object.fromEntries(Object.entries(engines).map(([key, value]) => [text(key, 128), text(value, 512)])) }
}

/** 有界 format 1 子集读取器；忽略可执行/安装字段，不生成命令或解释patch。 */
export function parseDshFormat1(value: unknown): PluginMarketEntry[] {
  const root = object(value)
  if (root.format !== 1 || !Array.isArray(root.plugins) || root.plugins.length > 25_000) return invalid()
  const names = new Set<string>()
  return root.plugins.map(raw => {
    const record = object(raw)
    const name = text(record.name, 214)
    if (!PACKAGE.test(name) || names.has(name)) return invalid()
    names.add(name)
    if (!Array.isArray(record.versions) || record.versions.length < 1 || record.versions.length > 100) return invalid()
    const versions = record.versions.map(version)
    if (new Set(versions.map(item => item.version)).size !== versions.length) return invalid()
    const metadata = record.metadata === undefined ? {} : object(record.metadata)
    let repository: string | null = null
    if (record.repository !== undefined) {
      const url = object(record.repository).url
      if (typeof url === 'string' && url.length <= 2048) {
        try {
          const parsed = new URL(url)
          if (parsed.protocol === 'https:' && !parsed.username && !parsed.password) repository = parsed.href
        } catch { /* 无效链接不作为可操作目标；不影响文本目录。 */ }
      }
    }
    return {
      name, title: localized(record.title, name, 1024), description: localized(record.description, '', 16_384),
      category: metadata.category === undefined ? null : text(metadata.category, 128), repository, versions,
      compatibility: 'unassessed',
    }
  })
}
