import * as React from 'react'
import { Download, FileJson, Film, ImageIcon, ImageOff, Loader2, Music2 } from 'lucide-react'
import type { VisualProductionSnapshot } from '@dutydeck/shared'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible'
import { VisualMediaView } from './VisualMediaView'
import { buildVisualDelivery } from './visual-delivery-model'
import type { VisualDeliveryItem, VisualDeliveryUsage } from './visual-delivery-model'

/** 导出页仅组织正式素材；文件读取、下载和来源导航沿用工作台权限边界。 */
interface VisualProductionDeliveryProps {
  sessionId: string
  snapshot: VisualProductionSnapshot
  active: boolean
  onExportManifest: () => Promise<void>
  onExportMedia: (mediaId: string, name: string) => Promise<void>
  onOpenAsset: (assetId: string) => void
  onOpenShot: (episodeId: string, shotId: string) => void
  onOpenShots: () => void
}

/** 素材种类采用创作用语，格式由真实 MIME 单独说明。 */
const KIND_LABELS = { image: '图片', video: '视频', audio: '声音' }

/** 将元数据字节数转为简短可读大小，不读取文件内容。 */
function fileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

/** 多处使用同一素材时收起额外位置，避免重复下载与无限长卡片。 */
function DeliveryUsages({ usages, onOpen }: { usages: VisualDeliveryUsage[]; onOpen: (usage: VisualDeliveryUsage) => void }): React.ReactElement {
  /** 位置按钮保留完整标题和键盘焦点，长文本按面板宽度省略。 */
  const source = (usage: VisualDeliveryUsage): React.ReactElement => <Button key={`${usage.kind}:${usage.id}`} variant="link" size="sm" className="vp-delivery-source" title={usage.label} aria-label={`查看来源：${usage.label}`} onClick={() => onOpen(usage)}>{usage.label}</Button>
  return <div className="vp-delivery-usages">
    {usages.slice(0, 2).map(source)}
    {usages.length > 2 && <Collapsible><CollapsibleTrigger asChild><Button variant="ghost" size="sm" className="h-6 px-0 text-xs text-muted-foreground">另有 {usages.length - 2} 处使用位置</Button></CollapsibleTrigger><CollapsibleContent>{usages.slice(2).map(source)}</CollapsibleContent></Collapsible>}
  </div>
}

/** 以可识别的素材列表承接导出，不把 JSON 清单或单镜头素材称为成片。 */
export function VisualProductionDelivery({ sessionId, snapshot, active, onExportManifest, onExportMedia, onOpenAsset, onOpenShot, onOpenShots }: VisualProductionDeliveryProps): React.ReactElement {
  /** 列表投影只依赖正式元数据，不读取候选媒体或触发生成。 */
  const model = React.useMemo(() => buildVisualDelivery(snapshot), [snapshot.document, snapshot.media, snapshot.shotStates])
  /** 预览保存素材身份，后台快照刷新时同步失效状态。 */
  const [previewId, setPreviewId] = React.useState<string | null>(null)
  const preview = model.items.find(item => item.id === previewId)
  const previewTrigger = React.useRef<HTMLButtonElement | null>(null)
  /** 文件下载串行进行，避免连续点击把整库同时读入内存。 */
  const [downloading, setDownloading] = React.useState<string | null>(null)
  const downloadLock = React.useRef(false)
  const mounted = React.useRef(true)
  React.useEffect(() => { mounted.current = true; return () => { mounted.current = false } }, [])
  React.useEffect(() => { if (!active) setPreviewId(null) }, [active])
  /** 单次操作的迟到完成不能更新已经离开的页面。 */
  const runDownload = async (key: string, action: () => Promise<void>): Promise<void> => {
    if (downloadLock.current) return
    downloadLock.current = true; setDownloading(key)
    try { await action() }
    finally { downloadLock.current = false; if (mounted.current) setDownloading(null) }
  }
  /** 定位复用工作台现有分镜和资产弹窗，不额外复制详情。 */
  const openUsage = (usage: VisualDeliveryUsage): void => {
    setPreviewId(null)
    if (usage.kind === 'asset') onOpenAsset(usage.id)
    else if (usage.episodeId) onOpenShot(usage.episodeId, usage.id)
  }
  /** 数量按文件去重；缺失元数据不会计入可下载素材。 */
  const available = model.items.filter(item => item.media)
  const missing = model.items.length - available.length
  const shotLabel = snapshot.document.kind === 'image' ? '图片' : '镜头'
  /** 只在用户点击后读取视频或音频，图片缩略图由原预览组件按视口加载。 */
  const renderItem = (item: VisualDeliveryItem): React.ReactElement => <article key={item.id} className="vp-delivery-item">
    <Button variant="ghost" className="vp-delivery-preview" disabled={!item.media} aria-label={`预览：${item.title}`} onClick={event => { previewTrigger.current = event.currentTarget; setPreviewId(item.id) }}>
      {item.media?.kind === 'image' && active ? <VisualMediaView sessionId={sessionId} productionId={snapshot.document.id} media={{ ...item.media, name: item.title }} /> : item.media?.kind === 'video' ? <Film size={24} /> : item.media?.kind === 'audio' ? <Music2 size={24} /> : <ImageOff size={24} />}
    </Button>
    <div className="vp-delivery-info">
      <div className="vp-delivery-title"><h4 title={item.title}>{item.title}</h4>{!item.media ? <span className="vp-badge">素材缺失</span> : item.needsUpdate ? <span className="vp-badge">待更新</span> : null}</div>
      <p className="vp-muted">{item.media ? `${KIND_LABELS[item.media.kind]} · ${item.media.mime.split('/')[1]?.toUpperCase()} · ${fileSize(item.media.byteSize)}` : '无法读取素材信息，请返回来源重新关联。'}</p>
      <DeliveryUsages usages={item.usages} onOpen={openUsage} />
      {item.needsUpdate && item.media && <p className="vp-muted">设定已变化，下载的仍是当前已采用版本。</p>}
    </div>
    <Button variant="outline" size="sm" className="vp-delivery-download" disabled={!item.media || !!downloading} aria-label={`下载：${item.title}`} onClick={() => void runDownload(item.id, () => onExportMedia(item.id, item.usages[0]?.label ?? item.title))}>
      {downloading === item.id ? <Loader2 className="animate-spin" /> : <Download />}<span>{downloading === item.id ? '准备中' : '下载'}</span>
    </Button>
  </article>
  return <div className="vp-section vp-delivery">
    <header className="vp-delivery-header">
      <h3>素材导出</h3>
      <p className="vp-muted">下载当前已采用的素材，用于后续制作。{snapshot.document.kind === 'image' ? '图片可单独保存。' : '成片需要将镜头视频、配音和音乐剪辑合成。'}</p>
      <p className="vp-delivery-summary">{available.length} 份素材<span className="vp-muted">{(['image', 'video', 'audio'] as const).map(kind => `${KIND_LABELS[kind]} ${available.filter(item => item.media?.kind === kind).length}`).join(' · ')}</span></p>
      {(model.unmadeShots > 0 || model.unmadeAssets > 0 || missing > 0) && <p className="vp-muted">{[model.unmadeShots ? `${model.unmadeShots} 个${shotLabel}尚未采用素材` : '', model.unmadeAssets ? `${model.unmadeAssets} 项资产尚未关联素材` : '', missing ? `${missing} 份素材信息缺失` : ''].filter(Boolean).join('；')}。</p>}
    </header>
    {(['shot', 'asset'] as const).map(group => {
      /** 同一文件同时用于镜头与资产时只出现在镜头组，所有来源仍可查看。 */
      const items = model.items.filter(item => item.group === group)
      return items.length > 0 && <section key={group} className="vp-delivery-group" aria-label={group === 'shot' ? `${shotLabel}素材` : '项目资产'}>
        <div className="vp-delivery-group-heading"><h3>{group === 'shot' ? `${shotLabel}素材` : '项目资产'}</h3><span className="vp-muted">{items.length} 份</span></div>
        <div className="vp-delivery-list">{items.map(renderItem)}</div>
      </section>
    })}
    {!model.items.length && <div className="vp-empty vp-delivery-empty"><ImageIcon size={28} /><h3>还没有可导出的素材</h3><p className="vp-muted">为{shotLabel}采用生成结果，或为项目资产关联素材后，会显示在这里。</p><Button variant="outline" onClick={onOpenShots}>查看{shotLabel === '图片' ? '图片' : '分镜'}</Button></div>}
    <section className="vp-delivery-manifest" aria-label="制作清单">
      <FileJson size={20} aria-hidden="true" /><div><h3>制作清单</h3><p className="vp-muted">JSON 文件，记录作品设定、集数、镜头与素材关系；不包含图片、视频或声音文件。</p></div>
      <Button variant="outline" size="sm" disabled={!!downloading} onClick={() => void runDownload('manifest', onExportManifest)}>{downloading === 'manifest' ? <Loader2 className="animate-spin" /> : <Download />}导出制作清单</Button>
    </section>
    <Dialog open={active && !!preview?.media} onOpenChange={open => { if (!open) setPreviewId(null) }}>
      <DialogContent className="vp-dialog vp-delivery-dialog sm:max-w-[760px]" onCloseAutoFocus={event => { event.preventDefault(); if (active && previewTrigger.current?.isConnected) previewTrigger.current.focus() }}>
        <DialogHeader><DialogTitle>{preview?.title ?? '素材预览'}</DialogTitle><DialogDescription>{preview?.media ? `${KIND_LABELS[preview.media.kind]} · ${fileSize(preview.media.byteSize)}` : '素材信息不可用'}</DialogDescription></DialogHeader>
        {preview?.media && active && <div className="vp-delivery-dialog-body"><VisualMediaView key={preview.id} sessionId={sessionId} productionId={snapshot.document.id} media={{ ...preview.media, name: preview.title }} controls className="vp-delivery-dialog-preview" /><DeliveryUsages usages={preview.usages} onOpen={openUsage} />{preview.needsUpdate && <p className="vp-muted">设定已变化，当前素材待更新。</p>}</div>}
        <div className="vp-form-footer"><Button variant="ghost" onClick={() => setPreviewId(null)}>关闭</Button><Button disabled={!preview?.media || !!downloading} onClick={() => { if (preview) void runDownload(preview.id, () => onExportMedia(preview.id, preview.usages[0]?.label ?? preview.title)) }}><Download />{downloading ? '准备下载…' : '下载素材'}</Button></div>
      </DialogContent>
    </Dialog>
  </div>
}
