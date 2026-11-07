import { useMemo } from 'react'
import { atom, useAtomValue, useStore } from 'jotai'

/** 管理操作和目录刷新分别执行；页面与配置编辑器共享明确的保存结果。 */
export function usePluginManagement(refresh: () => Promise<void>, errorMessage: (cause: unknown) => string) {
  const state = useMemo(() => atom<{ busy: boolean; error: string | null }>({ busy: false, error: null }), [])
  const store = useStore()
  const value = useAtomValue(state)
  const manage = async (operation: () => Promise<void>): Promise<boolean> => {
    if (store.get(state).busy) return false
    store.set(state, { busy: true, error: null })
    try {
      await operation()
      return true
    } catch (cause) {
      // 刷新失败也不替换原操作错误，更不把保存失败转换为成功。
      try { await refresh() } catch { /* 保留原始错误 */ }
      store.set(state, { busy: true, error: errorMessage(cause) })
      return false
    } finally {
      store.set(state, previous => ({ ...previous, busy: false }))
    }
  }
  return { ...value, manage }
}
