import type { PluginJsonSchema } from '@dutydeck/plugin-sdk'

/** 仅开发侧宿主维护；不得由市场/renderer传入以自报审查状态。 */
export interface DshBuildRecipe {
  formatVersion: 1
  recipeId: string
  recipeVersion: string
  source: {
    name: string; version: string; archiveSha256: string; url: string; license: string
    files: Record<string, string>
  }
  entry: string
  /** 精确源模块与允许的静态import映射；@dsh/define-tool为唯一替换模块。 */
  imports: Record<string, Record<string, string>>
  adapter: { version: string; sha256: string; license: 'AGPL-3.0-only' }
  plugin: { id: string; version: string; title: string; description: string }
  tool: { upstreamName: string; inputSchema: PluginJsonSchema }
  dependencyDispositions: ReadonlyArray<{
    group: 'dependencies' | 'optionalDependencies' | 'peerDependencies'
    name: string
    specifier: string
    treatment: 'limited-tool-adapter' | 'registration-lifecycle' | 'excluded-client'
    reason: string
  }>
  limitations: readonly string[]
}
