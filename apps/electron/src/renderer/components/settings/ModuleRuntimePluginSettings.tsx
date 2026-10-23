import * as React from 'react'
import type {
  InstalledModuleRuntimePluginView,
  ModuleRuntimePluginPreviewView,
  ModuleRuntimePluginSnapshotView,
} from '@dutydeck/shared'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { SettingsCard } from './primitives'

/** 管理 V3 可执行插件；设置页只展示声明摘要，不读取 runtime 或 Surface 正文。 */
export function ModuleRuntimePluginSettings(): React.ReactElement {
  const [snapshot, setSnapshot] = React.useState<ModuleRuntimePluginSnapshotView | null>(null)
  const [loading, setLoading] = React.useState(true)
  const [busy, setBusy] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)
  const [preview, setPreview] = React.useState<ModuleRuntimePluginPreviewView | null>(null)
  const [trusted, setTrusted] = React.useState(false)
  const [removeId, setRemoveId] = React.useState<string | null>(null)
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

  const canInstall = preview !== null && (!preview.signatureVerified || (trusted && Boolean(preview.signer)))
  return (
    <>
      <section aria-labelledby="runtime-plugins-title" className="space-y-4">
        <div>
          <h2 id="runtime-plugins-title" className="text-xl font-semibold">可执行模块插件</h2>
          <p className="mt-1 text-sm text-muted-foreground">
            V3 插件可以提供 Agent 工具、右侧 Surface、服务和受控能力。安装或启用本身不会把模块注入对话，仍需在当前会话中激活。
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button disabled={busy || loading} onClick={choose}>安装可执行插件</Button>
          <Button variant="outline" disabled={busy || loading} onClick={() => { void manage(refresh) }}>刷新</Button>
        </div>
        {error && <p role="alert" className="break-words text-sm text-destructive">{error}</p>}
        {!snapshot && loading ? <p role="status">正在读取可执行插件…</p> : null}
        {snapshot && snapshot.plugins.length === 0 ? (
          <SettingsCard><p className="p-5 text-sm text-muted-foreground">尚未安装可执行模块插件。开发者可先使用 `dutydeck-plugin init --profile module-runtime` 创建工程。</p></SettingsCard>
        ) : null}
        {snapshot && snapshot.plugins.length > 0 ? (
          <div className="grid gap-4 xl:grid-cols-2">
            {snapshot.plugins.map(plugin => (
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
                    <Button variant="ghost" size="sm" disabled={busy || loading} onClick={() => setRemoveId(plugin.manifest.id)}>
                      卸载
                    </Button>
                  </div>
                </article>
              </SettingsCard>
            ))}
          </div>
        ) : null}
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
  return error instanceof Error && error.message.trim() ? error.message : fallback
}
