import { atom, useAtomValue } from 'jotai'
import type { ComputerUseApi, ComputerUseSnapshot } from '@dutydeck/shared'
import { connectComputerUse } from './computer-use-sync'

/** 所有设置与会话视图共享同一状态和订阅。 */
interface ComputerUseViewState {
  snapshot: ComputerUseSnapshot | null
  error: string | null
  /** 配置请求的加载态，不阻断紧急停止。 */
  busy: boolean
  /** 正在等待停止回执的操作身份。 */
  stoppingOperationId: string | null
  /** 独立停止入口，仅对同一活动操作去重。 */
  stop: ((id: string) => Promise<void>) | null
  request: ((action: (api: ComputerUseApi) => Promise<ComputerUseSnapshot>) => Promise<void>) | null
}
/** 首次挂载才连接 IPC，最后一个视图卸载时释放。 */
export const computerUseStateAtom = atom<ComputerUseViewState>({ snapshot: null, error: null, busy: false, stoppingOperationId: null, stop: null, request: null })
computerUseStateAtom.onMount = set => {
  /** 关闭后不再接受异步请求或更新状态。 */
  let disposed = false
  let busy = false
  /** 最新宿主快照用于拒绝已失效的停止按钮。 */
  let currentSnapshot: ComputerUseSnapshot | null = null
  /** 只对同一操作的停止去重，不受安装检测和路径选择影响。 */
  const stoppingIds = new Set<string>()
  /** 主窗口独有的窄 API。 */
  const api = window.electronAPI.computerUse
  /** 当前挂载期的订阅与过期响应保护。 */
  const connection = connectComputerUse(api, snapshot => { currentSnapshot = snapshot; set(previous => ({ ...previous, snapshot })) },
    error => set(previous => ({ ...previous, error })))
  set(previous => ({ ...previous, stop: async id => {
    if (disposed || currentSnapshot?.operation?.id !== id || currentSnapshot.operation.status === 'stopping' || stoppingIds.has(id)) return
    stoppingIds.add(id)
    set(current => ({ ...current, stoppingOperationId: id }))
    await connection.run(() => api.stop(id))
    stoppingIds.delete(id)
    if (!disposed) set(current => current.stoppingOperationId === id ? { ...current, stoppingOperationId: null } : current)
  }, request: async action => {
    if (disposed || busy) return
    busy = true
    set(current => ({ ...current, busy: true }))
    await connection.run(() => action(api))
    busy = false
    if (!disposed) set(current => ({ ...current, busy: false }))
  } }))
  return () => { disposed = true; connection.dispose(); set({ snapshot: null, error: null, busy: false, stoppingOperationId: null, stop: null, request: null }) }
}
/** 读取共享状态；调用者不创建独立轮询或订阅。 */
export function useComputerUse(): ComputerUseViewState { return useAtomValue(computerUseStateAtom) }
