/** 轮询所需的宿主能力；注入时钟便于验证清理与隐藏行为。 */
export interface ModuleReceiptPollerOptions {
  /** 读取回执；发布数据前调用 isCurrent，阻止卸载后的迟到结果。 */
  load: (isCurrent: () => boolean) => Promise<void>
  isVisible: () => boolean
  subscribeVisibility: (callback: () => void) => () => void
  schedule: (callback: () => void, delay: number) => () => void
}

/** 启动低频可见轮询，返回刷新/清理函数；同一时刻至多一个请求，不依赖 token 更新。 */
export function createModuleReceiptPoller(options: ModuleReceiptPollerOptions): { refresh: () => void; dispose: () => void } {
  /** 生命周期与单请求互斥标记。 */
  let disposed = false
  let pending = false
  /** 等待中的计时器释放函数。 */
  let cancelTimer: (() => void) | undefined
  /** 仅当前挂载会话可以发布结果。 */
  const isCurrent = (): boolean => !disposed
  /** 可见时读取，完成后再等三秒；失败同样允许后续重试。 */
  const refresh = (): void => {
    cancelTimer?.()
    cancelTimer = undefined
    if (disposed || pending || !options.isVisible()) return
    pending = true
    void options.load(isCurrent).finally(() => {
      pending = false
      if (!disposed && options.isVisible()) cancelTimer = options.schedule(refresh, 3000)
    })
  }
  /** 隐藏立即撤销计时器；重新可见时刷新当前权威快照。 */
  const unsubscribe = options.subscribeVisibility(refresh)
  refresh()
  return {
    refresh,
    dispose: () => { disposed = true; cancelTimer?.(); unsubscribe() },
  }
}
