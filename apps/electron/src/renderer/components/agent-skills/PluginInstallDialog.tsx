import * as React from 'react'
import type { AgentPluginPreview, AgentPluginCatalogSnapshot } from '@dutydeck/shared'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from '@/components/ui/dialog'

/** 用户审核来源、模块与提示后才消费安装令牌。 */
export function PluginInstallDialog({ preview, onClose, onInstalled }: {
  preview: AgentPluginPreview | null
  onClose: () => void
  onInstalled: (snapshot: AgentPluginCatalogSnapshot) => void
}): React.ReactElement {
  /** 安装状态阻止重复确认，并保留失败原因供修正。 */
  const [busy, setBusy] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)
  React.useEffect(() => { setError(null) }, [preview?.token])
  return <Dialog open={preview !== null} onOpenChange={(open) => { if (!open && !busy) onClose() }}>
    <DialogContent className="max-h-[85vh] overflow-y-auto">
      <DialogHeader><DialogTitle>审核插件清单</DialogTitle><DialogDescription>确认后仅安装此预览的清单内容。</DialogDescription></DialogHeader>
      {preview && <div className="space-y-3 text-xs">
        <p className="break-all">来源：{preview.sourcePath}</p>
        <p>{preview.manifest.displayName} · {preview.manifest.version}</p>
        <p>{preview.manifest.description}</p>
        <p>模块：{preview.manifest.modules.map((module) => module.displayName).join('、')}</p>
        {preview.manifest.modules.map((module) => <details key={module.id}><summary>{module.displayName} 的能力声明</summary><pre className="whitespace-pre-wrap break-all">{JSON.stringify(module, null, 2)}</pre></details>)}
        <details><summary>提示内容</summary><pre className="whitespace-pre-wrap break-all">{JSON.stringify(preview.manifest.prompts ?? {}, null, 2)}</pre></details>
        {preview.warnings.map((warning) => <p key={warning} className="text-amber-600 dark:text-amber-400">{warning}</p>)}
        {error && <p role="alert" className="text-destructive">{error}</p>}
        <button type="button" disabled={busy} className="rounded bg-primary px-3 py-2 text-primary-foreground disabled:opacity-50" onClick={() => {
          setBusy(true); setError(null)
          void window.electronAPI.installAgentPlugin(preview.token).then((snapshot) => { onInstalled(snapshot); onClose() }).catch((cause: unknown) => setError(cause instanceof Error ? cause.message : String(cause))).finally(() => setBusy(false))
        }}>{busy ? '正在安装' : '确认安装'}</button>
      </div>}
    </DialogContent>
  </Dialog>
}
