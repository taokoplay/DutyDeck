import { readFileSync, statSync } from 'node:fs'
import { extname } from 'node:path'
import { getModuleRuntimeManager } from './module-runtime-bridge'

/** Surface 静态资源需要在 opaque sandbox origin 中加载 ESM，因此启用受控 CORS。 */
export const PLUGIN_SURFACE_SCHEME_PRIVILEGES = {
  scheme: 'dutydeck-plugin',
  privileges: {
    standard: true,
    secure: true,
    supportFetchAPI: true,
    corsEnabled: true,
    stream: true,
  },
} as const

/** Surface 静态资源允许的响应类型，未知类型按二进制下载处理。 */
const MIME_TYPES: Readonly<Record<string, string>> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.woff2': 'font/woff2',
}

/** 最小 CSP 禁止网络、表单、嵌套浏览上下文和对象嵌入。 */
const SURFACE_CSP = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
  "font-src 'self'",
  "media-src 'self'",
  "connect-src 'none'",
  "frame-src 'none'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
].join('; ')

/** 创建统一 404，不泄露包路径或 token 是否存在。 */
function notFound(): Response {
  return new Response('Not Found', {
    status: 404,
    headers: { 'content-type': 'text/plain; charset=utf-8', 'x-content-type-options': 'nosniff' },
  })
}

/**
 * 处理 dutydeck-plugin://<surface-token>/surfaces/...。
 * token 由 main 打开 Surface 时签发，renderer 不能提交绝对文件路径。
 * @param request Electron 自定义协议请求。
 * @returns 有界静态文件响应或统一 404。
 */
export function handlePluginSurfaceRequest(request: Request): Response {
  try {
    const url = new URL(request.url)
    if (url.protocol !== 'dutydeck-plugin:') return notFound()
    const manager = getModuleRuntimeManager()
    if (!manager) return notFound()
    const relativePath = decodeURIComponent(url.pathname.replace(/^\/+/, ''))
    const path = manager.resolveSurfaceResource(url.hostname, relativePath)
    const stat = statSync(path)
    if (!stat.isFile() || stat.size > 32 * 1024 * 1024) return notFound()
    const bytes = readFileSync(path)
    const contentType = MIME_TYPES[extname(path).toLowerCase()] ?? 'application/octet-stream'
    return new Response(bytes, {
      status: 200,
      headers: {
        'content-type': contentType,
        'content-length': String(bytes.byteLength),
        'content-security-policy': SURFACE_CSP,
        'x-content-type-options': 'nosniff',
        'referrer-policy': 'no-referrer',
        'access-control-allow-origin': '*',
        'cross-origin-resource-policy': 'cross-origin',
        'cache-control': 'no-store',
      },
    })
  } catch {
    return notFound()
  }
}

/** 在 app ready 后注册只读 Surface 协议。 */
export function registerPluginSurfaceProtocol(): void {
  const { protocol } = require('electron') as typeof import('electron')
  protocol.handle('dutydeck-plugin', handlePluginSurfaceRequest)
}
