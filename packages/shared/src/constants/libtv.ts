import type { McpServerEntry } from '../types/agent'

/** 官方 marketplace 中的稳定服务器名，亦用于工作区凭据命名空间。 */
export const LIBTV_MCP_SERVER_NAME = 'libtv'
/** 官方插件声明的 Streamable HTTP 端点，不接受用户或模型拼接地址。 */
export const LIBTV_MCP_URL = 'https://mcp.liblib.tv/mcp'
/** 官方插件源码，供媒体设置展示来源。 */
export const LIBTV_MARKETPLACE_URL = 'https://github.com/liblib-ai/marketplace'

/**
 * 创建独立的 LibTV 待授权配置，返回值不含任何账户秘密。
 * OAuth 核心端点沿用标准发现；显式 scopes 补足官方资源元数据的空 scope 列表。
 */
export function createLibTvMcpEntry(): McpServerEntry {
  return {
    type: 'http',
    url: LIBTV_MCP_URL,
    enabled: false,
    toolTimeout: 1200,
    oauth: {
      provider: 'libtv',
      registrationEndpoint: 'https://mcp.liblib.tv/register',
      scopes: [
        'libtv:account:read',
        'libtv:project:read',
        'libtv:project:write',
        'libtv:media:write',
        'libtv:task:write',
        'libtv:export:write',
      ],
    },
  }
}

/** 检查同名条目是否仍是官方 HTTP 连接，拒绝外部目标和自定义认证覆盖。 */
export function isLibTvMcpEntry(entry: McpServerEntry | undefined): boolean {
  return entry?.type === 'http' && entry.url === LIBTV_MCP_URL
    && Object.keys(entry.headers ?? {}).length === 0
    && Object.keys(entry.env ?? {}).length === 0
    && !entry.command && !entry.args?.length
}
