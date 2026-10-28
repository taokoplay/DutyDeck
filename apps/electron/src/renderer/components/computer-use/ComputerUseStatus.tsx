import * as React from 'react'
import { useComputerUse } from '../../atoms/computer-use'
import { ComputerUseOperation } from './ComputerUseOperation'

/** 仅向所属会话显示操作，其他会话不能看到该窗口截图。 */
export function ComputerUseStatus({ sessionId }: { sessionId: string }): React.ReactElement | null {
  /** 共享状态与当前用户会话的匹配租约。 */
  const state = useComputerUse()
  const operation = state.snapshot?.operation
  if (!operation || operation.sessionId !== sessionId) return null
  return <div className="mx-4 my-2"><ComputerUseOperation operation={operation} stopping={state.stoppingOperationId === operation.id}
    onStop={id => { void state.stop?.(id) }} />
    {state.error && <p role="alert" className="mt-2 text-sm text-destructive">{state.error}</p>}
  </div>
}
