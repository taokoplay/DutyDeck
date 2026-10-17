import * as React from 'react'
import { ImageOff } from 'lucide-react'
import type { VisualAsset, VisualMedia } from '@proma/shared'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { VisualMediaView } from './VisualMediaView'

/** 引用选择只修改镜头草稿，图片预览复用当前作品的受控媒体读取。 */
interface VisualAssetReferenceProps {
  /** 当前会话与作品身份用于原有 IPC 权限校验。 */
  sessionId: string
  productionId: string
  /** 当前草稿中引用的资产及其已绑定素材，不能替换为未采用候选。 */
  asset: VisualAsset
  media?: VisualMedia
  /** 镜头是否引用该资产；悬浮与聚焦均不更改此值。 */
  checked: boolean
  /** 工作区不可见时关闭预览。 */
  active: boolean
  /** 用户勾选后回传新值，由宿主更新并保存草稿。 */
  onCheckedChange: (checked: boolean) => void
}

/** 资产整行可悬浮查看图片，键盘聚焦复选框也能预览，空素材明确占位。 */
export function VisualAssetReference({ sessionId, productionId, asset, media, checked, active, onCheckedChange }: VisualAssetReferenceProps): React.ReactElement {
  /** 仅在实际展示浮层时挂载图片，关闭后由媒体组件回收 Blob URL。 */
  const [open, setOpen] = React.useState(false)
  /** 窄窗改在资产上方展示，避免侧向空间不足时图片被压成细条。 */
  const [narrow, setNarrow] = React.useState(false)
  /** 将浮层说明直接关联到可聚焦的复选框，而非只关联外层 label。 */
  const previewId = React.useId()
  /** 素材格式与资产角色类型分开判断，视频和声音不冒充图片。 */
  const emptyMessage = !asset.mediaId ? '尚未设置图片' : !media ? '引用素材不可用' : media.kind === 'video' ? '视频资产，暂无图片预览' : '声音资产，暂无图片预览'
  React.useEffect(() => { if (!active) setOpen(false) }, [active])
  React.useLayoutEffect(() => {
    if (!open || !active) return
    /** 仅当前打开的预览监听窗口断点，不为整库资产建立常驻监听。 */
    const breakpoint = window.matchMedia('(max-width: 640px)')
    const updatePlacement = (): void => setNarrow(breakpoint.matches)
    updatePlacement()
    breakpoint.addEventListener('change', updatePlacement)
    return () => breakpoint.removeEventListener('change', updatePlacement)
  }, [open, active])

  return <Tooltip open={open && active} onOpenChange={setOpen} delayDuration={300}>
    <TooltipTrigger asChild>
      <label className="vp-check vp-asset-reference" data-asset-id={asset.id}>
        <input type="checkbox" className="vp-themed-checkbox" aria-label={`引用资产：${asset.name}`} aria-describedby={open && active ? previewId : undefined} checked={checked} onChange={event => onCheckedChange(event.target.checked)} />
        <span className="vp-asset-reference-name">{asset.name}</span>
        <span className="vp-muted vp-asset-reference-type">{asset.type}</span>
      </label>
    </TooltipTrigger>
    {/* 弹窗位于模块 Portal 外，按整个视口避让，避免继承右侧面板边界而被裁切。 */}
    <TooltipContent id={previewId} side={narrow ? 'top' : 'left'} sideOffset={10} collisionBoundary={[]} collisionPadding={12} className="vp-asset-preview w-[260px] p-3">
      <div className="vp-asset-preview-heading"><strong>{asset.name}</strong><span className="text-muted-foreground">{asset.type}</span></div>
      {open && active && (media?.kind === 'image'
        ? <VisualMediaView key={`${productionId}:${media.id}`} sessionId={sessionId} productionId={productionId} media={media} />
        : <div className="vp-asset-preview-empty"><ImageOff size={24} aria-hidden="true" /><span>{emptyMessage}</span></div>)}
    </TooltipContent>
  </Tooltip>
}
