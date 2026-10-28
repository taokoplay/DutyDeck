import * as React from 'react'
import type { ComputerUseOperation as Operation } from '@dutydeck/shared'
import { Button } from '../ui/button'

/** 最近观察卡片；隐藏画面只影响显示，不代表停止操作。 */
export function ComputerUseOperation({ operation, stopping, onStop }: {
  /** 当前租约身份与最后画面。 */
  operation: Operation
  /** 当前操作的停止请求状态，与配置加载态独立。 */
  stopping: boolean
  /** 必须传入本张卡片的操作身份。 */
  onStop: (id: string) => void
}): React.ReactElement {
  return <section className="space-y-2 rounded-lg border bg-muted/20 p-3" aria-label="当前电脑操作">
    <div className="flex items-center justify-between gap-3">
      <div className="min-w-0"><p className="truncate text-sm font-medium">{operation.title || '未命名窗口'}</p>
        <p className="text-xs text-muted-foreground">{operation.status === 'stopping' ? '正在停止，等待当前调用退出' : '正在控制此窗口'}</p></div>
      <Button size="sm" variant="outline" disabled={stopping || operation.status === 'stopping'} onClick={() => onStop(operation.id)}>停止操作</Button>
    </div>
    <p className="text-xs text-muted-foreground">{operation.observedAt ? `最近观察：${new Date(operation.observedAt).toLocaleString()}（非实时）` : '尚未获取观察画面'}</p>
    {operation.image && <details><summary className="cursor-pointer text-xs">查看最近观察画面</summary>
      <img className="mt-2 max-h-64 max-w-full rounded object-contain" src={operation.image} alt="目标窗口最近一次观察画面，非实时" /></details>}
    <p className="text-xs text-muted-foreground">停止后不再提交新操作，已经发生的输入无法撤回。</p>
  </section>
}
