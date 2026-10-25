import * as React from 'react'
import {
  PLUGIN_SURFACE_CONNECTED_MESSAGE,
  PLUGIN_SURFACE_READY_MESSAGE,
  PLUGIN_SURFACE_THEME_MESSAGE,
} from '@dutydeck/plugin-sdk'
import { readPluginSurfaceTheme } from './plugin-surface-theme'

/** Surface bridge 的单次请求；surface 只能调用宿主白名单方法。 */
export interface PluginSurfaceBridgeRequest {
  method: string
  input: unknown
}

/** Surface host 属性；实际 URL 必须包含 main 签发的短期 token。 */
export interface PluginSurfaceHostProps {
  title: string
  sourceUrl: string
  /** true 表示插件模块未在当前会话启用，Surface 只能读取。 */
  readOnly?: boolean
  onBridgeRequest: (request: PluginSurfaceBridgeRequest) => Promise<unknown>
}

/** iframe 内发来的消息必须证据确凿，未知形状直接忽略。 */
function isBridgeRequest(value: unknown): value is {
  type: 'plugin.surface.request'
  requestId: string
  method: string
  input: unknown
} {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const record = value as Record<string, unknown>
  return record.type === 'plugin.surface.request'
    && typeof record.requestId === 'string'
    && record.requestId.length > 0
    && record.requestId.length <= 128
    && typeof record.method === 'string'
    && /^[a-z][A-Za-z0-9_]{0,63}$/.test(record.method)
}

/** Surface 脚本就绪消息只接受单一 type 字段，避免普通页面消息触发重连。 */
export function isPluginSurfaceReadyMessage(value: unknown): value is { type: typeof PLUGIN_SURFACE_READY_MESSAGE } {
  return value !== null
    && typeof value === 'object'
    && !Array.isArray(value)
    && Object.keys(value).length === 1
    && (value as Record<string, unknown>).type === PLUGIN_SURFACE_READY_MESSAGE
}

/** 从 Electron IPC 包装错误中提取稳定插件错误码，正文不进入 Surface。 */
export function pluginSurfaceBridgeErrorCode(cause: unknown): string {
  const message = cause instanceof Error ? cause.message : String(cause)
  return message.match(/PLUGIN_[A-Z0-9_]{1,80}/)?.[0] ?? 'PLUGIN_SURFACE_BRIDGE_DENIED'
}

/**
 * 在隔离 iframe 中承载插件 Surface，并通过 MessagePort 提供显式 bridge。
 * @param props 入口 URL、标题和宿主 bridge 处理函数。
 * @returns 自适应工作区；入口缺失或 bridge 断连时显示稳定错误。
 */
export function PluginSurfaceHost(props: PluginSurfaceHostProps): React.JSX.Element {
  const frame = React.useRef<HTMLIFrameElement>(null)
  const portRef = React.useRef<MessagePort>()
  const [error, setError] = React.useState<string | null>(null)
  const bridge = React.useRef(props.onBridgeRequest)
  React.useEffect(() => {
    bridge.current = props.onBridgeRequest
  }, [props.onBridgeRequest])

  /** React onLoad 在 iframe 文档子资源完成后触发，避免 effect 注册监听错过快速加载。 */
  const connect = React.useCallback((): void => {
    const iframe = frame.current
    if (!iframe?.contentWindow) return
    portRef.current?.close()
    const channel = new MessageChannel()
    const port = channel.port1
    portRef.current = port
    port.onmessage = (event: MessageEvent<unknown>) => {
      if (!isBridgeRequest(event.data)) return
      const request = event.data
      void bridge.current({ method: request.method, input: request.input }).then(
        value => port.postMessage({ type: 'plugin.surface.response', requestId: request.requestId, ok: true, value }),
        (cause: unknown) => port.postMessage({
          type: 'plugin.surface.response',
          requestId: request.requestId,
          ok: false,
          error: { code: pluginSurfaceBridgeErrorCode(cause), message: 'Surface 请求失败', retryable: false },
        }),
      )
    }
    port.start()
    iframe.contentWindow.postMessage(
      { type: PLUGIN_SURFACE_CONNECTED_MESSAGE },
      '*',
      [channel.port2],
    )
    /** 端口连接后立即下发主题；后续主题变化复用同一消息类型。 */
    iframe.contentWindow.postMessage({
      type: PLUGIN_SURFACE_THEME_MESSAGE,
      theme: readPluginSurfaceTheme(),
    }, '*')
  }, [])

  /** 主题变化时只广播设计令牌，不重建 iframe 或丢失页面状态。 */
  const syncTheme = React.useCallback((): void => {
    frame.current?.contentWindow?.postMessage({
      type: PLUGIN_SURFACE_THEME_MESSAGE,
      theme: readPluginSurfaceTheme(),
    }, '*')
  }, [])

  React.useEffect(() => {
    if (!props.sourceUrl) return
    const iframe = frame.current
    if (!iframe) return
    /** Surface 脚本也可主动发起握手，覆盖浏览器跳过 onLoad 或挂载时序差异。 */
    const onReady = (event: MessageEvent<unknown>): void => {
      if (event.source !== iframe.contentWindow || !isPluginSurfaceReadyMessage(event.data)) return
      connect()
    }
    window.addEventListener('message', onReady)
    return () => {
      window.removeEventListener('message', onReady)
    }
  }, [connect, props.sourceUrl])

  React.useEffect(() => {
    if (!props.sourceUrl) return
    const root = document.documentElement
    const observer = new MutationObserver(syncTheme)
    observer.observe(root, { attributes: true, attributeFilter: ['class', 'style', 'data-theme'] })
    const colorScheme = window.matchMedia('(prefers-color-scheme: dark)')
    colorScheme.addEventListener('change', syncTheme)
    return () => {
      observer.disconnect()
      colorScheme.removeEventListener('change', syncTheme)
    }
  }, [props.sourceUrl, syncTheme])

  React.useEffect(() => () => {
    portRef.current?.close()
  }, [])

  if (!props.sourceUrl) {
    return (
      <div role="alert" className="flex flex-1 items-center justify-center p-6 text-xs text-destructive">
        PLUGIN_SURFACE_ENTRY_MISSING
      </div>
    )
  }
  return (
    <div className="relative flex min-h-0 flex-1 flex-col overflow-hidden">
      {error && (
        <div role="alert" className="border-b border-border px-3 py-2 text-xs text-destructive">
          {error}
        </div>
      )}
      {props.readOnly && (
        <div role="status" className="border-b border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs leading-5 text-amber-800 dark:text-amber-200">
          当前会话尚未启用{props.title}，可查看但不能修改。请关闭此标签，再从右侧工具菜单重新接入模块。
        </div>
      )}
      <iframe
        ref={frame}
        title={props.title}
        src={props.sourceUrl}
        onLoad={connect}
        sandbox="allow-scripts"
        referrerPolicy="no-referrer"
        onError={() => setError('PLUGIN_SURFACE_ENTRY_MISSING')}
        className="min-h-0 w-full flex-1 border-0 bg-background"
      />
    </div>
  )
}
