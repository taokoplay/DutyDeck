import * as React from 'react'
import { AlertTriangle, CheckCircle2, PackageOpen, Upload } from 'lucide-react'
import type { PluginPackageImportPreview } from '@dutydeck/shared'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { SettingsCard } from './primitives'
import {
  installPluginWhenIdle,
  pluginImportErrorMessage,
  validatePluginDropFiles,
} from './PluginPackageImporter.logic'
import type { ContentPluginCatalog } from './PluginSettings'

/** 完整重启提示；Renderer HMR 不能更新 contextBridge。 */
const BRIDGE_UNAVAILABLE_MESSAGE = '插件导入桥尚未加载，请完整重启 DutyDeck 后重试'

/** 安装成功后需要展示并被已安装目录消费的最小信息。 */
export interface PluginImportSuccessResult {
  kind: 'content' | 'runtime'
  displayName: string
  version: string
}

/** 安装成功反馈明确类型、固定版本以及模块仍需在会话中启用。 */
export function PluginImportSuccess({ result }: { result: PluginImportSuccessResult }): React.ReactElement {
  return (
    <div role="status" className="flex items-start gap-3 rounded-lg border border-emerald-500/30 bg-emerald-500/5 p-4 text-sm">
      <CheckCircle2 className="mt-0.5 size-5 shrink-0 text-emerald-500" aria-hidden="true" />
      <div className="min-w-0 space-y-1">
        <p className="font-medium">已安装 {result.displayName} <span className="font-normal text-muted-foreground">v{result.version}</span></p>
        <p className="text-xs text-muted-foreground">
          {result.kind === 'runtime' ? '可执行模块插件' : '内容插件'} · 已加入“已安装”列表；模块仍需在当前会话中启用。
        </p>
      </div>
    </div>
  )
}

/** Agent 忙碌时明确安装已排队，并承诺不打断当前任务。 */
export function PluginImportWaitingNotice(): React.ReactElement {
  return (
    <p role="status" className="rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs leading-5 text-amber-800 dark:text-amber-200">
      Agent 正在运行。插件包已校验并保留，当前任务结束后会自动安装，不会打断正在执行的任务。
    </p>
  )
}

/** 市场页统一导入入口；兼容内容插件和可执行模块插件。 */
export function PluginPackageImporter(props: {
  catalog: ContentPluginCatalog
  onInstalled?: (result: PluginImportSuccessResult) => void | Promise<void>
}): React.ReactElement {
  const [preview, setPreview] = React.useState<PluginPackageImportPreview | null>(null)
  const [trusted, setTrusted] = React.useState(false)
  const [busy, setBusy] = React.useState(false)
  const [dragging, setDragging] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)
  const [success, setSuccess] = React.useState<PluginImportSuccessResult | null>(null)
  const [waitingForAgent, setWaitingForAgent] = React.useState(false)
  const pending = React.useRef(false)
  const waitAbort = React.useRef<AbortController | null>(null)
  /** contextBridge 只能随应用重启更新，旧 Renderer 热更新时提前显示可行动状态。 */
  const bridgeAvailable = typeof window !== 'undefined' && Boolean(window.electronAPI?.pluginPackageImport)

  /** 统一串行预览与安装；一次只处理一个包，防止重复提交。 */
  const run = async (operation: () => Promise<void>): Promise<void> => {
    if (pending.current) return
    pending.current = true
    setBusy(true)
    setError(null)
    setSuccess(null)
    try {
      await operation()
    } catch (cause) {
      setError(pluginImportErrorMessage(cause))
    } finally {
      pending.current = false
      setBusy(false)
      setWaitingForAgent(false)
      waitAbort.current = null
    }
  }

  React.useEffect(() => () => {
    waitAbort.current?.abort()
  }, [])

  /** 打开系统文件选择器并由主进程生成统一预览。 */
  const choose = (): void => {
    const bridge = window.electronAPI.pluginPackageImport
    if (!bridge) {
      setError(BRIDGE_UNAVAILABLE_MESSAGE)
      return
    }
    void run(async () => {
      const next = await bridge.preview()
      if (next) {
        setPreview(next)
        setTrusted(false)
      }
    })
  }

  /** 读取拖放文件字节后只在主进程解析，不把文件路径暴露给 renderer。 */
  const acceptFiles = (files: readonly File[]): void => {
    const invalid = validatePluginDropFiles(files.map(file => ({ name: file.name, size: file.size })))
    if (invalid) {
      setError(invalid)
      return
    }
    const file = files[0]
    if (!file) return
    const bridge = window.electronAPI.pluginPackageImport
    if (!bridge) {
      setError(BRIDGE_UNAVAILABLE_MESSAGE)
      return
    }
    void run(async () => {
      const bytes = new Uint8Array(await file.arrayBuffer())
      const next = await bridge.previewBytes(bytes)
      setPreview(next)
      setTrusted(false)
    })
  }

  /** 根据统一预览的类型提交到现有内容插件或可执行插件安装事务。 */
  const install = (): void => {
    if (!preview) return
    if (preview.preview.signatureVerified && !trusted) return
    const controller = new AbortController()
    waitAbort.current = controller
    void run(async () => {
      const trustedKeyId = preview.preview.signatureVerified && trusted
        ? preview.preview.signer?.keyId
        : undefined
      await installPluginWhenIdle(async () => {
        if (preview.kind === 'content') {
          const snapshot = await window.electronAPI.installContentPlugin(preview.preview.token, trustedKeyId)
          props.catalog.accept(snapshot)
        } else {
          await window.electronAPI.moduleRuntimePlugin.install(preview.preview.token, trustedKeyId)
        }
      }, {
        signal: controller.signal,
        onBusy: () => setWaitingForAgent(true),
      })
      const result: PluginImportSuccessResult = {
        kind: preview.kind,
        displayName: preview.preview.manifest.displayName,
        version: preview.preview.manifest.version,
      }
      setPreview(null)
      setTrusted(false)
      setSuccess(result)
      await props.onInstalled?.(result)
    })
  }

  const canInstall = preview !== null && (!preview.preview.signatureVerified || trusted)
  return <>
    <SettingsCard>
      <div
        aria-label="拖放插件包导入"
        className={`flex min-h-52 flex-col items-center justify-center gap-4 border-2 border-dashed p-8 text-center transition-colors ${
          dragging ? 'border-foreground/60 bg-muted/50' : 'border-border/70 bg-background/20'
        }`}
        onDragEnter={event => {
          event.preventDefault()
          if (!busy) setDragging(true)
        }}
        onDragOver={event => {
          event.preventDefault()
          event.dataTransfer.dropEffect = 'copy'
        }}
        onDragLeave={event => {
          event.preventDefault()
          if (event.currentTarget === event.target) setDragging(false)
        }}
        onDrop={event => {
          event.preventDefault()
          setDragging(false)
          if (!busy) acceptFiles([...event.dataTransfer.files])
        }}
      >
        <span className="grid size-12 place-items-center rounded-full bg-muted text-muted-foreground">
          <Upload className="size-5" aria-hidden="true" />
        </span>
        <div className="space-y-2">
          <p className="text-base font-medium">{dragging ? '松开以校验插件包' : '拖动插件包到这里'}</p>
          <p className="text-sm leading-6 text-muted-foreground">
            支持内容插件和可执行模块插件，格式统一为 <code className="rounded bg-muted px-1.5 py-0.5">.ddplugin</code>，单文件不超过 50 MB。
          </p>
          <p className="text-xs leading-5 text-muted-foreground">
            拖入后先校验包结构、版本、平台兼容和签名，再显示安装或更新确认，不会直接执行插件代码。
          </p>
        </div>
        <Button variant="outline" disabled={busy || !bridgeAvailable} onClick={choose}>
          <PackageOpen className="size-4" />{busy ? '正在校验…' : '选择本地插件包'}
        </Button>
      </div>
      {!bridgeAvailable && (
        <p role="alert" className="flex items-start gap-2 border-t border-border/60 px-5 py-4 text-sm text-destructive">
          <AlertTriangle className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
          <span>{BRIDGE_UNAVAILABLE_MESSAGE}</span>
        </p>
      )}
      {error && !preview && (
        <p role="alert" className="flex items-start gap-2 border-t border-border/60 px-5 py-4 text-sm text-destructive">
          <AlertTriangle className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
          <span className="break-words">{error}</span>
        </p>
      )}
    </SettingsCard>
    {success && <PluginImportSuccess result={success} />}

    <Dialog open={preview !== null} onOpenChange={open => {
      if (!open && !busy) {
        setPreview(null)
        setTrusted(false)
      }
    }}>
      <DialogContent className="max-h-[85vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{preview?.preview.operation === 'update' ? '确认更新插件' : '确认安装插件'}</DialogTitle>
          <DialogDescription>包已经过结构与摘要校验。签名有效只表示来源密钥一致，仍需由你确认是否信任。</DialogDescription>
        </DialogHeader>
        {preview && (
          <div className="space-y-3 text-sm">
            <div className="flex flex-wrap items-center gap-2">
              <span className="rounded-md bg-muted px-2 py-1 text-xs">
                {preview.kind === 'content' ? '内容插件' : '可执行模块插件'}
              </span>
              <strong>{preview.preview.manifest.displayName}</strong>
              <span className="text-muted-foreground">v{preview.preview.manifest.version}</span>
            </div>
            <p className="break-all text-xs text-muted-foreground">{preview.preview.manifest.id}</p>
            <p>{preview.preview.manifest.description}</p>
            {preview.preview.previousVersion && <p>版本更新：{preview.preview.previousVersion} → {preview.preview.manifest.version}</p>}
            <p className="break-all text-xs">包 SHA-256：{preview.preview.packageHash}</p>
            <p className="break-all text-xs">
              签名：{preview.preview.signatureVerified
                ? preview.preview.signer?.keyId
                : '未签名；仅能在隔离开发数据根加载'}
            </p>
            {preview.kind === 'runtime' && (
              <section aria-label="可执行插件能力" className="rounded-lg border border-border/60 bg-muted/20 p-3">
                <h4 className="font-medium">Agent 工具与能力</h4>
                <p className="mt-1 text-xs leading-5 text-muted-foreground">
                  工具 {preview.preview.manifest.tools.length} · Surface {preview.preview.manifest.surfaces.length} · 服务 {preview.preview.manifest.services.length}
                </p>
                <p className="mt-2 break-words text-xs text-muted-foreground">
                  能力：{preview.preview.manifest.capabilities.join('、') || '无'}
                </p>
              </section>
            )}
            {preview.kind === 'content' && (
              <p className="text-xs text-muted-foreground">
                资源：Skills {preview.preview.resources.filter(resource => resource.kind === 'skill').length} · 提示词 {preview.preview.resources.filter(resource => resource.kind === 'prompt').length}
              </p>
            )}
            {preview.preview.signatureVerified && preview.preview.signer && (
              <label className="flex items-start gap-2">
                <input type="checkbox" checked={trusted} disabled={busy} onChange={event => setTrusted(event.target.checked)} />
                <span>我已核对发布者指纹，并信任此插件及其声明能力。</span>
              </label>
            )}
            {waitingForAgent && <PluginImportWaitingNotice />}
            {error && (
              <p role="alert" className="flex items-start gap-2 rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2 text-xs leading-5 text-destructive">
                <AlertTriangle className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
                <span className="break-words">{error}</span>
              </p>
            )}
          </div>
        )}
        <DialogFooter>
          <Button
            variant="outline"
            disabled={busy && !waitingForAgent}
            onClick={() => {
              if (waitingForAgent) {
                waitAbort.current?.abort()
                return
              }
              setPreview(null)
              setTrusted(false)
            }}
          >
            {waitingForAgent ? '停止等待' : '取消'}
          </Button>
          <Button disabled={busy || !canInstall} onClick={install}>
            {waitingForAgent ? '等待 Agent…' : busy ? '处理中…' : preview?.preview.operation === 'update' ? '确认更新' : '确认安装'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  </>
}
