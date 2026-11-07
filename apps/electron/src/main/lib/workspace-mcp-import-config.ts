import type { WorkspaceMcpConfig } from '@dutydeck/shared'
import { readBoundedFile } from '@dutydeck/plugin-kit/filesystem'
import { requireWorkspaceMcpServerName } from './mcp-configuration-policy'
import { readAtomicFileState, writeJsonFileAtomicSecure } from './safe-file'
const MAX_BYTES = 1024 * 1024

/** 导入写入不使用旧固定 tmp；备份也经普通文件检查与独占 staging，保留提交阶段错误。 */
export function writeWorkspaceMcpImportConfig(path: string, config: WorkspaceMcpConfig): void {
  assertWorkspaceMcpImportConfig(config)
  const state = readAtomicFileState(path)
  const prior = readWorkspaceMcpImportConfig(path)
  writeJsonFileAtomicSecure(path, config, {
    expectedDestination: state ? { kind: 'state', state } : { kind: 'missing' },
    ...(state ? { priorBackup: { filePath: `${path}.bak`, data: prior } } : {}),
  })
}

function object(value: unknown): value is Record<string, unknown> { return Boolean(value && typeof value === 'object' && !Array.isArray(value)) }
/** 仅导入采用保守合同。无法无损保留的旧格式须回原MCP界面处理，不静默规范化后覆盖。 */
export function assertWorkspaceMcpImportConfig(value: unknown): asserts value is WorkspaceMcpConfig {
  if (!object(value) || Object.keys(value).some(key => key !== 'servers') || !object(value.servers)) throw new Error('PLUGIN_IMPORT_MCP_CONFIG_INVALID')
  for (const [name, entry] of Object.entries(value.servers)) {
    try { if (requireWorkspaceMcpServerName(name) !== name) throw new Error('invalid name') }
    catch { throw new Error('PLUGIN_IMPORT_MCP_CONFIG_INVALID') }
    if (!object(entry) || !['http', 'sse', 'stdio'].includes(String(entry.type)) || typeof entry.enabled !== 'boolean'
      || (entry.type === 'stdio' ? typeof entry.command !== 'string' : typeof entry.url !== 'string')) throw new Error('PLUGIN_IMPORT_MCP_CONFIG_INVALID')
  }
  if (Buffer.byteLength(JSON.stringify(value, null, 2)) > MAX_BYTES) throw new Error('PLUGIN_IMPORT_MCP_CONFIG_INVALID')
}
/** 只读权威主文件，缺失与损坏分开；不恢复备份、追随末级链接或写文件。 */
export function readWorkspaceMcpImportConfig(path: string): WorkspaceMcpConfig {
  let bytes: Buffer
  try { bytes = readBoundedFile(path, MAX_BYTES) }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { servers: {} }
    throw new Error('PLUGIN_IMPORT_MCP_CONFIG_INVALID')
  }
  try {
    const value: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes))
    assertWorkspaceMcpImportConfig(value)
    return value
  } catch { throw new Error('PLUGIN_IMPORT_MCP_CONFIG_INVALID') }
}
