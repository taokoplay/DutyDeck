import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { readBoundedFile } from '@dutydeck/plugin-kit/filesystem'
import type { PluginMarketPage, PluginMarketQuery, PluginCompatibilityReport, PluginMarketEntry, PluginPackageAnalysisQuery } from '@dutydeck/shared'
import { AtomicWritePostCommitError, writeJsonFileAtomicSecure } from '../../safe-file'
import { PluginDataDirectory } from '../plugin-data-directory'
import { CATALOG_MAX_BYTES, catalogUrl, downloadCatalog, downloadPackageResource } from './catalog-download'
import { parseDshFormat1 } from './dsh-format1'
import { catalogCompatibility } from './compatibility-report'
import { analyzeNpmPackage } from './npm-package-analysis'
import { assessSourceConversions } from '../plugin-validation'
import { getHostPluginValidationRecords, readPluginValidationEnvironment } from '../plugin-validation-catalog'

export const DEFAULT_CATALOG_URL = 'https://cdn.jsdelivr.net/npm/dsh-plugin-catalog/index.json'
export interface CatalogServiceOptions { root: string; download?: (url: string) => Promise<Buffer>; downloadPackage?: (url: string, kind: 'json' | 'tarball') => Promise<Buffer>; now?: () => Date }
interface Snapshot { sourceUrl: string; fetchedAt: string; hash: string; entries: PluginMarketEntry[] }
interface PersistedSnapshot { sourceUrl: string; fetchedAt: string; hash: string; raw: string }
const digest = (value: string | Buffer): string => createHash('sha256').update(value).digest('hex')

/** 仅显式refresh联网。按源保存原始快照，失败保留最后成功数据。 */
export class PluginCatalogService {
  private readonly directory: PluginDataDirectory
  private readonly snapshots = new Map<string, Snapshot>()
  private readonly errors = new Map<string, string>()
  private readonly pending = new Map<string, Promise<PluginMarketPage>>()
  private readonly known = new Set<string>()
  private readonly analyses = new Map<string, Promise<PluginCompatibilityReport>>()
  private readonly download: (url: string) => Promise<Buffer>
  private readonly now: () => Date
  constructor(private readonly options: CatalogServiceOptions) {
    this.directory = new PluginDataDirectory(options.root)
    this.download = options.download ?? downloadCatalog
    this.now = options.now ?? (() => new Date())
  }
  list(query: PluginMarketQuery = {}): PluginMarketPage {
    if (!query || typeof query !== 'object' || Array.isArray(query)
      || Object.keys(query).some(key => !['query', 'offset', 'limit', 'sourceUrl'].includes(key))
      || (query.query !== undefined && (typeof query.query !== 'string' || query.query.length > 256))
      || (query.offset !== undefined && (!Number.isSafeInteger(query.offset) || query.offset < 0 || query.offset > 25_000))
      || (query.limit !== undefined && (!Number.isSafeInteger(query.limit) || query.limit < 1 || query.limit > 100))) throw new Error('PLUGIN_CATALOG_QUERY_INVALID')
    const sourceUrl = this.source(query.sourceUrl)
    const snapshot = this.load(sourceUrl)
    const needle = query.query?.trim().toLowerCase() ?? ''
    const filtered = snapshot?.entries.filter(entry => !needle || `${entry.name} ${entry.title} ${entry.description} ${entry.category ?? ''}`.toLowerCase().includes(needle)) ?? []
    const offset = query.offset ?? 0; const limit = query.limit ?? 30
    return {
      sourceUrl, fetchedAt: snapshot?.fetchedAt ?? null, snapshotHash: snapshot?.hash ?? null,
      total: filtered.length, entries: structuredClone(filtered.slice(offset, offset + limit)),
      nextOffset: offset + limit < filtered.length ? offset + limit : null,
      stale: Boolean(this.errors.has(sourceUrl) || (snapshot && this.now().getTime() - Date.parse(snapshot.fetchedAt) > 24 * 60 * 60 * 1000)),
      error: this.errors.get(sourceUrl) ?? null,
    }
  }
  refresh(raw?: string): Promise<PluginMarketPage> {
    const sourceUrl = this.source(raw)
    const existing = this.pending.get(sourceUrl)
    if (existing) return existing
    if (this.pending.size >= 2) return Promise.reject(new Error('PLUGIN_CATALOG_BUSY'))
    this.load(sourceUrl)
    const task = this.fetch(sourceUrl).finally(() => this.pending.delete(sourceUrl))
    this.pending.set(sourceUrl, task)
    return task
  }
  detail(input: { sourceUrl?: string; name: string; snapshotHash: string }): PluginCompatibilityReport {
    if (!input || typeof input !== 'object' || typeof input.name !== 'string' || input.name.length > 214
      || typeof input.snapshotHash !== 'string' || !/^[a-f0-9]{64}$/.test(input.snapshotHash)) throw new Error('PLUGIN_CATALOG_QUERY_INVALID')
    const sourceUrl = this.source(input.sourceUrl)
    const snapshot = this.load(sourceUrl)
    if (!snapshot || snapshot.hash !== input.snapshotHash) throw new Error('PLUGIN_CATALOG_SNAPSHOT_CHANGED')
    const entry = snapshot.entries.find(item => item.name === input.name)
    if (!entry) throw new Error('PLUGIN_CATALOG_ENTRY_MISSING')
    return catalogCompatibility(structuredClone(entry), sourceUrl, snapshot.hash)
  }
  analyze(input: PluginPackageAnalysisQuery): Promise<PluginCompatibilityReport> {
    try {
      const report = this.detail(input)
      if (typeof input.version !== 'string' || !report.entry.versions.some(item => item.version === input.version && item.sourceType === 'npm')) throw new Error('PLUGIN_PACKAGE_SOURCE_UNSUPPORTED')
      // 快照、来源、名称、精确版本共同作为本次分析身份；不把旧包结果继承到新快照。
      const key = JSON.stringify([report.sourceUrl, report.snapshotHash, input.name, input.version])
      const existing = this.analyses.get(key)
      if (existing) return existing
      if (this.analyses.size >= 1) throw new Error('PLUGIN_PACKAGE_ANALYSIS_BUSY')
      const task = analyzeNpmPackage(input.name, input.version, this.options.downloadPackage ?? downloadPackageResource)
        .then(async evidence => {
          this.detail(input) // 下载等待期间目录变化即失效，不返回旧身份诊断。
          const environment = await readPluginValidationEnvironment()
          this.detail(input) // 宿主材料扫描也会让出事件循环；最终返回前重新绑定目录。
          return { ...report, packageEvidence: evidence, packageHash: evidence.packageHash, license: evidence.license,
            dependencies: evidence.dependencies, status: evidence.status, reasons: evidence.reasons,
            conversions: assessSourceConversions({ name: evidence.name, version: evidence.version, url: evidence.tarballUrl, archiveSha256: evidence.packageHash }, environment, getHostPluginValidationRecords(), this.now()) }
        })
        .catch((error: unknown) => {
          const code = error instanceof Error && /^PLUGIN_(?:PACKAGE|CATALOG)_[A-Z_]{1,60}$/.test(error.message) ? error.message : 'PLUGIN_PACKAGE_ANALYSIS_FAILED'
          throw new Error(code)
        })
        .finally(() => this.analyses.delete(key))
      this.analyses.set(key, task)
      return task
    } catch (error) { return Promise.reject(error) }
  }
  private source(raw: unknown): string {
    if (raw !== undefined && typeof raw !== 'string') throw new Error('PLUGIN_CATALOG_URL_INVALID')
    const url = catalogUrl(raw ?? DEFAULT_CATALOG_URL)
    if (!this.known.has(url) && this.known.size >= 8) throw new Error('PLUGIN_CATALOG_SOURCE_LIMIT')
    this.known.add(url)
    return url
  }
  private path(source: string): string { this.directory.assertCurrent(); return join(this.options.root, `${digest(source)}.json`) }
  private load(sourceUrl: string): Snapshot | null {
    this.directory.assertCurrent()
    if (this.snapshots.has(sourceUrl)) return this.snapshots.get(sourceUrl)!
    try {
      const record = JSON.parse(readBoundedFile(this.path(sourceUrl), CATALOG_MAX_BYTES * 6 + 4096).toString('utf8')) as PersistedSnapshot
      this.directory.assertCurrent()
      if (record.sourceUrl !== sourceUrl || typeof record.raw !== 'string' || Buffer.byteLength(record.raw) > CATALOG_MAX_BYTES
        || digest(record.raw) !== record.hash || typeof record.fetchedAt !== 'string' || !Number.isFinite(Date.parse(record.fetchedAt))) throw new Error('corrupt')
      const snapshot = { sourceUrl, fetchedAt: record.fetchedAt, hash: record.hash, entries: parseDshFormat1(JSON.parse(record.raw.replace(/^\uFEFF/, ''))) }
      this.snapshots.set(sourceUrl, snapshot)
      return snapshot
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') this.errors.set(sourceUrl, 'PLUGIN_CATALOG_CACHE_INVALID')
      return null
    }
  }
  private async fetch(sourceUrl: string): Promise<PluginMarketPage> {
    try {
      const bytes = await this.download(sourceUrl)
      if (bytes.byteLength > CATALOG_MAX_BYTES) throw new Error('PLUGIN_CATALOG_TOO_LARGE')
      const raw = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes)
      const entries = parseDshFormat1(JSON.parse(raw.replace(/^\uFEFF/, '')))
      const record: PersistedSnapshot = { sourceUrl, fetchedAt: this.now().toISOString(), hash: digest(bytes), raw }
      let committedWarning: string | undefined
      try {
        writeJsonFileAtomicSecure(this.path(sourceUrl), record, { beforeRename: this.directory.assertCurrent })
      } catch (error) {
        // rename已提交，不能保留旧内存快照或宣称磁盘未变；警告仅描述本次写入结果。
        if (!(error instanceof AtomicWritePostCommitError)) throw error
        committedWarning = error.stage === 'mainDurabilityUncertain'
          ? 'PLUGIN_CATALOG_COMMITTED_DURABILITY_UNCERTAIN'
          : 'PLUGIN_CATALOG_COMMITTED_BACKUP_DEGRADED'
      }
      this.snapshots.set(sourceUrl, { sourceUrl, fetchedAt: record.fetchedAt, hash: record.hash, entries })
      if (committedWarning) this.errors.set(sourceUrl, committedWarning)
      else this.errors.delete(sourceUrl)
    } catch (error) {
      const code = error instanceof Error && /^PLUGIN_CATALOG_[A-Z_]{1,60}$/.test(error.message) ? error.message : 'PLUGIN_CATALOG_REFRESH_FAILED'
      this.errors.set(sourceUrl, code)
    }
    return this.list({ sourceUrl })
  }
}
