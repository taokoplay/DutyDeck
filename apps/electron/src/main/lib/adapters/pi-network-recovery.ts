import type { StreamFn } from '@earendil-works/pi-agent-core'
import type { AssistantMessage, AssistantMessageEvent, Transport } from '@earendil-works/pi-ai'
import type { NetworkDiagnosticInput, NetworkRecoveryNotice } from '@dutydeck/shared'
import type { Dispatcher } from 'undici'
import {
  closePiRequestProxyDispatcher,
  createPiRequestProxyDispatcher,
  runWithPiRequestProxy,
  type PiRequestProxyOptions,
} from './pi-request-proxy'

/** 当前 query 的可信网络快照；不通过 renderer 或模型创建。 */
export interface PiNetworkRecoverySource {
  /** undefined 表示还未初始化，明确直连由有 epoch 的空 proxyUrl 表示。 */
  getSnapshot(): NetworkRecoveryNotice | undefined
  /** 只订阅当前 query，返回退订函数。 */
  subscribe(listener: (notice: NetworkRecoveryNotice) => void): () => void
}

/** 每次 provider 调用重新计算的连接设置。 */
export interface PiRecoveryRequestOptions extends PiRequestProxyOptions {
  /** 保留用户显式 transport；默认 Codex 代理可选 SSE。 */
  transport?: Transport
}

/** 流恢复的依赖；测试可缩短宽限时间，无全局计时器。 */
interface PiNetworkRecoveryOptions {
  /** 当前 query 的网络事件源。 */
  source?: PiNetworkRecoverySource
  /** 默认 10 秒，仅网络变化后才启用。 */
  stallTimeoutMs?: number
  /** 每次 native retry 都以最新快照创建连接池。 */
  requestOptions?: (notice: NetworkRecoveryNotice | undefined) => PiRecoveryRequestOptions
  /** 只发送枚举和数字，禁止向诊断传递错误正文。 */
  onDiagnostic?: (input: NetworkDiagnosticInput) => void
}

/** 从错误中提取粗分类，返回值不含原始错误、地址或凭据。 */
function classifyFailure(message: string | undefined): NetworkDiagnosticInput['code'] {
  if (/401|403|unauthorized|authentication/i.test(message ?? '')) return 'authentication'
  if (/429|rate.limit/i.test(message ?? '')) return 'rate_limit'
  if (/dns|enotfound|eai_again/i.test(message ?? '')) return 'dns'
  if (/timeout|timed.out/i.test(message ?? '')) return 'timeout'
  if (/network|fetch failed|connection|socket/i.test(message ?? '')) return 'connection'
  return 'provider_error'
}

/**
 * 包装单次模型流，返回符合 Pi 协议的独立终态流。
 * 网络变化只中断停滞的 provider；不重放 prompt、工具或 MCP 请求。
 */
export function createRecoveringPiStream(provider: StreamFn, config: PiNetworkRecoveryOptions): StreamFn {
  return async (model, context, options) => {
    /** Pi 只提供 ESM 导出；主进程 CJS 包必须异步加载公开入口。 */
    const { createAssistantMessageEventStream } = await import('@earendil-works/pi-ai')
    /** 即使内层忽略 abort，外层也能自行结束，不阻塞 Pi native retry。 */
    const output = createAssistantMessageEventStream()
    const controller = new AbortController()
    const startedAt = performance.now()
    const initialSnapshot = config.source?.getSnapshot()
    let epoch = initialSnapshot?.epoch ?? 0
    let settled = false
    let timer: ReturnType<typeof setTimeout> | undefined
    let unsubscribe: (() => void) | undefined
    let dispatcher: Dispatcher | undefined
    let latest: AssistantMessage | undefined
    /** 使忽略 abort 的 provider 不再挂住外层 pump 的生命周期。 */
    let releasePump: (() => void) | undefined
    const ended = new Promise<undefined>((resolve) => { releasePump = () => resolve(undefined) })
    /** 诊断异常只影响可观测性，不影响模型终态。 */
    const diagnose = (phase: NetworkDiagnosticInput['phase'], code: NetworkDiagnosticInput['code']): void => {
      try { config.onDiagnostic?.({ phase, code, durationMs: Math.max(0, performance.now() - startedAt) }) } catch { /* 诊断不得破坏业务。 */ }
    }
    /** 每个流只清理一次；强制中断不等待可能永不完成的 close。 */
    const cleanup = (force: boolean): void => {
      if (timer) clearTimeout(timer)
      timer = undefined
      unsubscribe?.()
      unsubscribe = undefined
      options?.signal?.removeEventListener('abort', abort)
      if (force) {
        controller.abort()
        void dispatcher?.destroy().catch(() => {})
      } else {
        void closePiRequestProxyDispatcher(dispatcher)
      }
    }
    /** 构造协议合法的失败消息，保留已报告 usage，避免伪造成功。 */
    const failureMessage = (reason: 'error' | 'aborted', errorMessage: string): AssistantMessage => ({
      ...(latest ?? {
        role: 'assistant', content: [], api: model.api, provider: model.provider, model: model.id,
        timestamp: Date.now(), usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
      }),
      stopReason: reason, errorMessage,
    })
    /** 唯一终态门控：成功、真实失败、取消、停滞竞争只能有一个胜者。 */
    const finish = (event: Extract<AssistantMessageEvent, { type: 'done' | 'error' }>, force = false): void => {
      if (settled) return
      settled = true
      releasePump?.()
      output.push(event)
      const finalMessage = event.type === 'done' ? event.message : event.error
      output.end(finalMessage)
      diagnose(finalMessage.stopReason === 'aborted' ? 'cancelled' : event.type === 'done' ? 'completed' : 'failed',
        event.type === 'done' ? 'unknown' : classifyFailure(finalMessage.errorMessage))
      cleanup(force)
    }
    /** 用户取消始终使用 aborted，Pi 不得把它当网络故障重试。 */
    function abort(): void {
      finish({ type: 'error', reason: 'aborted', error: failureMessage('aborted', 'Request aborted') }, true)
    }
    /** 网络变化后启用一次宽限，首条后续事件即证明通路恢复。 */
    const arm = (): void => {
      if (timer) clearTimeout(timer)
      timer = setTimeout(() => {
        if (settled) return
        if (options?.signal?.aborted) { abort(); return }
        diagnose('stalled', 'timeout')
        finish({ type: 'error', reason: 'error', error: failureMessage('error', 'Network error: provider stalled after network change') }, true)
      }, config.stallTimeoutMs ?? 10_000)
      timer.unref?.()
    }
    options?.signal?.addEventListener('abort', abort, { once: true })
    if (options?.signal?.aborted) { abort(); return output }
    unsubscribe = config.source?.subscribe((notice) => {
      if (settled || notice.epoch <= epoch) return
      epoch = notice.epoch
      arm()
    })
    /** 在创建和迭代 lazy provider 的整个异步链中绑定请求级代理。 */
    void (async () => {
      try {
        if (settled) return
        const connection = config.requestOptions?.(initialSnapshot)
        dispatcher = connection ? createPiRequestProxyDispatcher(connection) : undefined
        await runWithPiRequestProxy(dispatcher, async () => {
          const inner = await Promise.race([ended, provider(model, context, { ...options, signal: controller.signal,
            ...(connection?.transport ? { transport: connection.transport } : {}) })])
          if (!inner || settled) return
          /** next() 与终态竞争，内层静默或无视取消时仍可释放宿主引用。 */
          const iterator = inner[Symbol.asyncIterator]()
          while (!settled) {
            const next = await Promise.race([ended, iterator.next()])
            if (!next || next.done) break
            const event = next.value
            if (settled) break
            if (options?.signal?.aborted) { abort(); break }
            if (event.type === 'done' || event.type === 'error') { finish(event); break }
            latest = event.partial
            // 已有新进度则解除本次停滞判定，不能误杀随后合法的长时间推理。
            if (timer) clearTimeout(timer)
            timer = undefined
            output.push(event)
          }
          if (!settled) {
            // Pi result() 可能永不完成；非协议终止不能静默挂起。
            finish({ type: 'error', reason: 'error', error: failureMessage('error', 'Network error: provider stream ended without a terminal event') }, true)
          }
        })
      } catch (error) {
        if (options?.signal?.aborted) { abort(); return }
        finish({ type: 'error', reason: 'error', error: failureMessage('error', error instanceof Error ? error.message : 'Provider stream failed') }, true)
      }
    })()
    return output
  }
}
