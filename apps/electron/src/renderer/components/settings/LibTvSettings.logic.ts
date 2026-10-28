import { createLibTvMcpEntry, isLibTvMcpEntry, LIBTV_MCP_SERVER_NAME, LIBTV_MCP_URL } from '@dutydeck/shared'
import type { McpServerEntry, WorkspaceMcpConfig } from '@dutydeck/shared'

/** 连接流程仅依赖原子 MCP 操作，禁止整份覆盖工作区配置。 */
export type LibTvApi = Pick<Window['electronAPI'], 'getWorkspaceMcpConfig' | 'installMcpAndValidate' | 'startMcpOAuth' | 'setMcpEnabledAndValidate'>
/** 已连接必须同时满足官方地址、启用和真实握手验证。 */
export type LibTvConnectionState = 'unconfigured' | 'conflict' | 'disabled' | 'pending' | 'connected'

/** 根据持久化条目返回可展示的连接状态，不根据名称猜测身份。 */
export function getLibTvConnectionState(entry: McpServerEntry | undefined): LibTvConnectionState {
  if (!entry) return 'unconfigured'
  if (!isLibTvMcpEntry(entry)) return 'conflict'
  if (!entry.enabled) return 'disabled'
  return entry.lastTestResult?.success ? 'connected' : 'pending'
}

/** 校验当前快照的 LibTV 身份；同名冲突必须由用户在 MCP 管理中处理。 */
function assertOfficialEntry(config: WorkspaceMcpConfig): void {
  if (getLibTvConnectionState(config.servers[LIBTV_MCP_SERVER_NAME]) === 'conflict') {
    throw new Error('存在同名非官方 LibTV 配置，请前往 Agent 技能的 MCP 管理中处理；此处不会覆盖已有服务。')
  }
}

/** 在指定工作区安装禁用预设、执行 OAuth 并验证；作用域失效后不继续写入。 */
export async function connectLibTv(api: LibTvApi, workspaceSlug: string, isCurrent: () => boolean): Promise<WorkspaceMcpConfig | null> {
  if (!workspaceSlug) throw new Error('请先选择工作区')
  /** 每一步都使用最新主进程配置，并在异步返回后核对页面作用域。 */
  let config = await api.getWorkspaceMcpConfig(workspaceSlug)
  if (!isCurrent()) return null
  assertOfficialEntry(config)
  if (!config.servers[LIBTV_MCP_SERVER_NAME]) {
    const installed = await api.installMcpAndValidate(workspaceSlug, LIBTV_MCP_SERVER_NAME, createLibTvMcpEntry())
    if (!isCurrent()) return null
    config = installed.config
    assertOfficialEntry(config)
    if (!config.servers[LIBTV_MCP_SERVER_NAME]) throw new Error('LibTV 配置安装失败，请刷新后重试')
  }
  await api.startMcpOAuth({
    workspaceSlug, serverName: LIBTV_MCP_SERVER_NAME, serverUrl: LIBTV_MCP_URL,
    provider: 'libtv', oauth: createLibTvMcpEntry().oauth,
  })
  if (!isCurrent()) return null
  config = await api.getWorkspaceMcpConfig(workspaceSlug)
  if (!isCurrent()) return null
  assertOfficialEntry(config)
  if (!config.servers[LIBTV_MCP_SERVER_NAME]) throw new Error('LibTV 配置已被移除，请刷新后重试')
  const result = await api.setMcpEnabledAndValidate(workspaceSlug, LIBTV_MCP_SERVER_NAME, true, { expectedTarget: { type: 'http', url: LIBTV_MCP_URL } })
  if (!isCurrent()) return null
  if (!result.verification.success) throw new Error(result.verification.message || 'LibTV 握手或工具发现失败，请重试')
  return result.config
}

/** 基于当前配置执行原子开关或验证，不重新发起 OAuth，也不删除凭据。 */
async function setLibTvEnabled(api: LibTvApi, workspaceSlug: string, isCurrent: () => boolean, enabled: boolean): Promise<WorkspaceMcpConfig | null> {
  if (!workspaceSlug) throw new Error('请先选择工作区')
  const config = await api.getWorkspaceMcpConfig(workspaceSlug)
  if (!isCurrent()) return null
  assertOfficialEntry(config)
  if (!config.servers[LIBTV_MCP_SERVER_NAME]) return config
  const result = await api.setMcpEnabledAndValidate(workspaceSlug, LIBTV_MCP_SERVER_NAME, enabled, { expectedTarget: { type: 'http', url: LIBTV_MCP_URL } })
  if (!isCurrent()) return null
  if (!result.verification.success) throw new Error(result.verification.message || (enabled ? 'LibTV 连接验证失败' : '停用 LibTV 失败'))
  return result.config
}

/** 停用当前工作区的官方 LibTV；保留加密凭据，避免影响其他工作区。 */
export function disableLibTv(api: LibTvApi, workspaceSlug: string, isCurrent: () => boolean): Promise<WorkspaceMcpConfig | null> {
  return setLibTvEnabled(api, workspaceSlug, isCurrent, false)
}

/** 使用已有授权执行真实握手和工具发现，失败时返回服务端错误。 */
export function verifyLibTv(api: LibTvApi, workspaceSlug: string, isCurrent: () => boolean): Promise<WorkspaceMcpConfig | null> {
  return setLibTvEnabled(api, workspaceSlug, isCurrent, true)
}
