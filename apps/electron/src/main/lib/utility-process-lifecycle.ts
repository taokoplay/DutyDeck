/** utility process 退出等待的稳定超时错误码。 */
export const UTILITY_PROCESS_EXIT_TIMEOUT_CODE = 'UTILITY_PROCESS_EXIT_TIMEOUT'
/** 与 Agent 现有启动预算一致的默认退出等待时限。 */
const DEFAULT_UTILITY_PROCESS_EXIT_TIMEOUT_MS = 15_000

/** 共享 helper 使用的 Electron utility process 最小生命周期合同。 */
export interface UtilityProcessLifecycleTarget {
  /** spawn 成功后、exit 事件前可见的 PID。 */
  readonly pid: number | undefined
  once(event: 'spawn', listener: () => void): this
  once(event: 'exit', listener: (code: number) => void): this
  kill(): boolean
}

/** utility process 生命周期可调预算。 */
export interface UtilityProcessLifecycleOptions {
  /** stop 等待真实 exit 的最长时间。 */
  exitTimeoutMs?: number
  /** 优雅终止后升级为操作系统强制终止前的等待时间。 */
  forceKillGraceMs?: number
  /** 按已确认的 utility PID 执行操作系统级强制终止，便于测试替换。 */
  forceKill?: (pid: number) => void
}

/** fork 后立即创建的可等待 utility process 生命周期。 */
export interface UtilityProcessLifecycle<T extends UtilityProcessLifecycleTarget> {
  /** 与生命周期绑定的原始 Electron utility process。 */
  readonly process: T
  /** 是否已经收到 Electron 的 exit 事件。 */
  readonly hasExited: boolean
  /** 请求停止并等待 Electron 确认进程退出。 */
  stop(): Promise<void>
  /** 等待 Electron exit 事件并返回退出码。 */
  waitForExit(): Promise<number>
}

/** 带稳定错误码的 utility process 退出超时。 */
interface UtilityProcessExitTimeoutError extends Error {
  code: typeof UTILITY_PROCESS_EXIT_TIMEOUT_CODE
}

/** 创建 utility process 退出超时错误。 */
function createExitTimeoutError(timeoutMs: number): UtilityProcessExitTimeoutError {
  /** 对调用方暴露稳定错误码的退出超时。 */
  const error = new Error(`Utility process did not exit within ${timeoutMs}ms`) as UtilityProcessExitTimeoutError
  error.code = UTILITY_PROCESS_EXIT_TIMEOUT_CODE
  return error
}

/** 默认按已确认 PID 发送强制终止信号；Windows 与 POSIX 均支持 SIGKILL。 */
function forceKillUtilityProcess(pid: number): void {
  process.kill(pid, 'SIGKILL')
}

/** 为退出 Promise 增加独立有界时限。 */
async function waitWithTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  /** 当前退出等待的定时器。 */
  let timer: ReturnType<typeof setTimeout> | undefined
  /** 达到预算后拒绝等待的 Promise。 */
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(createExitTimeoutError(timeoutMs)), timeoutMs)
  })
  try {
    return await Promise.race([promise, timeout])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

/**
 * fork 返回后立即跟踪 spawn/exit；即使 stop 早于 spawn，也会在 spawn 到达后终止，
 * 并且只有真实 exit 事件才能完成停止。Electron 的 `kill()` 只承诺优雅终止，
 * 因此在有界宽限后通过 PID 升级为强制终止，避免 Windows 上错误回合被清理卡住。
 */
export function createUtilityProcessLifecycle<T extends UtilityProcessLifecycleTarget>(
  process: T,
  options: UtilityProcessLifecycleOptions = {},
): UtilityProcessLifecycle<T> {
  /** 本次退出等待使用的有界预算。 */
  const exitTimeoutMs = options.exitTimeoutMs ?? DEFAULT_UTILITY_PROCESS_EXIT_TIMEOUT_MS
  /** 当前预算内的强制终止宽限，短测试预算下按一半收窄。 */
  const forceKillGraceMs = Math.min(
    exitTimeoutMs,
    Math.max(1, options.forceKillGraceMs ?? Math.min(2_000, Math.floor(exitTimeoutMs / 2))),
  )
  /** 生产默认按 PID 发送 SIGKILL，测试可注入无副作用的强制终止函数。 */
  const forceKill = options.forceKill ?? forceKillUtilityProcess
  /** fork 返回时是否已经完成底层 spawn。 */
  let spawned = process.pid !== undefined
  /** 是否已经收到真实 exit 事件。 */
  let exited = false
  /** 是否已有调用方请求停止。 */
  let stopRequested = false
  /** 多个 stop 调用共享的单一停止 Promise。 */
  let stopPromise: Promise<void> | undefined
  /** 完成退出等待的函数。 */
  let resolveExit = (_code: number): void => undefined
  /** 真实 exit 事件对应的 Promise。 */
  const exitPromise = new Promise<number>((resolve) => { resolveExit = resolve })
  /** 当前停止尝试中传播 kill 同步失败的函数。 */
  let rejectCurrentStop: ((error: Error) => void) | undefined
  /** 当前停止尝试等待强制终止宽限的定时器。 */
  let forceKillTimer: ReturnType<typeof setTimeout> | undefined

  /** 请求 Electron 优雅终止；返回 false 仍必须等待 exit 或超时。 */
  const requestKill = (): void => {
    try {
      process.kill()
    } catch (error) {
      rejectCurrentStop?.(error instanceof Error ? error : new Error(String(error)))
    }
  }

  /** 优雅终止未产生 exit 时，按已确认 PID 升级为强制终止。 */
  const scheduleForceKill = (): void => {
    if (forceKillTimer || exited) return
    forceKillTimer = setTimeout(() => {
      forceKillTimer = undefined
      if (exited) return
      /** 发送强杀时仍存活的 utility PID；spawn 前不能凭 undefined 操作其他进程。 */
      const pid = process.pid
      if (pid === undefined) return
      try {
        forceKill(pid)
      } catch {
        // 强制终止失败不提前结算；总超时仍以真实 exit 为唯一成功条件。
      }
    }, forceKillGraceMs)
  }

  process.once('spawn', () => {
    spawned = true
    if (stopRequested && !exited) {
      requestKill()
      scheduleForceKill()
    }
  })
  process.once('exit', (code) => {
    exited = true
    if (forceKillTimer) {
      clearTimeout(forceKillTimer)
      forceKillTimer = undefined
    }
    resolveExit(code)
  })

  return {
    process,
    get hasExited(): boolean {
      return exited
    },
    stop(): Promise<void> {
      if (exited) return Promise.resolve()
      if (stopPromise) return stopPromise
      stopRequested = true
      /** 当前停止尝试专用的 kill 失败 Promise，超时后不会污染下一次重试。 */
      const killFailure = new Promise<never>((_resolve, reject) => { rejectCurrentStop = reject })
      if (spawned) {
        requestKill()
        scheduleForceKill()
      }
      /** 当前停止尝试会在 settled 后释放，允许进程迟到 exit 后重新收尾。 */
      const currentStop = waitWithTimeout(
        Promise.race([exitPromise.then(() => undefined), killFailure]),
        exitTimeoutMs,
      )
      /** 带清理逻辑的当前共享停止 Promise。 */
      const trackedStop = currentStop.finally(() => {
        if (stopPromise === trackedStop) stopPromise = undefined
        rejectCurrentStop = undefined
        if (forceKillTimer) {
          clearTimeout(forceKillTimer)
          forceKillTimer = undefined
        }
      })
      stopPromise = trackedStop
      return stopPromise
    },
    waitForExit(): Promise<number> {
      return exitPromise
    },
  }
}
