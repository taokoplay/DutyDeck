import type { PluginValidationAssessment } from './plugin-validation'

/** 只读市场通道。读取缓存与主动联网刷新分离，详情不执行第三方入口。 */
export const PLUGIN_MARKET_IPC_CHANNELS = {
  LIST: 'plugin-market:list', REFRESH: 'plugin-market:refresh', DETAIL: 'plugin-market:detail', ANALYZE: 'plugin-market:analyze',
} as const

export type PluginCompatibilityStatus = 'unassessed' | 'convertible' | 'verified' | 'unsupported'
export interface PluginMarketVersion {
  version: string
  sourceType: string
  engines: Record<string, string>
}
export interface PluginMarketEntry {
  name: string
  title: string
  description: string
  category: string | null
  repository: string | null
  versions: PluginMarketVersion[]
  compatibility: PluginCompatibilityStatus
}
export interface PluginMarketQuery { query?: string; offset?: number; limit?: number; sourceUrl?: string }
export interface PluginMarketPage {
  sourceUrl: string
  fetchedAt: string | null
  snapshotHash: string | null
  total: number
  entries: PluginMarketEntry[]
  nextOffset: number | null
  stale: boolean
  error: string | null
}
/** 静态证据不是运行认证；依赖闭包未解出时必须阻断执行/转换。 */
export interface PluginPackageEvidence {
  name: string
  version: string
  registryUrl: string
  tarballUrl: string
  analyzedAt: string
  packageHash: string
  integrity: { status: 'matched' | 'missing'; algorithm: 'sha512' | 'sha1' | null; source: string | null }
  license: string | null
  licenseFiles: string[]
  dependencies: Record<string, string>
  dependencyDeclarations: Record<string, Record<string, string>>
  dependencyClosure: 'none' | 'unresolved'
  fileCount: number
  unpackedBytes: number
  contentCandidates: string[]
  blockers: string[]
  status: 'unassessed' | 'unsupported'
  reasons: string[]
}
export interface PluginPackageAnalysisQuery { sourceUrl?: string; name: string; version: string; snapshotHash: string }
/** 没有包内容证据就维持未知，不从索引猜测许可、哈希或依赖。 */
export interface PluginCompatibilityReport {
  entry: PluginMarketEntry
  sourceUrl: string
  snapshotHash: string
  packageHash: string | null
  license: string | null
  dependencies: Record<string, string> | null
  status: PluginCompatibilityStatus
  reasons: string[]
  packageEvidence?: PluginPackageEvidence
  /** 与实际下载来源/版本/hash完全相同的限定转换证据，不改变原包兼容状态。 */
  conversions?: PluginValidationAssessment[]
}
export interface PluginMarketApi {
  list(query?: PluginMarketQuery): Promise<PluginMarketPage>
  refresh(sourceUrl?: string): Promise<PluginMarketPage>
  detail(input: { sourceUrl?: string; name: string; snapshotHash: string }): Promise<PluginCompatibilityReport>
  analyze(input: PluginPackageAnalysisQuery): Promise<PluginCompatibilityReport>
}
