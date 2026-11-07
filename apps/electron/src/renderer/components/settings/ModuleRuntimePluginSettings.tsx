import * as React from 'react'
import type {
  ArchivedModuleRuntimePluginVersionView,
  InstalledModuleRuntimePluginView,
  ModuleRuntimePluginPreviewView,
  ModuleRuntimePluginChanges,
  ModuleRuntimePluginSnapshotView,
} from '@dutydeck/shared'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { SettingsCard } from './primitives'
import { PluginRuntimeGrantPanel } from './PluginRuntimeGrantPanel'
import { PluginRuntimeSettingsPanel } from './PluginRuntimeSettingsPanel'
import { usePluginManagement } from './usePluginManagement'
import { PluginRuntimeManagementSummary, PluginValidationSummary, runtimeAuthorizationLabel } from './PluginValidationSummary'
import { isPluginManagementBusyError, pluginImportErrorMessage } from './PluginPackageImporter.logic'

/** 可执行插件视图的过滤和嵌入选项。 */
export interface ModuleRuntimePluginSettingsProps {
  pluginFilter?: string | null
  showHeading?: boolean
  allowInstall?: boolean
}

/** 管理 V3 可执行插件；设置页只展示声明摘要，不读取 runtime 或 Surface 正文。 */
export function ModuleRuntimePluginSettings({
  pluginFilter = null,
  showHeading = true,
  allowInstall = true,
}: ModuleRuntimePluginSettingsProps = {}): React.ReactElement {
  const [snapshot, setSnapshot] = React.useState<ModuleRuntimePluginSnapshotView | null>(null)
  const [loading, setLoading] = React.useState(true)
  const [loadError, setLoadError] = React.useState<string | null>(null)
  const [preview, setPreview] = React.useState<ModuleRuntimePluginPreviewView | null>(null)
  const [trusted, setTrusted] = React.useState(false)
  const [removeId, setRemoveId] = React.useState<string | null>(null)
  const [versionsPluginId, setVersionsPluginId] = React.useState<string | null>(null)
  const [versions, setVersions] = React.useState<ArchivedModuleRuntimePluginVersionView[]>([])
  const [versionsRevision, setVersionsRevision] = React.useState<number | null>(null)
  const versionsTrigger = React.useRef<HTMLElement | null>(null)
  const generation = React.useRef(0)

  /** 每次读取只允许最新代次更新页面，旧错误不覆盖新快照。 */
  const refresh = React.useCallback(async (): Promise<void> => {
    const current = ++generation.current
    setLoading(true)
    try {
      const next = await window.electronAPI.moduleRuntimePlugin.get()
      if (current === generation.current) {
        setSnapshot(next)
        setLoadError(null)
      }
    } catch (cause) {
      if (current === generation.current) setLoadError(errorMessage(cause, '读取可执行插件失败'))
    } finally {
      if (current === generation.current) setLoading(false)
    }
  }, [])

  React.useEffect(() => {
    void refresh()
    const unsubscribe = window.electronAPI.moduleRuntimePlugin.onChanged(() => { void refresh() })
    return () => {
      generation.current += 1
      unsubscribe()
    }
  }, [refresh])

  const { busy, error: operationError, manage } = usePluginManagement(refresh, cause => errorMessage(cause, '插件操作失败'))
  const error = operationError ?? loadError

  const choose = (): void => {
    void manage(async () => {
      const next = await window.electronAPI.moduleRuntimePlugin.preview()
      if (next) {
        setPreview(next)
        setTrusted(false)
      }
    })
  }

  const install = (): void => {
    if (!preview) return
    void manage(async () => {
      const next = await window.electronAPI.moduleRuntimePlugin.install(
        preview.token,
        preview.signer && trusted ? preview.signer.keyId : undefined,
      )
      setSnapshot(next)
      setPreview(null)
      setTrusted(false)
    })
  }

  /** 打开指定插件的历史包列表；只在用户操作时读取归档。 */
  const openVersions = (pluginId: string): void => {
    versionsTrigger.current = document.activeElement instanceof HTMLElement ? document.activeElement : null
    void manage(async () => {
      setVersions([])
      setVersionsRevision(snapshot?.revision ?? null)
      setVersionsPluginId(pluginId)
      setVersions(await window.electronAPI.moduleRuntimePlugin.listVersions(pluginId))
    })
  }

  const grantPanel = (plugin: InstalledModuleRuntimePluginView): React.ReactElement => (
    <div className="space-y-3"><PluginRuntimeGrantPanel plugin={plugin} revision={snapshot?.revision ?? 0} busy={busy || loading}
      onAuthorize={input => manage(async () => { setSnapshot(await window.electronAPI.moduleRuntimePlugin.authorize(input)) })}
      onRevoke={() => manage(async () => { setSnapshot(await window.electronAPI.moduleRuntimePlugin.revoke(plugin.manifest.id, plugin.grant?.revision ?? 0)) })}
    /><PluginRuntimeSettingsPanel plugin={plugin} busy={busy || loading} onSave={(values, expectedSettingsRevision) => manage(async () => {
      setSnapshot(await window.electronAPI.moduleRuntimePlugin.configureSettings({ pluginId: plugin.manifest.id, values, expectedRevision: snapshot?.revision ?? 0, expectedSettingsRevision }))
    })} /></div>
  )

  const canInstall = preview !== null && !preview.changes?.blockers.length && (!preview.signatureVerified || (trusted && Boolean(preview.signer)))
  const visiblePlugins = snapshot?.plugins.filter(plugin => !pluginFilter || plugin.manifest.id === pluginFilter) ?? []
  const detailPlugin = pluginFilter ? visiblePlugins[0] : undefined
  const isDetail = pluginFilter !== null
  return (
    <>
      <section aria-labelledby="runtime-plugins-title" className="space-y-4">
        {isDetail ? (
          <>
            <h2 id="runtime-plugins-title" className="sr-only">可执行模块插件详情</h2>
            {error && <p role="alert" className="break-words text-sm text-destructive">{error}</p>}
            {!snapshot && loading ? <p role="status">正在读取可执行插件…</p> : null}
            {snapshot && detailPlugin ? (
              <RuntimePluginDetailView
                plugin={detailPlugin}
                busy={busy || loading}
                onRefresh={() => { void manage(refresh) }}
                onToggle={() => {
                  if (!snapshot) return
                  void manage(async () => setSnapshot(await window.electronAPI.moduleRuntimePlugin.setEnabled(
                    detailPlugin.manifest.id,
                    !detailPlugin.enabled,
                    snapshot.revision,
                  )))
                }}
                onVersions={() => openVersions(detailPlugin.manifest.id)}
                onUninstall={() => setRemoveId(detailPlugin.manifest.id)}
                configuration={grantPanel(detailPlugin)}
              />
            ) : null}
            {snapshot && !detailPlugin ? <SettingsCard><p className="p-5 text-sm text-muted-foreground">该可执行插件不存在或已卸载。</p></SettingsCard> : null}
          </>
        ) : (
          <>
            {showHeading && <div>
              <h2 id="runtime-plugins-title" className="text-xl font-semibold">可执行模块插件</h2>
              <p className="mt-1 text-sm text-muted-foreground">
                V3 插件可以提供 Agent 工具、右侧 Surface、服务和受控能力。安装或启用本身不会把模块注入对话，仍需在当前会话中激活。
              </p>
            </div>}
            <div className="flex flex-wrap gap-2">
              {allowInstall && <Button disabled={busy || loading} onClick={choose}>安装可执行插件</Button>}
              <Button variant="outline" disabled={busy || loading} onClick={() => { void manage(refresh) }}>刷新</Button>
            </div>
            {error && <p role="alert" className="break-words text-sm text-destructive">{error}</p>}
            {!snapshot && loading ? <p role="status">正在读取可执行插件…</p> : null}
            {snapshot && visiblePlugins.length === 0 ? (
              <SettingsCard><p className="p-5 text-sm text-muted-foreground">尚未安装可执行模块插件。开发者可先使用 `dutydeck-plugin init --profile module-runtime` 创建工程。</p></SettingsCard>
            ) : null}
            {snapshot && visiblePlugins.length > 0 ? (
              <div className="grid gap-4 xl:grid-cols-2">
                {visiblePlugins.map(plugin => (
                  <SettingsCard key={plugin.manifest.id}>
                    <article className="space-y-4 p-5">
                      <div className="flex flex-wrap items-start justify-between gap-3">
                        <div>
                          <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">可执行模块</p>
                          <h3 className="mt-1 text-lg font-semibold">
                            {plugin.manifest.displayName}
                            <span className="ml-2 text-xs font-normal text-muted-foreground">v{plugin.manifest.version}</span>
                          </h3>
                          <p className="break-all text-xs text-muted-foreground">{plugin.manifest.id}</p>
                        </div>
                        <span className="rounded-md bg-muted px-2 py-1 text-xs">{runtimeAuthorizationLabel(plugin)}</span>
                      </div>
                      <p className="text-sm leading-6 text-muted-foreground">{plugin.manifest.description}</p>
                      <RuntimeContractNotice plugin={plugin} />
                      <PluginRuntimeSummary plugin={plugin} />
                      <PluginRuntimeManagementSummary plugin={plugin} />
                      {grantPanel(plugin)}
                      <div className="flex flex-wrap gap-2">
                        <Button
                          variant="outline"
                          size="sm"
                          disabled={busy || loading || !snapshot || (!plugin.enabled && Boolean(plugin.executionBlock))}
                          onClick={() => {
                            if (!snapshot) return
                            void manage(async () => setSnapshot(await window.electronAPI.moduleRuntimePlugin.setEnabled(
                              plugin.manifest.id,
                              !plugin.enabled,
                              snapshot.revision,
                            )))
                          }}
                        >
                          {plugin.enabled ? '停用插件' : '启用插件'}
                        </Button>
                        <Button variant="outline" size="sm" disabled={busy || loading} onClick={() => openVersions(plugin.manifest.id)}>
                          版本历史
                        </Button>
                        <Button variant="ghost" size="sm" disabled={busy || loading} onClick={() => setRemoveId(plugin.manifest.id)}>
                          卸载
                        </Button>
                      </div>
                    </article>
                  </SettingsCard>
                ))}
              </div>
            ) : null}
          </>
        )}
      </section>

      <Dialog open={preview !== null} onOpenChange={(open) => {
        if (!open && !busy) {
          setPreview(null)
          setTrusted(false)
        }
      }}>
        <DialogContent className="max-h-[85vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>{preview?.operation === 'update' ? '确认更新可执行插件' : '确认安装可执行插件'}</DialogTitle>
            <DialogDescription>V3 插件包含高信任代码。安装不会自动授权或启用；请核对发布者、能力及数据风险。</DialogDescription>
          </DialogHeader>
          {preview && (
            <div className="space-y-3 text-sm">
              <p>{preview.manifest.displayName} · {preview.manifest.id}</p>
              <p>版本：{preview.previousVersion ? `${preview.previousVersion} → ` : ''}{preview.manifest.version}</p>
              <p className="break-all text-xs">包 SHA-256：{preview.packageHash}</p>
              <p className="break-all text-xs">签名：{preview.signatureVerified ? preview.signer?.keyId : '未签名（仅开发隔离模式）'}</p>
              <section aria-label="插件请求能力" className="rounded-lg border border-border/60 bg-muted/20 p-3">
                <h4 className="font-medium">请求能力</h4>
                <p className="mt-1 break-words text-xs text-muted-foreground">
                  {preview.manifest.capabilities.join('、') || '无'}
                </p>
              </section>
              {preview.changes && <PluginVersionChangesSummary changes={preview.changes} />}
              {preview.validation && <PluginValidationSummary assessment={preview.validation} />}
              {preview.signatureVerified && preview.signer && (
                <label className="flex items-start gap-2">
                  <input type="checkbox" checked={trusted} disabled={busy} onChange={event => setTrusted(event.target.checked)} />
                  <span>我已核对并信任此发布者指纹。执行能力将在安装后单独授权。</span>
                </label>
              )}
            </div>
          )}
          <DialogFooter>
            <Button variant="outline" disabled={busy} onClick={() => { setPreview(null); setTrusted(false) }}>取消</Button>
            <Button disabled={busy || !canInstall} onClick={install}>{busy ? '处理中…' : '确认安装'}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={versionsPluginId !== null} onOpenChange={open => {
        if (!open && !busy) {
          setVersionsPluginId(null)
          setVersions([])
        }
      }}>
        <DialogContent className="max-h-[85vh] overflow-y-auto" onCloseAutoFocus={event => {
          if (versionsTrigger.current?.isConnected) { event.preventDefault(); versionsTrigger.current.focus() }
        }}>
          <DialogHeader>
            <DialogTitle>插件版本历史</DialogTitle>
            <DialogDescription>包回滚不等于数据回滚。历史数据保持不变，版本切换后默认停用；精确包授权仍有效时可复用，否则需重新授权。不自动执行数据逆向迁移。</DialogDescription>
          </DialogHeader>
          <PluginVersionHistory
            versions={versions}
            currentPackageHash={snapshot?.plugins.find(plugin => plugin.manifest.id === versionsPluginId)?.packageHash}
            busy={busy}
            onRollback={version => {
              if (!snapshot || !versionsPluginId || versionsRevision === null) return
              void manage(async () => {
                setSnapshot(await window.electronAPI.moduleRuntimePlugin.rollback(
                  versionsPluginId,
                  version.packageHash,
                  versionsRevision,
                ))
                setVersionsPluginId(null)
                setVersions([])
              })
            }}
          />
          <DialogFooter>
            <Button variant="outline" disabled={busy} onClick={() => { setVersionsPluginId(null); setVersions([]) }}>关闭</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={removeId !== null} onOpenChange={open => { if (!open && !busy) setRemoveId(null) }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>卸载可执行插件？</DialogTitle>
            <DialogDescription>插件会从 Agent 工具和 Surface 目录撤销。项目产物、插件私有状态和历史包保留。</DialogDescription>
          </DialogHeader>
          <p className="break-all text-sm">{removeId}</p>
          <DialogFooter>
            <Button variant="outline" disabled={busy} onClick={() => setRemoveId(null)}>取消</Button>
            <Button
              variant="destructive"
              disabled={busy || !snapshot}
              onClick={() => {
                if (!removeId || !snapshot) return
                void manage(async () => {
                  setSnapshot(await window.electronAPI.moduleRuntimePlugin.uninstall(removeId, snapshot.revision))
                  setRemoveId(null)
                })
              }}
            >
              确认卸载
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  )
}

/** 展示不可变历史包，并把回滚动作留给父组件执行。 */
export function PluginVersionHistory(props: {
  versions: ArchivedModuleRuntimePluginVersionView[]
  currentPackageHash?: string
  busy: boolean
  onRollback(version: ArchivedModuleRuntimePluginVersionView): void
}): React.ReactElement {
  return (
    <div className="space-y-2">
      {props.versions.length === 0 && <p role="status" className="text-sm text-muted-foreground">没有可用的归档版本。</p>}
      {props.versions.map(version => {
        const isCurrent = version.packageHash === props.currentPackageHash
        return (
          <article key={version.packageHash} className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-border/60 p-3 text-sm">
            <div>
              <p className="font-medium">v{version.version}{isCurrent ? ' · 当前版本' : ''}</p>
              <p className="break-all text-xs text-muted-foreground">{version.packageHash}</p>
              <p className="text-xs text-muted-foreground">{version.signatureVerified ? `已签名 · ${version.keyId}` : '开发包 · 未签名'}</p>
            </div>
            {version.changes && !isCurrent && <PluginVersionChangesSummary changes={version.changes} />}
            <Button
              variant="outline"
              size="sm"
              disabled={props.busy || isCurrent || Boolean(version.changes?.blockers.length)}
              onClick={() => props.onRollback(version)}
            >
              {isCurrent ? '正在使用' : version.changes?.blockers.length ? '已阻止降级' : '回滚到此版本'}
            </Button>
          </article>
        )
      })}
    </div>
  )
}

/** 只展示清单差异；实际项目数据兼容性始终保留为未知。 */
export function PluginVersionChangesSummary({ changes }: { changes: ModuleRuntimePluginChanges }): React.ReactElement {
  return <section aria-label="版本变更与数据风险" className="w-full space-y-2 rounded-lg border border-border/60 p-3 text-xs">
    <h4 className="font-medium">版本变更与数据风险</h4>
    <p>新增能力：{changes.capabilitiesAdded.join('、') || '无'}</p>
    <p>移除能力：{changes.capabilitiesRemoved.join('、') || '无'}</p>
    <p>设置声明变化：{changes.settingsChanged.join('、') || '无'}</p>
    <p>Runtime 合同变化：{changes.runtimeContractChanged ? '是' : '否'}</p>
    {changes.artifacts.map(artifact => <p key={artifact.id}>产物 {artifact.id}：{artifact.fromSchema ?? '未声明'} → {artifact.toSchema ?? '未声明'}</p>)}
    <p className="text-muted-foreground">包回滚不等于数据回滚。仅比较清单，未检查项目数据；没有声明差异也不代表数据兼容。版本切换不自动授予新增权限。</p>
    {changes.blockers.length > 0 && <p role="alert" className="text-destructive">目标包降低或移除产物 schema 声明，缺少迁移合同，已阻止操作。原包和数据保持不变。</p>}
  </section>
}

/** 与内置插件详情一致的可执行插件详情，不混入设置页的安装列表布局。 */
export function RuntimePluginDetailView(props: {
  plugin: InstalledModuleRuntimePluginView
  busy: boolean
  onRefresh(): void
  onToggle(): void
  onVersions(): void
  onUninstall(): void
  configuration?: React.ReactNode
}): React.ReactElement {
  const manifest = props.plugin.manifest
  return (
    <section aria-label={`插件 ${manifest.displayName} 详情`} className="space-y-4">
      <div className="space-y-2">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">可执行模块插件</p>
          <span className="rounded-md bg-muted px-2.5 py-1 text-xs text-muted-foreground">
            {runtimeAuthorizationLabel(props.plugin)} · v{manifest.version}
          </span>
        </div>
        <p className="text-sm text-muted-foreground">{manifest.description}</p>
        <p className="break-all text-xs text-muted-foreground">{manifest.id}</p>
      </div>

      <RuntimeContractNotice plugin={props.plugin} />
      <PluginRuntimeManagementSummary plugin={props.plugin} />
      <Tabs defaultValue="overview" className="space-y-3">
        <TabsList className="grid h-auto w-full grid-cols-2 sm:grid-cols-4" aria-label="可执行插件详情内容">
          <TabsTrigger value="overview">说明</TabsTrigger>
          <TabsTrigger value="tools">工具</TabsTrigger>
          <TabsTrigger value="surface">Surface 与服务</TabsTrigger>
          <TabsTrigger value="permissions">权限与版本</TabsTrigger>
        </TabsList>

        <TabsContent value="overview" forceMount className="space-y-3 data-[state=inactive]:hidden">
          <section className="rounded-lg border border-border/60 bg-muted/20 p-4">
            <h3 className="text-sm font-medium">插件说明</h3>
            <p className="mt-2 text-sm leading-6 text-muted-foreground">{manifest.description}</p>
            <p className="mt-3 text-xs leading-5 text-muted-foreground">
              安装、授权、启用和实际执行是不同状态；模块仍需在当前会话中明确选择，调用时继续遵守宿主审批。
            </p>
          </section>
          <section className="rounded-lg border border-border/60 p-4">
            <h3 className="text-sm font-medium">模块</h3>
            <ul className="mt-2 space-y-2 text-sm">
              {manifest.modules.map(module => (
                <li key={module.id} className="rounded-md bg-muted/30 px-3 py-2">
                  <p className="font-medium">{module.displayName}</p>
                  <p className="mt-1 text-xs leading-5 text-muted-foreground">{module.description}</p>
                  <p className="mt-1 break-all text-[11px] text-muted-foreground">{module.id}</p>
                </li>
              ))}
            </ul>
          </section>
        </TabsContent>

        <TabsContent value="tools" forceMount className="space-y-2 data-[state=inactive]:hidden">
          {manifest.tools.length > 0 ? manifest.tools.map(tool => (
            <section key={tool.id} className="rounded-lg border border-border/60 p-4">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <h3 className="text-sm font-medium">{tool.title}</h3>
                <span className="rounded bg-muted px-2 py-1 text-[11px] text-muted-foreground">
                  {tool.annotations.readOnly ? '声明只读' : '可能写入'} · {tool.approval === 'none' ? '无额外审批（仍受宿主策略约束）' : tool.approval === 'write' ? '写入确认' : '逐次确认'}
                </span>
              </div>
              <p className="mt-2 text-sm leading-6 text-muted-foreground">{tool.description}</p>
              <code className="mt-2 block break-all text-[11px] text-muted-foreground">{tool.agentName}</code>
            </section>
          )) : <p className="text-sm text-muted-foreground">该插件未声明 Agent 工具。</p>}
        </TabsContent>

        <TabsContent value="surface" forceMount className="space-y-3 data-[state=inactive]:hidden">
          <section className="rounded-lg border border-border/60 p-4">
            <h3 className="text-sm font-medium">Surface</h3>
            {manifest.surfaces.length > 0 ? (
              <ul className="mt-2 space-y-2 text-sm text-muted-foreground">
                {manifest.surfaces.map(surface => <li key={surface.id}>{surface.title} · {surface.methods.length} 个方法</li>)}
              </ul>
            ) : <p className="mt-2 text-sm text-muted-foreground">未声明 Surface。</p>}
          </section>
          <section className="rounded-lg border border-border/60 p-4">
            <h3 className="text-sm font-medium">服务与产物</h3>
            <p className="mt-2 text-sm text-muted-foreground">服务：{manifest.services.map(service => service.title).join('、') || '无'}</p>
            <p className="mt-1 text-sm text-muted-foreground">产物：{manifest.artifacts.map(artifact => artifact.title).join('、') || '无'}</p>
          </section>
        </TabsContent>

        <TabsContent value="permissions" forceMount className="space-y-3 data-[state=inactive]:hidden">
          <section className="rounded-lg border border-border/60 p-4 text-sm">
            <h3 className="text-sm font-medium">身份与兼容性</h3>
            <dl className="mt-3 grid gap-3 sm:grid-cols-2">
              <div><dt className="text-xs text-muted-foreground">发布者</dt><dd className="mt-1">{manifest.publisherId}</dd></div>
              <div><dt className="text-xs text-muted-foreground">插件版本</dt><dd className="mt-1">v{manifest.version}</dd></div>
              <div><dt className="text-xs text-muted-foreground">平台</dt><dd className="mt-1">{manifest.compatibility.platforms.join(' / ')}</dd></div>
              <div><dt className="text-xs text-muted-foreground">架构</dt><dd className="mt-1">{manifest.compatibility.architectures.join(' / ')}</dd></div>
              <div><dt className="text-xs text-muted-foreground">Host API</dt><dd className="mt-1">{manifest.compatibility.hostApi}</dd></div>
              <div><dt className="text-xs text-muted-foreground">签名</dt><dd className="mt-1 break-all">{props.plugin.keyId ?? '开发包 · 未签名'}</dd></div>
            </dl>
            <p className="mt-3 break-all text-xs text-muted-foreground">包 SHA-256：{props.plugin.packageHash}</p>
          </section>
          <section className="rounded-lg border border-border/60 p-4">
            <h3 className="text-sm font-medium">请求能力</h3>
            <div className="mt-2 flex flex-wrap gap-2">
              {manifest.capabilities.map(capability => <code key={capability} className="rounded bg-muted px-2 py-1 text-xs">{capability}</code>)}
            </div>
          </section>
        </TabsContent>
      </Tabs>

      {props.configuration}
      <div className="flex flex-wrap gap-2 border-t border-border/60 pt-4">
        <Button variant="outline" size="sm" disabled={props.busy || (!props.plugin.enabled && Boolean(props.plugin.executionBlock))} onClick={props.onToggle}>
          {props.plugin.enabled ? '停用插件' : '启用插件'}
        </Button>
        <Button variant="outline" size="sm" disabled={props.busy} onClick={props.onVersions}>版本历史</Button>
        <Button variant="ghost" size="sm" disabled={props.busy} onClick={props.onRefresh}>刷新</Button>
        <Button variant="ghost" size="sm" disabled={props.busy} onClick={props.onUninstall}>卸载</Button>
      </div>
    </section>
  )
}

/** 旧合同包仍可查看和卸载；不能把重新授权误当作代码迁移。 */
function RuntimeContractNotice({ plugin }: { plugin: InstalledModuleRuntimePluginView }): React.ReactElement | null {
  if (!plugin.executionBlock) return null
  return <p role="status" className="rounded-lg border border-border p-3 text-sm leading-6">
    需要升级状态调用合同。此包采用旧 runtime contract，不能在当前宿主启用。
    请作者使用 SDK 0.2.0，将工具和 Surface 中的状态访问迁移到 call.state；激活阶段只读，初始化写入移至获准调用，重新构建并声明 runtimeProtocol 2。
    包、授权记录和状态数据保持不变，不能只修改版本字段或重新授权来代替代码迁移。
  </p>
}

/** 展示模块、工具、Surface、服务和产物声明，不显示包内文件路径。 */
function PluginRuntimeSummary({ plugin }: { plugin: InstalledModuleRuntimePluginView }): React.ReactElement {
  const manifest = plugin.manifest
  return (
    <div className="space-y-2 rounded-lg border border-border/60 bg-muted/20 p-4 text-xs">
      <p>发布者：{manifest.publisherId} · {manifest.compatibility.platforms.join('/')} · {manifest.compatibility.architectures.join('/')}</p>
      <p>模块：{manifest.modules.map(module => module.displayName).join('、')}</p>
      <p>工具：{manifest.tools.map(tool => tool.title).join('、') || '无'}</p>
      <p>Surface：{manifest.surfaces.map(surface => surface.title).join('、') || '无'}</p>
      <p>服务：{manifest.services.map(service => service.title).join('、') || '无'}</p>
      <p>产物：{manifest.artifacts.map(artifact => artifact.title).join('、') || '无'}</p>
      <p className="break-all text-muted-foreground">能力：{manifest.capabilities.join('、') || '无'}</p>
    </div>
  )
}

/** 只展示可行动错误文本，不回显底层对象。 */
function errorMessage(error: unknown, fallback: string): string {
  if (error instanceof Error && error.message.includes('PLUGIN_RUNTIME_CONTRACT_MIGRATION_REQUIRED')) return '需要升级状态调用合同：请作者迁移到 SDK 0.2.0 的 call.state，重新构建 runtimeProtocol 2 包。旧包和数据保持不变。'
  if (error instanceof Error && error.message.includes('PLUGIN_PREVIEW_BASELINE_CHANGED')) return '当前插件已变化，请关闭此预览并重新选择安装包，核对最新差异后再确认。'
  if (error instanceof Error && error.message.includes('PLUGIN_ARTIFACT_REMOVAL_UNSUPPORTED')) return '目标版本移除产物声明，缺少迁移合同，已阻止操作。请保留声明或使用显式迁移方案。'
  if (error instanceof Error && error.message.includes('PLUGIN_ARTIFACT_SCHEMA_DOWNGRADE')) return '目标版本降低产物 schema，缺少逆向迁移合同，已阻止操作。原包和数据保持不变。'
  if (isPluginManagementBusyError(error)) return pluginImportErrorMessage(error)
  return error instanceof Error && error.message.trim() ? error.message : fallback
}
