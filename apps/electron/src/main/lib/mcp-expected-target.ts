import type { McpConnectionMutationOptions, McpServerEntry } from '@dutydeck/shared'

/** 在主进程同步读改写区间复核远程目标，避免旧 UI 操作启用被替换的同名服务。 */
export function assertMcpExpectedTarget(entry: McpServerEntry | undefined, options?: McpConnectionMutationOptions): void {
  if (options && (entry?.type !== options.expectedTarget?.type || entry?.url !== options.expectedTarget?.url)) {
    throw new Error('MCP_CONNECTION_TARGET_CHANGED')
  }
}
