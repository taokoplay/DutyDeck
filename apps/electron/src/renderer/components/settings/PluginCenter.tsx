import * as React from 'react'
import { useAtomValue, useStore } from 'jotai'
import { FileCode2, PackageOpen, Search, Store } from 'lucide-react'
import { isAutomaticAgentModuleId, type InstalledModuleRuntimePluginView } from '@dutydeck/shared'
import { agentModulesAtom, agentModulesLoadedAtom } from '@/atoms/agent-module-atoms'
import { loadAgentModuleCatalog } from '@/components/agent/agent-module-loader'
import { getAgentModuleIcon } from '@/components/agent/module-icons'
import { cn } from '@/lib/utils'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { SettingsCard } from './primitives'
import { BuiltinPluginDetail } from './BuiltinPluginSettings'
import { getBuiltinModuleDocumentation } from './builtin-module-documentation'
import { ContentPluginManagerView, contentPluginsAtom, useContentPluginCatalog } from './PluginSettings'
import { PluginCreationGuide } from './PluginCreationGuide'
import { PluginPackageImporter } from './PluginPackageImporter'
import { ModuleRuntimePluginSettings } from './ModuleRuntimePluginSettings'

/** 插件中心页面：浏览已安装插件、安装来源和创建指南。 */
type PluginCenterPage = 'installed' | 'market' | 'create'
type InstalledSelection = { kind: 'builtin' | 'content' | 'runtime'; id: string } | null
type PluginCardItem = {
  kind: 'builtin' | 'content' | 'runtime'
  id: string
  label: string
  description: string
  version: string
  resourceSummary: string
  status: string
}

interface PluginCardProps {
  item: PluginCardItem
  onOpen: () => void
}

/** 插件卡片只负责摘要和打开详情，管理动作统一放在详情弹层中。 */
function PluginCard({ item, onOpen }: PluginCardProps): React.ReactElement {
  /** 内置模块与工具栏一一对应；内容插件使用安装包图标，不借用内置模块身份。 */
  const Icon = item.kind === 'builtin' ? getAgentModuleIcon(item.id) : PackageOpen
  const handleKeyDown = (event: React.KeyboardEvent<HTMLElement>): void => {
    if (event.key !== 'Enter' && event.key !== ' ') return
    event.preventDefault()
    onOpen()
  }

  return <article
    role="button"
    tabIndex={0}
    aria-label={`查看插件 ${item.label}`}
    onClick={onOpen}
    onKeyDown={handleKeyDown}
    className="group flex min-h-[188px] cursor-pointer flex-col rounded-lg border border-border/70 bg-background/40 p-5 text-left transition-colors hover:border-foreground/30 hover:bg-muted/30 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
  >
    <div className="flex items-start justify-between gap-3">
      <div className="flex min-w-0 items-center gap-2">
        <Icon className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
        <h3 className="truncate text-sm font-semibold">{item.label}</h3>
      </div>
      <span className="shrink-0 rounded-md bg-muted px-2 py-1 text-[11px] text-muted-foreground">{item.status}</span>
    </div>
    <p className="mt-3 line-clamp-3 text-sm leading-6 text-muted-foreground">{item.description}</p>
    <div className="mt-auto flex items-center justify-between gap-3 pt-5 text-xs text-muted-foreground">
      <span>v{item.version}</span>
      <span className="truncate text-right">{item.resourceSummary}</span>
    </div>
    <span className="mt-3 border-t border-border/50 pt-3 text-xs text-muted-foreground transition-colors group-hover:text-foreground">点击查看详情</span>
  </article>
}

/** 顶部插件 Tab：保留设置页的按钮语义，不引入新的导航层级。 */
function PluginTab({ active, icon, label, count, onClick }: { active: boolean; icon: React.ReactNode; label: string; count?: number; onClick: () => void }): React.ReactElement {
  return <button
    type="button"
    role="tab"
    aria-selected={active}
    onClick={onClick}
    className={cn(
      'inline-flex items-center gap-2 border-b-2 px-1 pb-3 text-sm transition-colors',
      active ? 'border-foreground font-medium text-foreground' : 'border-transparent text-muted-foreground hover:border-border hover:text-foreground',
    )}
  >
    {icon}
    <span>{label}</span>
    {count !== undefined && <span className="text-xs tabular-nums text-muted-foreground">{count}</span>}
  </button>
}

/** 插件中心单栏布局：顶部切换 Tab，下面排列插件卡片，点击卡片查看资源详情。 */
export function PluginCenter(): React.ReactElement {
  const store = useStore()
  const modules = useAtomValue(agentModulesAtom)
  const modulesLoaded = useAtomValue(agentModulesLoadedAtom)
  const contentCatalog = useContentPluginCatalog()
  const contentSnapshot = useAtomValue(contentPluginsAtom)
  const [page, setPage] = React.useState<PluginCenterPage>('installed')
  const [selection, setSelection] = React.useState<InstalledSelection>(null)
  const [search, setSearch] = React.useState('')
  const [runtimePlugins, setRuntimePlugins] = React.useState<InstalledModuleRuntimePluginView[]>([])
  const [runtimeError, setRuntimeError] = React.useState<string | null>(null)

  /** 读取可执行插件目录；安装、回滚和启停通过 changed 事件刷新。 */
  const refreshRuntimePlugins = React.useCallback(async (): Promise<void> => {
    try {
      const snapshot = await window.electronAPI.moduleRuntimePlugin.get()
      setRuntimePlugins(snapshot.plugins)
      setRuntimeError(null)
    } catch (cause) {
      setRuntimeError(cause instanceof Error && cause.message.trim() ? cause.message : '读取可执行插件失败')
    }
  }, [])

  /** 与消息模块菜单共享目录缓存，避免插件中心展示过期模块清单。 */
  React.useEffect(() => { void loadAgentModuleCatalog(store, window.electronAPI) }, [store])
  React.useEffect(() => {
    void refreshRuntimePlugins()
    const unsubscribe = window.electronAPI.moduleRuntimePlugin.onChanged(() => { void refreshRuntimePlugins() })
    return unsubscribe
  }, [refreshRuntimePlugins])

  /** 浏览器和终端仍由 Agent 自动调用，不进入可选插件清单。 */
  const builtinModules = React.useMemo(
    () => modules.filter(module => module.source === 'builtin' && !isAutomaticAgentModuleId(module.id)),
    [modules],
  )
  const contentPlugins = contentSnapshot?.plugins ?? []
  const normalizedSearch = search.trim().toLowerCase()
  const installedCards = React.useMemo<PluginCardItem[]>(() => {
    const cards: PluginCardItem[] = [
      ...builtinModules.map(module => ({
        kind: 'builtin' as const,
        id: module.id,
        label: module.displayName,
        description: getBuiltinModuleDocumentation(module.id)?.summary ?? module.description,
        version: module.version,
        resourceSummary: `提示词 ${module.promptRefs.length} · Skills ${module.skillRefs.length}`,
        status: '内置',
      })),
      ...contentPlugins.map(plugin => ({
        kind: 'content' as const,
        id: plugin.manifest.id,
        label: plugin.manifest.displayName,
        description: plugin.manifest.description,
        version: plugin.manifest.version,
        resourceSummary: `提示词 ${plugin.resources.filter(resource => resource.kind === 'prompt').length} · Skills ${plugin.resources.filter(resource => resource.kind === 'skill').length}`,
        status: plugin.enabled ? '可选择' : '已关闭',
      })),
      ...runtimePlugins.map(plugin => ({
        kind: 'runtime' as const,
        id: plugin.manifest.id,
        label: plugin.manifest.displayName,
        description: plugin.manifest.description,
        version: plugin.manifest.version,
        resourceSummary: `工具 ${plugin.manifest.tools.length} · Surface ${plugin.manifest.surfaces.length}`,
        status: plugin.enabled ? '已启用' : '已停用',
      })),
    ]
    if (!normalizedSearch) return cards
    return cards.filter(card => `${card.id} ${card.label} ${card.description}`.toLowerCase().includes(normalizedSearch))
  }, [builtinModules, contentPlugins, runtimePlugins, normalizedSearch])

  const selectedItem = selection ? installedCards.find(card => card.kind === selection.kind && card.id === selection.id) ?? null : null
  const closeDetails = (): void => setSelection(null)

  return <section aria-labelledby="plugin-center-title" className="space-y-6">
    <header>
      <h1 id="plugin-center-title" className="text-xl font-semibold">插件中心</h1>
      <p className="mt-1 text-sm text-muted-foreground">管理内置模块和可安装插件；专业模块需要在发送消息时明确选择，基础能力仍由 Agent 按任务自动调用。</p>
    </header>

    <div className="flex flex-wrap items-end justify-between gap-4 border-b border-border/70" role="tablist" aria-label="插件中心分类">
      <div className="flex flex-wrap items-center gap-x-6 gap-y-2">
        <PluginTab active={page === 'installed'} icon={<PackageOpen className="size-4" />} label="已安装" count={builtinModules.length + contentPlugins.length + runtimePlugins.length} onClick={() => { setPage('installed'); setSearch('') }} />
        <PluginTab active={page === 'market'} icon={<Store className="size-4" />} label="市场" onClick={() => { setPage('market'); closeDetails(); setSearch('') }} />
        <PluginTab active={page === 'create'} icon={<FileCode2 className="size-4" />} label="创建插件" onClick={() => { setPage('create'); closeDetails(); setSearch('') }} />
      </div>
      {page === 'installed' && <label className="mb-2 flex h-9 min-w-[190px] items-center gap-2 rounded-lg border border-border/70 bg-background/60 px-3 sm:max-w-xs">
        <Search className="size-4 shrink-0 text-muted-foreground" />
        <span className="sr-only">搜索已安装插件</span>
        <input aria-label="搜索已安装插件" value={search} onChange={event => setSearch(event.target.value)} placeholder="搜索插件" className="min-w-0 flex-1 bg-transparent text-sm outline-none placeholder:text-muted-foreground/70" />
      </label>}
    </div>

    {page === 'create' ? <PluginCreationGuide /> : page === 'market' ? <div className="space-y-4">
      <PluginPackageImporter catalog={contentCatalog} onInstalled={async () => {
        await refreshRuntimePlugins()
        setPage('installed')
        setSearch('')
      }} />
      <SettingsCard><div className="space-y-2 p-5"><p className="font-medium">市场目录尚未开放</p><p className="text-sm text-muted-foreground">当前不发起网络请求，也不展示虚构的推荐插件。后续配置公共或团队源时，会复用同一套签名校验、预览和安装流程。</p></div></SettingsCard>
    </div> : <>
      {contentCatalog.readError && <p role="alert" className="rounded-lg border border-destructive/30 p-3 text-sm text-destructive">读取本地插件失败：{contentCatalog.readError}</p>}
      {runtimeError && <p role="alert" className="rounded-lg border border-destructive/30 p-3 text-sm text-destructive">读取可执行插件失败：{runtimeError}</p>}
      {!modulesLoaded && builtinModules.length === 0 && <p role="status" className="text-sm text-muted-foreground">正在读取内置模块…</p>}
      {modulesLoaded && installedCards.length === 0 && <SettingsCard><p className="p-6 text-sm text-muted-foreground">{normalizedSearch ? '没有匹配的插件。' : '暂无已安装插件。'}</p></SettingsCard>}
      {installedCards.length > 0 && <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
        {installedCards.map(card => <PluginCard key={`${card.kind}:${card.id}`} item={card} onOpen={() => setSelection({ kind: card.kind, id: card.id })} />)}
      </div>}
    </>}

    <Dialog open={selectedItem !== null} onOpenChange={open => { if (!open) closeDetails() }}>
      <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle>{selectedItem?.label ?? '插件详情'}</DialogTitle>
          {/* 详情组件提供视觉说明；这里保留描述供辅助技术使用，避免头部重复占位。 */}
          <DialogDescription className="sr-only">插件详情，包含简介、提示词、Skills 和模块资源。</DialogDescription>
        </DialogHeader>
        {selection?.kind === 'builtin' && <BuiltinPluginDetail moduleId={selection.id} />}
        {selection?.kind === 'content' && <ContentPluginManagerView pluginFilter={selection.id} displayMode="detail" showHeading={false} catalog={contentCatalog} />}
        {selection?.kind === 'runtime' && (
          <ModuleRuntimePluginSettings pluginFilter={selection.id} showHeading={false} allowInstall={false} />
        )}
      </DialogContent>
    </Dialog>
  </section>
}
