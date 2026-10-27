import type { NetworkRecoveryNotice } from '@dutydeck/shared'
/** 每个query绑定的完整身份，不能跨重启或会话复用。 */
interface QueryNetworkIdentity {
  /** utility启动身份。 */
  bootId?: string
  /** 唯一query token。 */
  queryId?: string
  /** 宿主会话身份。 */
  sessionId?: string
}
/** 为单个query提供快照与事件订阅，dispose后拒绝所有消息。 */
export function createQueryNetworkState(identity: QueryNetworkIdentity, initial?: NetworkRecoveryNotice) {
  /** 当前已验证快照，不向调用方暴露可变引用。 */
  let snapshot = initial && Number.isSafeInteger(initial.epoch) && initial.epoch >= 0 ? { ...initial } : undefined
  /** 当前query的监听集合与终止标记。 */
  const listeners = new Set<(notice: NetworkRecoveryNotice) => void>()
  let disposed = false
  return {
    getSnapshot: (): NetworkRecoveryNotice | undefined => snapshot ? { ...snapshot } : undefined,
    subscribe(listener: (notice: NetworkRecoveryNotice) => void): () => void {
      if (!disposed) listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
    accept(context: QueryNetworkIdentity, value: unknown): boolean {
      if (disposed || context.bootId !== identity.bootId || context.queryId !== identity.queryId || context.sessionId !== identity.sessionId) return false
      if (!value || typeof value !== 'object') return false
      /** 按白名单重建内部通知，拒绝非法代次和代理类型。 */
      const notice = value as Record<string, unknown>
      if (typeof notice.epoch !== 'number' || !Number.isSafeInteger(notice.epoch) || notice.epoch < 0 || notice.epoch <= (snapshot?.epoch ?? -1)) return false
      if (notice.proxyUrl !== undefined && typeof notice.proxyUrl !== 'string') return false
      if (notice.previousProxyUrl !== undefined && typeof notice.previousProxyUrl !== 'string') return false
      snapshot = {
        epoch: notice.epoch,
        proxyUrl: notice.proxyUrl as string | undefined,
        previousProxyUrl: notice.previousProxyUrl as string | undefined,
        ...(typeof notice.lastChangedAt === 'number' && Number.isFinite(notice.lastChangedAt) && notice.lastChangedAt >= 0 ? { lastChangedAt: notice.lastChangedAt } : {}),
        ...(['interface', 'resume', 'online', 'manual', 'proxy-settings'].includes(String(notice.reason)) ? { reason: notice.reason as NetworkRecoveryNotice['reason'] } : {}),
      }
      for (const listener of listeners) {
        try { listener({ ...snapshot }) } catch { /* 故障只隔离，不记录可能包含代理凭据的异常。 */ }
      }
      return true
    },
    dispose(): void {
      disposed = true
      listeners.clear()
    },
  }
}
