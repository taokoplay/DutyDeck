import type { PluginCompatibilityReport, PluginMarketEntry } from '@dutydeck/shared'

/** 目录只提供线索，不把分类或engines当作运行验证。 */
export function catalogCompatibility(entry: PluginMarketEntry, sourceUrl: string, snapshotHash: string): PluginCompatibilityReport {
  const npm = entry.versions.some(version => version.sourceType === 'npm')
  return {
    entry, sourceUrl, snapshotHash, packageHash: null, license: null, dependencies: null,
    status: npm ? 'unassessed' : 'unsupported',
    reasons: [
      '当前只有目录声明，尚未读取或审查精确版本的包内容；许可证、依赖和包完整性未知。',
      '分类、下载量、engines.dsh 和作者声明不证明 DutyDeck 兼容；目录快照哈希不是插件包哈希。',
      npm ? 'npm 固定版本可进入后续静态分析；目前不能从目录直接安装或运行。' : '此条目没有 npm 固定版本；当前未提供 Git/local 或其他来源的转换配方。',
      'Skill/Prompt、MCP 和工具适配是不同路线；Cordis、宿主 DOM/slots、模型注册和 Agent-loop 不能直接复用。',
    ],
  }
}
