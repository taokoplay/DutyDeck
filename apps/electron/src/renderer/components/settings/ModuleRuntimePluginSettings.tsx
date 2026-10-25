import * as React from 'react'
import type {
  ArchivedModuleRuntimePluginVersionView,
  InstalledModuleRuntimePluginView,
  ModuleRuntimePluginPreviewView,
  ModuleRuntimePluginSnapshotView,
} from '@dutydeck/shared'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { SettingsCard } from './primitives'
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
  const [busy, setBusy] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)
  const [preview, setPreview] = React.useState<ModuleRuntimePluginPreviewView | null>(null)
  const [trusted, setTrusted] = React.useState(false)
  const [removeId, setRemoveId] = React.useState<string | null>(null)
  const [versionsPluginId, setVersionsPluginId] = React.useState<string | null>(null)
  const [versions, setVersions] = React.useState<ArchivedModuleRuntimePluginVersionView[]>([])
  const generation = React.useRef(0)

  /** 每次读取只允许最新代次更新页面，旧错误不覆盖新快照。 */
  const refresh = React.useCallback(async (): Promise<void> => {
    const current = ++generation.current
    setLoading(true)
    try {
      const next = await window.electronAPI.moduleRuntimePlugin.get()
      if (current === generation.current) {
        setSnapshot(next)
        setError(null)
      }
    } catch (cause) {
      if (current === generation.current) setError(errorMessage(cause, '读取可执行插件失败'))
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

  /** 串行执行管理动作，失败时保留已有目录并刷新真实状态。 */
  const manage = async (operation: () => Promise<void>): Promise<void> => {
    if (busy) return
    setBusy(true)
    setError(null)
    try {
      await operation()
    } catch (cause) {
      setError(errorMessage(cause, '插件操作失败'))
      await refresh()
    } finally {
      setBusy(false)
    }
  }

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
    void manage(async () => {
      setVersionsPluginId(pluginId)
      setVersions(await window.electronAPI.moduleRuntimePlugin.listVersions(pluginId))
    })
  }

  const canInstall = preview !== null && (!preview.signatureVerified || (trusted && Boolean(preview.signer)))
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
                        <span className="rounded-md bg-muted px-2 py-1 text-xs">{plugin.enabled ? '已启用' : '已停用'}</span>
                      </div>
                      <p className="text-sm leading-6 text-muted-foreground">{plugin.manifest.description}</p>
                      <PluginRuntimeSummary plugin={plugin} />
                      <div className="flex flex-wrap gap-2">
                        <Button
                          variant="outline"
                          size="sm"
                          disabled={busy || loading || !snapshot}
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
            <DialogDescription>V3 插件会执行代码。只有核对发布者指纹和能力后，才能信任并安装。</DialogDescription>
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
              {preview.signatureVerified && preview.signer && (
                <label className="flex items-start gap-2">
                  <input type="checkbox" checked={trusted} disabled={busy} onChange={event => setTrusted(event.target.checked)} />
                  <span>我已核对发布者指纹，并信任此插件执行声明能力。</span>
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
        <DialogContent className="max-h-[85vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>插件版本历史</DialogTitle>
            <DialogDescription>历史包保持不可变。回滚只切换当前运行版本，不删除项目产物、插件状态或当前包。</DialogDescription>
          </DialogHeader>
          <PluginVersionHistory
            versions={versions}
            currentPackageHash={snapshot?.plugins.find(plugin => plugin.manifest.id === versionsPluginId)?.packageHash}
            busy={busy}
            onRollback={version => {
              if (!snapshot || !versionsPluginId) return
              void manage(async () => {
                setSnapshot(await window.electronAPI.moduleRuntimePlugin.rollback(
                  versionsPluginId,
                  version.packageHash,
                  snapshot.revision,
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
      {props.versions.map(version => {
        const isCurrent = version.packageHash === props.currentPackageHash
        return (
          <article key={version.packageHash} className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-border/60 p-3 text-sm">
            <div>
              <p className="font-medium">v{version.version}{isCurrent ? ' · 当前版本' : ''}</p>
              <p className="break-all text-xs text-muted-foreground">{version.packageHash}</p>
              <p className="text-xs text-muted-foreground">{version.signatureVerified ? `已签名 · ${version.keyId}` : '开发包 · 未签名'}</p>
            </div>
            <Button
              variant="outline"
              size="sm"
              disabled={props.busy || isCurrent}
              onClick={() => props.onRollback(version)}
            >
              {isCurrent ? '正在使用' : '回滚到此版本'}
            </Button>
          </article>
        )
      })}
    </div>
  )
}

/** 与内置插件详情一致的可执行插件详情，不混入设置页的安装列表布局。 */
export function RuntimePluginDetailView(props: {
  plugin: InstalledModuleRuntimePluginView
  busy: boolean
  onRefresh(): void
  onToggle(): void
  onVersions(): void
  onUninstall(): void
}): React.ReactElement {
  const manifest = props.plugin.manifest
  return (
    <section aria-label={`插件 ${manifest.displayName} 详情`} className="space-y-4">
      <div className="space-y-2">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">可执行模块插件</p>
          <span className="rounded-md bg-muted px-2.5 py-1 text-xs text-muted-foreground">
            {props.plugin.enabled ? '已启用' : '已停用'} · v{manifest.version}
          </span>
        </div>
        <p className="text-sm text-muted-foreground">{manifest.description}</p>
        <p className="break-all text-xs text-muted-foreground">{manifest.id}</p>
      </div>

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
              安装和启用只代表插件可用；模块仍需在当前会话中明确选择，才会进入下一轮 Agent 上下文。
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
                  {tool.annotations.readOnly ? '只读' : '写入'} · {tool.approval === 'none' ? '无需审批' : tool.approval === 'write' ? '写入确认' : '逐次确认'}
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

      <div className="flex flex-wrap gap-2 border-t border-border/60 pt-4">
        <Button variant="outline" size="sm" disabled={props.busy} onClick={props.onToggle}>
          {props.plugin.enabled ? '停用插件' : '启用插件'}
        </Button>
        <Button variant="outline" size="sm" disabled={props.busy} onClick={props.onVersions}>版本历史</Button>
        <Button variant="ghost" size="sm" disabled={props.busy} onClick={props.onRefresh}>刷新</Button>
        <Button variant="ghost" size="sm" disabled={props.busy} onClick={props.onUninstall}>卸载</Button>
      </div>
    </section>
  )
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
  if (isPluginManagementBusyError(error)) return pluginImportErrorMessage(error)
  return error instanceof Error && error.message.trim() ? error.message : fallback
}
