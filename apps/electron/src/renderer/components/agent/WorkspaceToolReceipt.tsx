import * as React from 'react'
import { useAtomValue, useSetAtom } from 'jotai'
import { openWorkspaceToolAtom, workspaceToolAvailabilityAtom, workspaceToolReceiptAtom } from '@/atoms/workspace-tools'
import { Button } from '@/components/ui/button'

/** 显示当前会话最新动态工具请求；重试沿用工具栏的可用性与归属校验。 */
export function WorkspaceToolReceipt({ sessionId }: { sessionId: string }): React.ReactElement | null {
  /** 消费队列后仍保留的请求终态。 */
  const receipt = useAtomValue(workspaceToolReceiptAtom(sessionId))
  /** 失败重试不能绕过当前功能开关或项目权限。 */
  const availability = useAtomValue(workspaceToolAvailabilityAtom)
  /** 唯一工具导航命令。 */
  const openTool = useSetAtom(openWorkspaceToolAtom)
  if (!receipt) return null
  /** 简短工具名称用于可访问状态提示。 */
  const label = { browser: '浏览器', terminal: '终端', canvas: '画布' }[receipt.tool]
  /** 终端回执只证明标签已打开，PTY 就绪由终端本身负责显示。 */
  const message = receipt.message ?? (receipt.status === 'pending' ? `正在打开${label}…` : `${label}标签已打开`)
  return (
    <div role="status" aria-live="polite" aria-atomic="true" data-workspace-tool-status={receipt.status} className="flex shrink-0 items-center gap-2 border-b border-border px-3 py-1.5 text-xs text-muted-foreground">
      <span className="min-w-0 flex-1 break-words">{message}</span>
      {(receipt.status === 'failed' || receipt.status === 'canceled') && (
        <Button variant="ghost" size="sm" disabled={!availability[receipt.tool].visible || Boolean(availability[receipt.tool].disabledReason)} onClick={() => openTool(receipt.tool)} aria-label={`重新打开${label}`}>重试</Button>
      )}
    </div>
  )
}
