import type { ComputerUseApi, ComputerUseSnapshot } from '@dutydeck/shared'

/** 单次订阅生命周期，读取响应不能覆盖更新的事件。 */
export function connectComputerUse(api: ComputerUseApi, onSnapshot: (snapshot: ComputerUseSnapshot) => void,
  onError: (message: string | null) => void) {
  /** 卸载标识及事件序号共同阻止迟到写入。 */
  let disposed = false
  let revision = 0
  /** 订阅先于初次读取，关闭挂载窗口中的丢事件风险。 */
  const unsubscribe = api.onChanged(snapshot => {
    if (disposed) return
    revision += 1
    onSnapshot(snapshot)
  })
  /** 执行配置请求并接纳未过期的响应；失败保留上次状态。 */
  async function run(request: () => Promise<ComputerUseSnapshot>): Promise<void> {
    /** 记录本次请求开始时的状态代次。 */
    const started = revision
    if (!disposed) onError(null)
    try {
      /** 宿主确认的最终状态。 */
      const snapshot = await request()
      if (!disposed && revision === started) { revision += 1; onSnapshot(snapshot) }
    } catch (error) {
      if (!disposed) onError(error instanceof Error ? error.message : '电脑控制请求失败')
    }
  }
  void run(() => api.getSnapshot())
  return { run, dispose: () => { disposed = true; unsubscribe() } }
}
