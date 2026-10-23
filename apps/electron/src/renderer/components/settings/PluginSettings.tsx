import * as React from 'react'
import { atom, useAtomValue, useSetAtom } from 'jotai'
import type { ContentPluginPreview, ContentPluginSnapshot, ContentResourceSummary } from '@dutydeck/shared'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from '@/components/ui/dialog'
import { SettingsSection, SettingsCard } from './primitives'
import { confirmedPluginKey, contentPluginErrorMessage, mergeContentPluginSnapshot } from './PluginSettings.logic'
import { BuiltinPluginSettings } from './BuiltinPluginSettings'
import { ModuleRuntimePluginSettings } from './ModuleRuntimePluginSettings'

/** 插件管理只缓存摘要；页面间共享修订号，不缓存可执行提示正文。 */
export const contentPluginsAtom = atom<ContentPluginSnapshot | null>(null)

export interface ContentPluginCatalog {
  /** 当前宿主返回的已安装内容插件摘要。 */
  snapshot: ContentPluginSnapshot | null
  /** 首次读取或刷新是否进行中。 */
  loading: boolean
  /** 最近一次读取失败，不覆盖已有快照。 */
  readError: string | null
  /** 重新读取宿主目录。 */
  refresh: () => Promise<void>
  /** 接收安装、卸载或启用操作返回的新快照。 */
  accept: (incoming: ContentPluginSnapshot) => void
}

/** 插件中心和内容插件详情共用同一份目录读取状态，避免页面之间重复维护快照。 */
export function useContentPluginCatalog(): ContentPluginCatalog {
  const snapshot = useAtomValue(contentPluginsAtom)
  const setSnapshot = useSetAtom(contentPluginsAtom)
  const [loading, setLoading] = React.useState(true)
  const [readError, setReadError] = React.useState<string | null>(null)
  const refreshGeneration = React.useRef(0)
  const accept = React.useCallback((incoming: ContentPluginSnapshot): void => {
    setSnapshot(current => mergeContentPluginSnapshot(current, incoming))
  }, [setSnapshot])
  const refresh = React.useCallback(async (): Promise<void> => {
    const generation = ++refreshGeneration.current
    setLoading(true); setReadError(null)
    try {
      const incoming = await window.electronAPI.getContentPlugins()
      if (generation === refreshGeneration.current) accept(incoming)
    } catch (cause) {
      if (generation === refreshGeneration.current) setReadError(contentPluginErrorMessage(cause, '读取插件失败，请刷新重试'))
    } finally {
      if (generation === refreshGeneration.current) setLoading(false)
    }
  }, [accept])
  React.useEffect(() => {
    void refresh()
    const unsubscribe = window.electronAPI.onContentPluginsChanged(() => { void refresh() })
    return () => { refreshGeneration.current += 1; unsubscribe() }
  }, [refresh])
  return { snapshot, loading, readError, refresh, accept }
}

/** 资源按宿主提供的完整身份展示归属，不查询工作区 Skills。 */
function PluginResources({ resources }: { resources: ContentResourceSummary[] }): React.ReactElement {
  const skills = resources.filter(resource => resource.kind === 'skill')
  const prompts = resources.filter(resource => resource.kind === 'prompt')
  const constraints = resources.filter(resource => resource.kind === 'style')
  const renderResources = (items: ContentResourceSummary[]): React.ReactElement => items.length > 0
    ? <ul className="space-y-2">{items.map(resource => <li key={resource.id} className="break-all rounded bg-muted/50 p-2">
      <div>{resource.id} · v{resource.version}</div>
      <div className="mt-1 text-muted-foreground">所属模块：{resource.ownerModuleIds.join('、') || '无'} · {resource.byteLength} 字节</div>
    </li>)}</ul>
    : <p className="text-sm text-muted-foreground">暂无声明资源。</p>
  return <div className="grid gap-3 text-xs sm:grid-cols-2">
    <section aria-label="插件 Skills" className="rounded-lg border border-border/60 bg-muted/20 p-3"><h4 className="mb-2 text-sm font-medium">Skills · {skills.length}</h4>{renderResources(skills)}{skills.length > 0 && <p className="mt-2 border-t border-border/50 pt-2 leading-5 text-muted-foreground">Skills 正文在模块被当前消息明确选择后，由宿主按包版本读取。</p>}</section>
    <section aria-label="插件提示词" className="rounded-lg border border-border/60 bg-muted/20 p-3"><h4 className="mb-2 text-sm font-medium">提示词 · {prompts.length}</h4>{renderResources(prompts)}{prompts.length > 0 && <p className="mt-2 border-t border-border/50 pt-2 leading-5 text-muted-foreground">提示词正文在模块被当前消息明确选择后，由宿主按包版本读取；目录摘要只显示引用。</p>}</section>
    {constraints.length > 0 && <section aria-label="插件设计约束" className="rounded-lg border border-border/60 bg-muted/20 p-3 sm:col-span-2"><h4 className="mb-2 text-sm font-medium">设计约束 · {constraints.length}</h4>{renderResources(constraints)}</section>}
  </div>
}

export interface ContentPluginManagerProps {
  /** 市场页只显示安装入口，不把已安装列表伪装成在线市场内容。 */
  mode?: 'installed' | 'market'
  /** 侧栏点击具体插件时，只展示该插件的详情。 */
  pluginFilter?: string | null
  /** 详情页只呈现一个插件，列表页保留多插件管理视图。 */
  displayMode?: 'list' | 'detail'
  /** 嵌入插件中心时可隐藏重复的页面标题。 */
  showHeading?: boolean
}

/** 本地包管理：先预览与确认签名来源，再提交不可变包的安装令牌。 */
export function ContentPluginManager(props: ContentPluginManagerProps = {}): React.ReactElement {
  const catalog = useContentPluginCatalog()
  return <ContentPluginManagerView {...props} catalog={catalog} />
}

/** 以已读取的目录渲染内容插件，插件中心与独立设置入口共用此视图。 */
export function ContentPluginManagerView({ mode = 'installed', pluginFilter = null, displayMode = 'list', showHeading = true, catalog }: ContentPluginManagerProps & { catalog: ContentPluginCatalog }): React.ReactElement {
  /** 摘要与临时表单状态不混入当前消息模块选择。 */
  const { snapshot, loading, readError, refresh, accept } = catalog
  const [preview, setPreview] = React.useState<ContentPluginPreview | null>(null)
  const [confirmed, setConfirmed] = React.useState(false)
  const [busy, setBusy] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)
  const [removeId, setRemoveId] = React.useState<string | null>(null)
  /** 目录不可用或正在刷新时禁止提交管理动作，保留刷新重试入口。 */
  const managementDisabled = busy || loading || readError !== null || snapshot === null
  /** 避免同一帧重复点击造成两次变更。 */
  const operationPending = React.useRef(false)
  /** 管理操作统一处理错误，成功后使用宿主返回的最新版本。 */
  const run = async (operation: () => Promise<void>): Promise<void> => {
    if (operationPending.current) return
    operationPending.current = true; setBusy(true); setError(null)
    try { await operation() }
    catch (cause) { setError(contentPluginErrorMessage(cause, '插件操作失败')); await refresh() }
    finally { operationPending.current = false; setBusy(false) }
  }
  /** 每次新预览都重置来源确认，不能复用另一个包的信任勾选。 */
  const choosePackage = (): void => { void run(async () => {
    setPreview(null); setConfirmed(false)
    setPreview(await window.electronAPI.previewContentPlugin())
  }) }
  /** 只有用户明确确认当前预览的签名身份后才提交。 */
  const install = (): void => {
    const key = confirmedPluginKey(preview, confirmed)
    if (!preview || !key) return
    void run(async () => { accept(await window.electronAPI.installContentPlugin(preview.token, key)); setPreview(null); setConfirmed(false) })
  }
  /** 侧栏过滤只影响展示，不影响插件快照或安装事务。 */
  const normalizedFilter = pluginFilter?.trim().toLowerCase() ?? ''
  const visiblePlugins = snapshot?.plugins.filter(plugin => {
    if (!normalizedFilter) return true
    return plugin.manifest.id.toLowerCase().includes(normalizedFilter) || plugin.manifest.displayName.toLowerCase().includes(normalizedFilter) || plugin.manifest.description.toLowerCase().includes(normalizedFilter)
  }) ?? []
  const isMarket = mode === 'market'
  const isDetail = displayMode === 'detail'

  return <>
    <section aria-labelledby="content-plugins-title" className="space-y-5">
      {showHeading && <div>
        <h2 id="content-plugins-title" className="text-xl font-semibold">{isMarket ? '插件市场' : isDetail ? (visiblePlugins[0]?.manifest.displayName ?? '我的插件') : '我的插件'}</h2>
        <p className="mt-1 text-sm text-muted-foreground">{isMarket ? '公共与团队源尚未接入；可以先从开发者提供的签名包安装。' : '安装插件后，发送消息时明确选择模块，才会将其 Skills 和提示词接入本轮。'}</p>
      </div>}
      <div className="flex flex-wrap gap-2">
        <Button disabled={managementDisabled} onClick={choosePackage}>从本地包安装 / 更新</Button>
        {!isMarket && <Button variant="outline" disabled={busy || loading} onClick={() => { void run(refresh) }}>刷新</Button>}
      </div>
      {readError && <p role="alert" className="mb-4 break-words text-sm text-destructive">{readError}</p>}
      {error && <p role="alert" className="mb-4 break-words text-sm text-destructive">{error}</p>}
      {isMarket ? <SettingsCard><div className="space-y-2 p-5"><p className="font-medium">市场目录尚未开放</p><p className="text-sm text-muted-foreground">当前不发起网络请求，也不展示虚构的推荐插件。配置公共或团队源后，这里会复用同一套签名校验、预览和安装流程。</p></div></SettingsCard> :
        !snapshot ? (loading ? <p role="status">正在读取插件…</p> : null) : visiblePlugins.length === 0 ? <SettingsCard><p className="p-5 text-sm text-muted-foreground">{normalizedFilter ? '没有匹配的已安装内容插件。' : '尚未安装内容插件。选择开发者提供的已签名 .ddplugin 包开始使用。旧版目录插件仍在能力中心管理。'}</p></SettingsCard> :
        <div className={isDetail ? 'space-y-4' : 'grid gap-4 xl:grid-cols-2'}>{visiblePlugins.map(plugin => <SettingsCard key={plugin.manifest.id}>
          <article className="space-y-4 p-5">
            <div className="flex flex-wrap items-start justify-between gap-3"><div><p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">本地内容插件</p><h3 className="mt-1 text-lg font-semibold">{plugin.manifest.displayName} <span className="text-xs font-normal text-muted-foreground">v{plugin.manifest.version}</span></h3><p className="break-all text-xs text-muted-foreground">{plugin.manifest.id}</p></div><span className="rounded-md bg-muted px-2 py-1 text-xs">{plugin.enabled ? '可选择' : '已关闭'}</span></div>
            <div className="rounded-lg border border-border/60 bg-muted/20 p-4"><h4 className="text-sm font-medium">简介</h4><p className="mt-2 text-sm leading-6 text-muted-foreground">{plugin.manifest.description}</p></div>
            <div className="space-y-1 break-all text-xs text-muted-foreground"><p>来源：本地安装包 · 发布者：{plugin.manifest.publisherId}</p><p>签名指纹：{plugin.keyId || '未签名（开发隔离）'}</p><p>包 SHA-256：{plugin.packageHash}</p><p>模块：{plugin.manifest.modules.map(module => module.displayName).join('、')}</p></div>
            <PluginResources resources={plugin.resources} />
            <div className="flex flex-wrap gap-2"><Button variant="outline" size="sm" disabled={managementDisabled} onClick={() => { void run(async () => { accept(await window.electronAPI.setContentPluginEnabled(plugin.manifest.id, !plugin.enabled, snapshot.revision)) }) }}>{plugin.enabled ? '关闭插件' : '启用插件'}</Button><Button variant="ghost" size="sm" disabled={managementDisabled} onClick={() => setRemoveId(plugin.manifest.id)}>卸载</Button></div>
          </article>
        </SettingsCard>)}</div>}
      {!isMarket && <p className="text-xs text-muted-foreground">关闭插件后，其模块不可被选中。当前支持纯内容插件；插件市场与团队私有源尚未开放。</p>}
    </section>
    <Dialog open={preview !== null} onOpenChange={open => { if (!open && !busy) { setPreview(null); setConfirmed(false) } }}>
      <DialogContent className="max-h-[85vh] overflow-y-auto"><DialogHeader><DialogTitle>{preview?.operation === 'update' ? '确认更新插件' : '确认安装插件'}</DialogTitle><DialogDescription>签名校验只证明包来自对应密钥。请核对开发者提供的指纹，再确认来源。</DialogDescription></DialogHeader>
        {error && <p role="alert" className="break-words text-sm text-destructive">{error}</p>}
        {preview && <div className="space-y-3 text-sm"><p>{preview.manifest.displayName} · {preview.manifest.id}</p><p>版本：{preview.previousVersion ? `${preview.previousVersion} → ` : ''}{preview.manifest.version}</p><p>{preview.manifest.description}</p><p>来源：本地文件 · 发布者：{preview.manifest.publisherId}</p><p className="break-all text-xs">SHA-256：{preview.packageHash}</p><p className="break-all text-xs">签名指纹：{preview.signer?.keyId || '无'}</p><p>{preview.signatureVerified ? '签名校验通过' : '签名未验证，无法安装'}</p><PluginResources resources={preview.resources} /><label className="flex items-start gap-2"><input type="checkbox" checked={confirmed} disabled={busy || !preview.signatureVerified || !preview.signer} onChange={event => setConfirmed(event.target.checked)} /><span>我已核对来源与上述签名指纹，信任此发布者的插件内容。</span></label></div>}
        <DialogFooter><Button variant="outline" disabled={busy} onClick={() => { setPreview(null); setConfirmed(false) }}>取消</Button><Button disabled={busy || !confirmedPluginKey(preview, confirmed)} onClick={install}>{busy ? '处理中…' : preview?.operation === 'update' ? '确认更新' : '信任并安装'}</Button></DialogFooter>
      </DialogContent>
    </Dialog>
    <Dialog open={removeId !== null} onOpenChange={open => { if (!open && !busy) setRemoveId(null) }}><DialogContent><DialogHeader><DialogTitle>卸载插件？</DialogTitle><DialogDescription>卸载后，此插件的模块将不可用。用户数据和会话记录保留。</DialogDescription></DialogHeader><p className="break-all text-sm">{removeId}</p>{error && <p role="alert" className="text-sm text-destructive">{error}</p>}<DialogFooter><Button variant="outline" disabled={busy} onClick={() => setRemoveId(null)}>取消</Button><Button variant="destructive" disabled={busy} onClick={() => { if (removeId && snapshot) void run(async () => { accept(await window.electronAPI.uninstallContentPlugin(removeId, snapshot.revision)); setRemoveId(null) }) }}>确认卸载</Button></DialogFooter></DialogContent></Dialog>
  </>
}

/** 兼容原设置入口：完整显示内置模块和已安装内容插件。 */
export function PluginSettings(): React.ReactElement {
  return <SettingsSection title="插件管理" description="管理内置模块和已安装插件；发送消息时明确选择模块，决定本轮是否接入模型。">
    <BuiltinPluginSettings />
    <ModuleRuntimePluginSettings />
    <ContentPluginManager />
  </SettingsSection>
}
