/** 短时恢复窗口，避免密集重启占用资源。 */
export const RENDERER_RECOVERY_WINDOW_MS = 30_000
/** 每个短时窗口及连续故障周期最多自动恢复两次。 */
export const MAX_RENDERER_RECOVERY_ATTEMPTS = 2
/** 页面持续加载完成满一分钟后，才视为恢复健康。 */
export const RENDERER_HEALTHY_RESET_MS = 60_000

/** 根据历史时间戳、当前时间和连续次数，判断是否仍有自动恢复额度。 */
export function canRecoverRenderer(attempts: number[], now: number, consecutiveAttempts = 0): boolean {
  const recentAttempts = attempts.filter((attemptAt) => now - attemptAt < RENDERER_RECOVERY_WINDOW_MS)
  return consecutiveAttempts < MAX_RENDERER_RECOVERY_ATTEMPTS
    && recentAttempts.length < MAX_RENDERER_RECOVERY_ATTEMPTS
}

/** 单个主窗口的恢复预算；只管理 Renderer，不终止后台 Agent。 */
export class RendererRecoveryBudget {
  /** 当前故障周期的自动恢复时间，最多保留两项。 */
  private attempts: number[] = []
  /** 最近一次主页面加载完成时间；加载中、错误页或崩溃时为空。 */
  private healthySince: number | null = null

  /** 加载或失败前结算此前健康期，再中断计时；now 为单调时钟毫秒值。 */
  markLoading(now: number): void {
    this.resetIfHealthy(now)
    this.healthySince = null
  }

  /** 主页面加载完成后开始健康计时；重复事件不能缩短已累计健康期。 */
  markLoaded(now: number): void {
    this.healthySince ??= now
  }

  /** 故障时结算健康期并尝试消耗一次额度；退出与正常结束返回 false。 */
  tryRecover(now: number, isQuitting = false, reason = 'crashed'): boolean {
    this.markLoading(now)
    if (isQuitting || reason === 'clean-exit') return false
    if (!canRecoverRenderer(this.attempts, now, this.attempts.length)) return false
    this.attempts.push(now)
    return true
  }

  /** 用户在错误页主动重试时，显式开始新的故障周期。 */
  resetForManualRetry(): void {
    this.attempts = []
    this.healthySince = null
  }

  /** 仅连续健康达到阈值后释放连续故障预算，避免 load→crash 循环。 */
  private resetIfHealthy(now: number): void {
    if (this.healthySince !== null && now - this.healthySince >= RENDERER_HEALTHY_RESET_MS) {
      this.attempts = []
    }
  }
}
