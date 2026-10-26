import * as React from 'react'
import { createRoot } from 'react-dom/client'
import type { WorkspacePathState } from '@dutydeck/shared'
/** 只加载正式 Window 类型声明，不执行生产 preload 的运行时代码。 */
import type {} from '../src/preload/index'
import { WorkspacePathList } from '../src/renderer/components/settings/WorkspacePathList'
import '../src/renderer/styles/globals.css'

/** 真设置组件只从生产 preload/IPC 读取工作区状态，不在 renderer 伪造迁移结果。 */
function Smoke(): React.ReactElement {
  /** 状态刷新来自真实 GET_STATE handler；计数用于确认提交结束后的重读。 */
  const [workspaces, setWorkspaces] = React.useState<WorkspacePathState[]>([])
  const [refreshes, setRefreshes] = React.useState(0)
  const [error, setError] = React.useState<string>()
  const refresh = React.useCallback(() => {
    void window.electronAPI.getPathManagementState().then(state => {
      setWorkspaces(state.workspaces ?? [])
      setRefreshes(count => count + 1)
    }).catch(failure => setError(String(failure)))
  }, [])
  React.useEffect(refresh, [refresh])
  return <main className="mx-auto max-w-4xl space-y-6 p-8"><h1 className="text-xl font-semibold">项目存储迁移 · 隔离验收</h1><WorkspacePathList workspaces={workspaces} error={error} onChanged={refresh} /><output data-refreshes={refreshes} className="text-xs text-muted-foreground">状态刷新 {refreshes} 次</output></main>
}

createRoot(document.getElementById('root')!).render(<Smoke />)
