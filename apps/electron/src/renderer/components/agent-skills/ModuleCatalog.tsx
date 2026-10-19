import { settingsTabAtom, settingsOpenAtom } from '@/atoms/settings-tab'
import { isAutomaticAgentModuleId } from '@dutydeck/shared'
import * as React from 'react'
import { useSetAtom } from 'jotai'
import { agentModulesAtom, agentModulesLoadedAtom } from '@/atoms/agent-module-atoms'
import { PluginInstallDialog } from './PluginInstallDialog'
import { getAgentModuleIcon } from '@/components/agent/module-icons'
import type { AgentModuleManifest, AgentPluginHealth, AgentPluginPreview, AgentPluginCatalogSnapshot, SkillMeta } from '@dutydeck/shared'
import { cn } from '@/lib/utils'

interface ModuleCatalogProps {
  /** Skills 页当前真实工作区；未选择时不猜测默认项目。 */
  workspaceSlug?: string
  /** 传入 Skill 快照所属工作区，防止切换项目时用旧数据判断依赖。 */
  loadedWorkspaceSlug?: string
  /** 复用 Skills 页已读取列表，不额外发起 Skill 扫描。 */
  skills?: readonly SkillMeta[]
  /** 宿主或测试预加载的目录诊断快照。 */
  initialCatalog?: AgentPluginCatalogSnapshot
  /** 测试或宿主预加载的目录快照；生产调用保持为空。 */
  initialModules?: AgentModuleManifest[]
  /** 测试或宿主预加载的健康快照；生产调用保持为空。 */
  initialHealth?: AgentPluginHealth[]
}

/** Skills 页面中的模块目录；它展示模块合同，专业模块在当前消息中显式选择，常用能力由 Agent 按需调用。 */
export function ModuleCatalog({ initialModules, initialHealth, initialCatalog, workspaceSlug, loadedWorkspaceSlug, skills = [] }: ModuleCatalogProps = {}): React.ReactElement {
  /** 安装预览与目录诊断只由显式管理操作更新。 */
  const [preview, setPreview] = React.useState<AgentPluginPreview | null>(null)
  const [catalog, setCatalog] = React.useState<AgentPluginCatalogSnapshot | null>(initialCatalog ?? null)
  const [managementError, setManagementError] = React.useState<string | null>(null)
  const [managementBusy, setManagementBusy] = React.useState(false)
  const [uninstallId, setUninstallId] = React.useState<string | null>(null)
  /** 内容包生命周期统一进入设置页，不能调用旧版清单卸载接口。 */
  const setSettingsTab = useSetAtom(settingsTabAtom)
  const setSettingsOpen = useSetAtom(settingsOpenAtom)
  const publishModules = useSetAtom(agentModulesAtom)
  const markLoaded = useSetAtom(agentModulesLoadedAtom)
  /** 同步当前模块栏缓存，后续打开会话无需重启应用。 */
  const publishCatalog = (snapshot: AgentPluginCatalogSnapshot): void => {
    setCatalog(snapshot); setModules(snapshot.modules); publishModules(snapshot.modules); markLoaded(true)
  }
  /** 显示真实管理错误，不吞掉运行中拒绝或清单冲突。 */
  const manage = (operation: () => Promise<void>): void => {
    setManagementBusy(true); setManagementError(null)
    void operation().catch((cause: unknown) => setManagementError(cause instanceof Error ? cause.message : String(cause))).finally(() => setManagementBusy(false))
  }
  React.useEffect(() => {
    if (typeof window.electronAPI.getAgentPluginCatalog !== 'function') return
    let disposed = false
    void window.electronAPI.getAgentPluginCatalog().then((snapshot) => { if (!disposed) setCatalog(snapshot) }).catch((cause: unknown) => { if (!disposed) setManagementError(String(cause)) })
    return () => { disposed = true }
  }, [])
  const [modules, setModules] = React.useState<AgentModuleManifest[]>(() => initialModules ?? [])
  const [health, setHealth] = React.useState<AgentPluginHealth[]>(() => initialHealth ?? [])
  const [error, setError] = React.useState<string | null>(null)

  /** 初次请求与失败重试的读取状态。 */
  const [loading, setLoading] = React.useState(!(initialModules && initialHealth))
  const [readVersion, setReadVersion] = React.useState(0)

  React.useEffect(() => window.electronAPI.onContentPluginsChanged?.(() => setReadVersion(value => value + 1)), [])

  React.useEffect(() => {
    let disposed = false
    if (initialModules && initialHealth && readVersion === 0) return () => { disposed = true }
    setLoading(true)
    setError(null)
    void Promise.all([window.electronAPI.getAgentModules(), window.electronAPI.getAgentPluginHealth()]).then(([items, pluginHealth]) => {
      if (!disposed) { setModules(items); setHealth(pluginHealth) }
    }).catch((cause: unknown) => {
      if (!disposed) setError(cause instanceof Error ? cause.message : String(cause))
    }).finally(() => { if (!disposed) setLoading(false) })
    return () => { disposed = true }
  }, [initialHealth, initialModules, readVersion])

  React.useEffect(() => {
    /** 目录打开期间同步宿主健康变化，避免启动失败只在进入页面时可见。 */
    const subscribe = window.electronAPI.onAgentPluginHealthChanged
    if (typeof subscribe !== 'function') return () => undefined
    const release = subscribe((next) => {
      setHealth((current) => {
        const withoutCurrent = current.filter((entry) => entry.pluginId !== next.pluginId)
        return [...withoutCurrent, next].sort((left, right) => left.pluginId.localeCompare(right.pluginId))
      })
    })
    return release
  }, [])

  if (loading) return <div role="status" data-testid="module-catalog-loading" className="p-3 text-xs text-muted-foreground">正在加载模块目录</div>
  if (error) return <div role="status" data-testid="module-catalog-error" className="rounded-lg border border-destructive/30 bg-destructive/5 p-3 text-xs text-destructive">模块目录加载失败 <button type="button" className="ml-2 underline" onClick={() => setReadVersion((value) => value + 1)}>重试模块目录</button></div>

  return (
    <section className="mb-6 space-y-2" aria-labelledby="agent-module-catalog-title">
      <div className="flex items-center justify-between">
        <div>
          <h2 id="agent-module-catalog-title" className="text-sm font-semibold">Agent 模块</h2>
          <p className="text-xs text-muted-foreground">浏览器、终端等常用能力由 Agent 自动按需调用；专业模块和已安装插件须在当前消息中选择后接入。</p>
        </div>
      </div>
      <div className="flex flex-wrap gap-3 text-xs">
        <button type="button" disabled={managementBusy} onClick={() => manage(async () => { setPreview(await window.electronAPI.previewAgentPlugin()) })}>安装本地插件</button>
        <button type="button" disabled={managementBusy} onClick={() => manage(async () => { publishCatalog(await window.electronAPI.refreshAgentPlugins()) })}>刷新插件目录</button>
        {catalog && <span className="text-muted-foreground">刷新时间：{new Date(catalog.refreshedAt).toLocaleString()}</span>}
      </div>
      {managementError && <p role="alert" className="text-xs text-destructive">{managementError}</p>}
      {catalog?.diagnostics.filter((item) => item.status === 'rejected').map((item) => <p key={item.path + item.pluginId} className="text-xs text-destructive">{item.pluginId}：{item.errorCode} · {item.path}</p>)}
      {catalog?.diagnostics.filter((item) => item.warnings.length > 0).map((item) => <div key={`warnings:${item.path}:${item.pluginId}`} className="text-xs text-amber-600 dark:text-amber-400">
        <span>{item.pluginId} 警告：</span>
        <ul className="list-inside list-disc">{item.warnings.map((warning, index) => <li key={`${index}:${warning}`}>{warning}</li>)}</ul>
      </div>)}
      <PluginInstallDialog preview={preview} onClose={() => setPreview(null)} onInstalled={publishCatalog} />
      {modules.length === 0 && <p className="text-xs text-muted-foreground">暂无可用模块</p>}
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {modules.map((module) => {
          const Icon = getAgentModuleIcon(module.id)
          return (
            <article key={module.id} className={cn('rounded-xl border border-border/60 bg-card p-3', 'transition-colors hover:border-primary/40')}>
              <div className="flex items-start gap-3">
                <div className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary"><Icon className="size-4" /></div>
                <div className="min-w-0">
                  <h3 className="text-sm font-medium">{module.displayName}</h3>
                  <p className="mt-1 text-xs leading-relaxed text-muted-foreground">{module.description}</p>
                </div>
              </div>
              <div className="mt-3 flex flex-wrap gap-1.5 text-[10px] text-muted-foreground">
                <span className="rounded bg-muted px-1.5 py-0.5" title={module.pluginId}>{module.source === 'installed' ? '已安装' : '内置'} · v{module.version}</span>
                <span className="rounded bg-muted px-1.5 py-0.5">{isAutomaticAgentModuleId(module.id) ? '自动按需调用' : '消息选择启用'}</span>
                <span className="rounded bg-muted px-1.5 py-0.5">Skills {module.skillRefs.length}</span>
                <span className="rounded bg-muted px-1.5 py-0.5">工具 {module.toolRefs.length}</span>
                <span className="rounded bg-muted px-1.5 py-0.5">权限 {module.requiredPermissions.length}</span>
                <ModuleHealthBadge health={health.find((entry) => entry.pluginId === (module.pluginId ?? `builtin.${module.id}`))} />
              </div>
              {module.source === 'installed' && module.pluginId && <div className="mt-2 text-xs">
                {module.resourceSource === 'package' ? <button type="button" onClick={() => { setSettingsTab('plugins'); setSettingsOpen(true) }}>前往设置管理插件</button> : uninstallId === module.pluginId ? <><span>仅移除此插件清单，保留 Skill 和其他文件。</span><button disabled={managementBusy} type="button" className="ml-2 text-destructive" onClick={() => manage(async () => { publishCatalog(await window.electronAPI.uninstallAgentPlugin(module.pluginId!)); setUninstallId(null) })}>确认卸载</button><button type="button" className="ml-2" onClick={() => setUninstallId(null)}>取消</button></> : <button type="button" onClick={() => setUninstallId(module.pluginId!)}>卸载插件</button>}
              </div>}
              <details className="mt-3 border-t border-border/50 pt-2 text-[11px]">
                <summary className="cursor-pointer text-muted-foreground hover:text-foreground">查看模块合同</summary>
                <div className="mt-2 space-y-2 text-muted-foreground">
                  <ModuleField label="Skills" values={module.skillRefs} empty="未绑定 Skill" />
                  {module.resourceSource === 'package' ? <p>Skill 来源：已校验插件包，选择模块时按需加载。</p> : <ModuleSkillDependencies skillRefs={module.skillRefs} workspaceSlug={workspaceSlug} loadedWorkspaceSlug={loadedWorkspaceSlug} skills={skills} />}
                  <ModuleField label="提示词" values={module.promptRefs} empty="未绑定模块提示" />
                  <ModuleField label="工具" values={module.toolRefs} empty="未绑定工具" />
                  <ModuleField label="入口" values={module.surfaceIds} empty="无独立入口" />
                  <ModuleField label="产物" values={module.artifactTypes} empty="无产物类型" />
                  <ModuleField label="权限" values={module.requiredPermissions} empty="无需额外权限" />
                </div>
              </details>
            </article>
          )
        })}
      </div>
    </section>
  )
}

/** 显示宿主健康状态，避免目录只反映 manifest 而隐藏启动失败。 */
function ModuleHealthBadge({ health }: { health?: AgentPluginHealth }): React.ReactElement {
  const label = health?.state === 'failed' ? '启动失败' : health?.state === 'running' ? '运行中' : health?.state === 'stopped' ? '已停止' : '已声明'
  const className = health?.state === 'failed' ? 'text-destructive' : health?.state === 'running' ? 'text-emerald-600 dark:text-emerald-400' : 'text-muted-foreground'
  return <span className={cn('rounded bg-muted px-1.5 py-0.5', className)}>{label}</span>
}

/** 展示模块 manifest 的一组可审计引用，避免用户只能看到数量。 */
function ModuleField({ label, values, empty }: { label: string; values: string[]; empty: string }): React.ReactElement {
  return (
    <div>
      <span className="font-medium text-foreground/80">{label}：</span>
      {values.length > 0 ? values.join('、') : empty}
    </div>
  )
}

/** 将工作区 Skill 快照投影为依赖诊断；不读取磁盘，不把旧项目数据当作当前项目。 */
function ModuleSkillDependencies({ skillRefs, workspaceSlug, loadedWorkspaceSlug, skills }: {
  skillRefs: readonly string[]
  workspaceSlug?: string
  loadedWorkspaceSlug?: string
  skills: readonly SkillMeta[]
}): React.ReactElement {
  if (skillRefs.length === 0) return <p>Skill 依赖：无需 Skill</p>
  if (!workspaceSlug) return <p>Skill 依赖：需选择项目后检查</p>
  if (loadedWorkspaceSlug !== workspaceSlug) return <p role="status">Skill 依赖：当前项目数据尚未就绪，请刷新 Skills 后检查</p>
  return <ul aria-label="当前项目 Skill 依赖" className="space-y-1">
    {skillRefs.map((slug) => {
      /** 仅使用当前项目列表，分别说明缺失、禁用与可用状态。 */
      const skill = skills.find((candidate) => candidate.slug === slug)
      const status = !skill ? '缺失（调用将被阻断）' : !skill.enabled ? '已禁用（调用将被阻断）' : '可用'
      return <li key={slug} className={!skill?.enabled ? 'text-amber-600 dark:text-amber-400' : undefined}>{slug}：{status}</li>
    })}
  </ul>
}
