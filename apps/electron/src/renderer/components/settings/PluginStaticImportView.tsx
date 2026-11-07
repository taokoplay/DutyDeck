import * as React from 'react'
import { atom, useAtom, useAtomValue, useSetAtom } from 'jotai'
import { agentWorkspacesAtom, currentAgentWorkspaceIdAtom } from '@/atoms/agent-atoms'
import { pluginStaticImportAtom, runStaticImportActionAtom } from '@/atoms/plugin-static-import-atoms'
import { Button } from '@/components/ui/button'
import { SettingsCard } from './primitives'

const STATUS: Record<string, string> = { pending: '待处理', applying: '进行中或上次中断', created: '已创建', reused: '复用既有资源', removed: '已撤销或释放引用', blocked: '受阻，保留资源' }
const ERRORS: Record<string, string> = {
  PLUGIN_IMPORT_MCP_NOT_READY: '连接尚不可用；请检查MCP安全设置、登录或稍后重试。',
  PLUGIN_IMPORT_RESOURCE_CHANGED: '资源已变化，未覆盖或删除。', PLUGIN_IMPORT_RESOURCE_SHARED: '资源仍被其他导入引用，未删除。',
  PLUGIN_IMPORT_EFFECT_UNCERTAIN: '不能确认资源所有权，请在原管理界面核对。',
  PLUGIN_IMPORT_MCP_CONFLICT: '同名MCP连接已有配置，不覆盖。', PLUGIN_IMPORT_CONTENT_CONFLICT: '同名内容或其状态不一致，不覆盖。',
}
/** 独立固定配方入口，目录可见性不授予安装权；每次导入/重试/撤销都明确确认。 */
export function PluginStaticImportView(): React.ReactElement {
  const [state, setState] = useAtom(pluginStaticImportAtom)
  const run = useSetAtom(runStaticImportActionAtom)
  const workspaceId = useAtomValue(currentAgentWorkspaceIdAtom)
  const workspaces = useAtomValue(agentWorkspacesAtom)
  const workspace = workspaces.find(item => item.id === workspaceId)
  const confirmationAtom = React.useMemo(() => atom({ confirmed: false, trusted: false }), [])
  const [{ confirmed, trusted }, setConfirmation] = useAtom(confirmationAtom)
  const setConfirmed = React.useCallback((value: boolean) => setConfirmation(state => ({ ...state, confirmed: value })), [setConfirmation])
  const setTrusted = React.useCallback((value: boolean) => setConfirmation(state => ({ ...state, trusted: value })), [setConfirmation])
  const api = window.electronAPI.pluginStaticImport
  React.useEffect(() => {
    setState(current => current.workspaceId === workspaceId ? current : { ...current, workspaceId, preview: null, error: null })
    setConfirmed(false); setTrusted(false)
  }, [workspaceId, setState, setConfirmed, setTrusted])
  React.useEffect(() => { if (api) void run({ api, kind: 'list' }) }, [api, run])
  React.useEffect(() => { setConfirmed(false); setTrusted(false) }, [state.preview?.token, setConfirmed, setTrusted])
  const selected = state.plans?.find(plan => plan.hash === state.preview?.planHash)
  const act = (kind: 'apply' | 'undo'): void => {
    if (!api) return
    void run({ api, kind, confirmed, trustPublisher: trusted })
    setConfirmed(false); setTrusted(false)
  }
  return <SettingsCard><section aria-label="固定配方导入" className="space-y-4 p-5 text-sm">
    <h2 className="font-medium">固定配方 · 内容与 MCP 导入</h2>
    <p className="text-muted-foreground">仅显示随宿主审查登记的固定版本。静态转换不运行 DSH 包；内容只在消息中明确选择后注入。MCP 启用需真实握手与工具发现，凭据仍在 MCP 安全界面配置。</p>
    {state.plans !== null && state.plans.length === 0 && <p className="text-muted-foreground">当前没有已登记的生产配方。只读目录分析不会自动变成可导入项；仍可使用已有的签名 .ddplugin 导入。</p>}
    {state.plans === null && !state.busy && <p className="text-muted-foreground">配方列表尚未读取成功；请重试，若接口不可用请重启应用。</p>}
    <Button variant="outline" size="sm" disabled={state.busy || !api} onClick={() => api && void run({ api, kind: 'list' })}>重新读取配方</Button>
    {state.error && <p role="alert" className="text-destructive">{state.error}</p>}
    {state.busy && <p role="status">正在处理，请稍候。切换项目不会撤销已提交的步骤。</p>}
    {(state.plans?.length ?? 0) > 0 && <>
      <p>目标工作区：{workspace?.name ?? '请先选择项目'}</p>
      {state.plans?.map(plan => <div key={plan.hash} className="space-y-2 rounded border border-border p-3 break-all">
        <p className="font-medium">{plan.source.name}@{plan.source.version}</p>
        <p className="text-xs text-muted-foreground">配方 {plan.recipeId}@{plan.recipeVersion} · {plan.source.license} 声明 · {plan.content ? '内容资源' : ''}{plan.mcp ? ' + HTTP MCP' : ''}</p>
        <Button variant="outline" size="sm" disabled={state.busy || !workspaceId} onClick={() => api && void run({ api, kind: 'preview', planHash: plan.hash })}>预览 / 重新核对</Button>
      </div>)}
    </>}
    {state.preview && selected && <div className="space-y-3 rounded border border-border p-4 break-all">
      <p className="font-medium">导入预览：{selected.source.name}</p>
      <p className="text-xs">上游来源：{selected.source.url}<br />上游 SHA-256：{selected.source.sha256}<br />计划 SHA-256：{selected.hash}</p>
      {selected.content && <><p className="text-xs">转换包：{selected.content.pluginId}<br />包 SHA-256：{selected.content.packageHash}<br />转换方密钥：{selected.content.keyId}（不是上游作者签名）</p>
        <ul className="list-disc pl-5 text-xs">{selected.content.resources.map(resource => <li key={resource.id}>{resource.kind} · {resource.path} · {resource.byteLength} 字节</li>)}</ul></>}
      {selected.mcp && <p>新增 HTTP MCP：{selected.mcp.name} · {selected.mcp.url}。{selected.mcp.requiresOAuth ? '可能需要在 MCP 卡片登录；本入口不读取密钥。' : '不导入任何授权 Header 或环境密钥。'}</p>}
      {state.preview.conflicts.map(error => <p key={error} role="alert" className="text-destructive">{ERRORS[error] ?? error}</p>)}
      {state.preview.receipt && <ul className="space-y-2" aria-label="导入阶段回执">{state.preview.receipt.steps.map(step => <li key={step.id}>{step.id === 'content' ? '内容资源' : 'MCP连接'}：{STATUS[step.status]}{step.error && <p className="text-destructive">{ERRORS[step.error] ?? step.error}</p>}</li>)}</ul>}
      <label className="flex items-start gap-2"><input type="checkbox" checked={confirmed} onChange={event => setConfirmed(event.target.checked)} disabled={state.busy} />我已核对目标工作区、将新增的资源与连接，确认本次操作。</label>
      {selected.content && <label className="flex items-start gap-2"><input type="checkbox" checked={trusted} onChange={event => setTrusted(event.target.checked)} disabled={state.busy} />首次导入时信任上方转换方公钥；该签名不代表安全认证。</label>}
      <div className="flex flex-wrap gap-2"><Button disabled={state.busy || !confirmed || state.preview.conflicts.length > 0} onClick={() => act('apply')}>确认导入 / 重试</Button>
        <Button variant="outline" disabled={state.busy || !confirmed || !state.preview.receipt} onClick={() => act('undo')}>撤销本次未修改的资源</Button></div>
      <p className="text-xs text-muted-foreground">撤销只影响本次创建且未修改、未共享的资源；复用资源只释放引用。已有连接不自动删除，历史内容包保留。</p>
    </div>}
  </section></SettingsCard>
}
