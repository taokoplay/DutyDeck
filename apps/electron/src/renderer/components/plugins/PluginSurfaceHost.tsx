import * as React from 'react'

/** Surface bridge 的单次请求；surface 只能调用宿主白名单方法。 */
export interface PluginSurfaceBridgeRequest {
  method: string
  input: unknown
}

/** Surface host 属性；实际 URL 必须包含 main 签发的短期 token。 */
export interface PluginSurfaceHostProps {
  title: string
  sourceUrl: string
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

/**
 * 在隔离 iframe 中承载插件 Surface，并通过 MessagePort 提供显式 bridge。
 * @param props 入口 URL、标题和宿主 bridge 处理函数。
 * @returns 自适应工作区；入口缺失或 bridge 断连时显示稳定错误。
 */
export function PluginSurfaceHost(props: PluginSurfaceHostProps): React.JSX.Element {
  const frame = React.useRef<HTMLIFrameElement>(null)
  const [error, setError] = React.useState<string | null>(null)
  const bridge = React.useRef(props.onBridgeRequest)
  React.useEffect(() => {
    bridge.current = props.onBridgeRequest
  }, [props.onBridgeRequest])

  React.useEffect(() => {
    if (!props.sourceUrl) return
    const iframe = frame.current
    if (!iframe) return
    let port: MessagePort | undefined
    const connect = (): void => {
      port?.close()
      const channel = new MessageChannel()
      port = channel.port1
      port.onmessage = (event: MessageEvent<unknown>) => {
        if (!isBridgeRequest(event.data)) return
        const request = event.data
        void bridge.current({ method: request.method, input: request.input }).then(
          value => port?.postMessage({ type: 'plugin.surface.response', requestId: request.requestId, ok: true, value }),
          () => port?.postMessage({
            type: 'plugin.surface.response',
            requestId: request.requestId,
            ok: false,
            error: { code: 'PLUGIN_SURFACE_BRIDGE_DENIED', message: 'Surface 请求未获授权', retryable: false },
          }),
        )
      }
      port.start()
      iframe.contentWindow?.postMessage(
        { type: 'dutydeck.plugin.surface.connected' },
        '*',
        [channel.port2],
      )
    }
    iframe.addEventListener('load', connect)
    return () => {
      iframe.removeEventListener('load', connect)
      port?.close()
    }
  }, [props.sourceUrl])

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
      <iframe
        ref={frame}
        title={props.title}
        src={props.sourceUrl}
        sandbox="allow-scripts"
        referrerPolicy="no-referrer"
        onError={() => setError('PLUGIN_SURFACE_ENTRY_MISSING')}
        className="min-h-0 w-full flex-1 border-0 bg-background"
      />
    </div>
  )
}
