import * as React from 'react'
import { atom, useAtom } from 'jotai'
import type { AgentWorkspace, InstalledModuleRuntimePluginView, AuthorizeModuleRuntimePluginInput } from '@dutydeck/shared'
import type { PluginCapabilityId } from '@dutydeck/plugin-sdk'
import { Button } from '@/components/ui/button'

interface GrantForm {
  editing: boolean
  workspaces: AgentWorkspace[]
  selectedWorkspaces: string[]
  capabilities: PluginCapabilityId[]
  loading: boolean
  error: string | null
}

/** 独立于安装确认的授权编辑器；只提交用户勾选的能力与工作区。 */
export function PluginRuntimeGrantPanel({ plugin, revision, busy, onAuthorize, onRevoke }: {
  plugin: InstalledModuleRuntimePluginView
  revision: number
  busy: boolean
  onAuthorize(input: AuthorizeModuleRuntimePluginInput): Promise<boolean>
  onRevoke(): Promise<boolean>
}): React.ReactElement {
  const state = React.useMemo(() => atom<GrantForm>({ editing: false, workspaces: [], selectedWorkspaces: [], capabilities: [], loading: false, error: null }), [plugin.packageHash])
  const [form, setForm] = useAtom(state)
  const grant = plugin.grant
  const current = grant && !grant.revoked && grant.packageHash === plugin.packageHash
  const open = async (): Promise<void> => {
    setForm(previous => ({ ...previous, editing: true, loading: true, error: null }))
    try {
      const workspaces = await window.electronAPI.listAgentWorkspaces()
      setForm(previous => ({ ...previous, loading: false, workspaces,
        selectedWorkspaces: current ? grant.workspaceIds : [],
        capabilities: current ? grant.capabilities : [],
      }))
    } catch {
      setForm(previous => ({ ...previous, loading: false, error: '读取工作区失败，请重试。' }))
    }
  }
  return <section aria-label="插件执行授权" className="space-y-3 rounded-lg border border-border/60 p-4 text-sm">
    <h4 className="font-medium">执行授权 · {current ? '已确认当前包' : '待授权'}</h4>
    <p className="text-xs leading-5 text-muted-foreground">安装不等于授权。包升级或回滚后需重新核对。插件运行于 Node 进程，进程隔离不是系统资源沙箱；只授权信任且已审查的代码。未实现的能力不会因勾选而可用。</p>
    {grant && <p className="break-words text-xs text-muted-foreground">上次确认：{grant.capabilities.join('、') || '无宿主能力'} · {grant.workspaceIds.length} 个工作区 · revision {grant.revision}{grant.revoked ? '（已撤销）' : ''}</p>}
    {!form.editing ? <div className="flex flex-wrap gap-2">
      <Button size="sm" variant="outline" disabled={busy || plugin.enabled} onClick={() => { void open() }}>核对授权</Button>
      {grant && !grant.revoked && <Button size="sm" variant="outline" disabled={busy} onClick={() => { void onRevoke() }}>撤销授权并停止调用</Button>}
      {plugin.enabled && <p className="text-xs text-muted-foreground">编辑授权前请先停用插件。</p>}
    </div> : <div className="space-y-3">
      {form.loading && <p role="status">正在读取可选工作区…</p>}
      {form.error && <p role="alert" className="text-destructive">{form.error}</p>}
      <fieldset disabled={busy || form.loading} className="space-y-2">
        <legend className="mb-2 font-medium">宿主能力</legend>
        {plugin.manifest.capabilities.map(capability => <label key={capability} className="flex items-center gap-2">
          <input type="checkbox" checked={form.capabilities.includes(capability)} onChange={event => setForm(previous => ({ ...previous, capabilities: event.target.checked ? [...previous.capabilities, capability] : previous.capabilities.filter(item => item !== capability) }))} />
          <span className="break-all text-xs">{capability}</span>
        </label>)}
      </fieldset>
      <fieldset disabled={busy || form.loading} className="space-y-2">
        <legend className="mb-2 font-medium">允许访问的工作区</legend>
        <p className="text-xs text-muted-foreground">未选工作区时仅允许实例自身状态；不等于全部工作区。</p>
        {form.workspaces.map(workspace => <label key={workspace.id} className="flex items-center gap-2">
          <input type="checkbox" checked={form.selectedWorkspaces.includes(workspace.id)} onChange={event => setForm(previous => ({ ...previous, selectedWorkspaces: event.target.checked ? [...previous.selectedWorkspaces, workspace.id] : previous.selectedWorkspaces.filter(id => id !== workspace.id) }))} />
          {workspace.name}
        </label>)}
      </fieldset>
      <div className="flex gap-2">
        <Button size="sm" disabled={busy || form.loading || Boolean(form.error)} onClick={() => {
          void onAuthorize({ pluginId: plugin.manifest.id, capabilities: form.capabilities, workspaceIds: form.selectedWorkspaces, expectedRevision: revision, expectedGrantRevision: grant?.revision ?? 0 })
            .then(saved => { if (saved) setForm(previous => ({ ...previous, editing: false })) })
        }}>确认所选授权（不自动启用）</Button>
        <Button size="sm" variant="ghost" disabled={busy} onClick={() => setForm(previous => ({ ...previous, editing: false }))}>取消</Button>
      </div>
    </div>}
  </section>
}
