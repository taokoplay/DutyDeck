import * as React from 'react'
import { Loader2 } from 'lucide-react'
import type { WorkspacePathState } from '@dutydeck/shared'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from '@/components/ui/dialog'

/** 项目数据目录迁移的行级状态，普通项目文件位置保持独立。 */
export function ProjectStorageMigrationAction({ workspace, disabled, onChanged }: {
  workspace: WorkspacePathState
  disabled: boolean
  onChanged?: () => void
}): React.ReactElement | null {
  /** 确认前仅显示已有状态，不调用迁移写入口。 */
  const [open, setOpen] = React.useState(false)
  /** 单次提交期间禁用取消和重复请求。 */
  const [busy, setBusy] = React.useState(false)
  /** 保留主进程失败原因，允许用户处理后重试。 */
  const [error, setError] = React.useState<string | null>(null)
  /** 主进程只读检查的模块状态与待处理清单。 */
  const status = workspace.projectStorageMigration
  /** 仅旧位置仍有数据的模块需要执行改名。 */
  const legacy = status?.directories.filter((item) => item.state === 'legacy').map((item) => item.directory) ?? []
  /** 同模块新旧并存必须由用户处理，不自动选取。 */
  const conflicts = status?.directories.filter((item) => item.state === 'conflict').map((item) => item.directory) ?? []
  /** 不可用或不安全目录不得提交。 */
  const blocked = workspace.availability !== 'available' || !status || status.state === 'conflict'
  /** 无剩余目录但有中断日志时仍允许恢复收尾。 */
  const canMigrate = legacy.length > 0 || status?.recoveryRequired === true
  /** 当前目录与迁移恢复分别给出真实状态。 */
  const label = status?.recoveryRequired ? '继续完成项目迁移' : status?.state === 'current' ? '已使用新目录' : status?.state === 'mixed' ? '继续迁移项目数据' : '迁移项目数据'
  /** 根路径仍通过现有工作区授权检查，不能使用 unrestricted。 */
  const openProject = async (): Promise<void> => {
    try {
      const projects = await window.electronAPI.listAgentWorkspaces()
      const project = projects.find((item) => item.id === workspace.workspaceId)
      if (!project) throw new Error('项目不存在')
      await window.electronAPI.openFile(workspace.sourceRoot, { workspaceSlug: project.slug })
    } catch (failure) { setError(failure instanceof Error ? failure.message : '无法打开项目位置') }
  }
  /** 用户显式确认后只传工作区 ID；主进程再次检查忙碌、目录与冲突。 */
  const migrate = async (): Promise<void> => {
    setBusy(true)
    setError(null)
    try {
      await window.electronAPI.migrateProjectStorage(workspace.workspaceId)
      setOpen(false)
    } catch (failure) {
      setError(failure instanceof Error ? failure.message.replace(/^Error invoking remote method '[^']+': (?:Error: )?/, '') : '项目数据迁移失败，可重试')
    } finally { setBusy(false); onChanged?.() }
  }
  if (status?.state === 'none') return null
  return (
    <div className="max-w-64 space-y-1 text-right">
      <Dialog open={open} onOpenChange={(value) => { if (!busy) { setOpen(value); setError(null) } }}>
        <DialogTrigger asChild>
          <Button size="sm" variant="outline" disabled={disabled || busy || blocked || !canMigrate}>{label}</Button>
        </DialogTrigger>
        <DialogContent className="max-w-lg" onEscapeKeyDown={(event) => { if (busy) event.preventDefault() }} onPointerDownOutside={(event) => { if (busy) event.preventDefault() }}>
          <DialogHeader>
            <DialogTitle>迁移 {workspace.name} 的项目数据</DialogTitle>
            <DialogDescription>将下列项目数据从 .proma 移至 .dutydeck，完成后自动重启 DutyDeck。请先备份项目，并关闭其他版本的客户端。</DialogDescription>
          </DialogHeader>
          <div className="space-y-3 text-sm">
            <p className="break-all font-mono text-xs">{workspace.sourceRoot}</p>
            <p>{legacy.length ? `待迁移：${legacy.join('、')}` : '目录已移动，将核对恢复记录并完成迁移。'}</p>
            <p className="text-muted-foreground">旧版 DutyDeck / Proma 将无法读取迁移后的数据。未知的 .proma 内容和已有的 plugin-artifacts 会保留；同名模块冲突会阻止迁移。</p>
            {status?.retainedLegacyEntries.length ? <p className="break-all text-xs">保留旧内容：{status.retainedLegacyEntries.join('、')}</p> : null}
            {error ? <p role="alert" className="text-destructive">{error}</p> : null}
          </div>
          <DialogFooter>
            <Button variant="outline" disabled={busy} onClick={() => setOpen(false)}>取消</Button>
            <Button disabled={busy || blocked || !canMigrate} onClick={() => void migrate()}>{busy ? <Loader2 className="animate-spin" aria-hidden="true" /> : null}迁移并重启</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      {conflicts.length > 0 ? <p className="text-xs text-destructive">目录冲突：{conflicts.join('、')}</p> : null}
      {workspace.projectStorageMigrationError ? <p role="alert" className="text-xs text-destructive">{workspace.projectStorageMigrationError}</p> : null}
      {status?.state === 'mixed' ? <p className="text-xs text-muted-foreground">剩余 {legacy.length} 个旧目录</p> : null}
      {blocked && workspace.availability === 'available' ? <Button size="sm" variant="ghost" onClick={() => void openProject()}>打开项目位置</Button> : null}
      {!open && error ? <p role="alert" className="text-xs text-destructive">{error}</p> : null}
    </div>
  )
}
