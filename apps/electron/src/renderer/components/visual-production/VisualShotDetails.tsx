import * as React from 'react'
import { ChevronDown, Film, ImageIcon, ImageOff, Music2 } from 'lucide-react'
import type { VisualAsset, VisualMedia, VisualShot, VisualShotState } from '@proma/shared'
import { Button } from '@/components/ui/button'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible'
import { VisualMediaView } from './VisualMediaView'

/** 镜头详情只读取当前正式资料；编辑和资产跳转由工作台处理。 */
interface VisualShotDetailsProps {
  /** 媒体读取沿用当前会话与影像作品的权限边界。 */
  sessionId: string
  productionId: string
  /** 当前镜头、作品资产库及已导入媒体，不包含候选内容。 */
  shot: VisualShot
  assets: VisualAsset[]
  media: VisualMedia[]
  /** 宿主计算的画面版本和更新状态。 */
  state?: VisualShotState
  /** 面板隐藏时卸载参考图片，释放预览资源。 */
  active: boolean
  /** 点击引用卡片后由工作台打开详情弹窗，不改变当前镜头。 */
  onOpenAsset: (assetId: string) => void
}

/** 按媒体实际类型显示中文名称，避免把参考声音或视频误称为图片。 */
const MEDIA_LABELS = { image: '图片', video: '视频', audio: '声音' }

/** 长提示词默认展示摘要，展开保留原文、换行与键盘操作。 */
function ShotText({ label, value, empty }: { label: string; value: string; empty: string }): React.ReactElement {
  /** 展开状态仅属于当前镜头字段，切镜后由父组件的 key 重置。 */
  const [expanded, setExpanded] = React.useState(false)
  /** 短内容直接展示，多行或长内容才提供展开入口。 */
  const expandable = value.length > 100 || value.split('\n').length > 3
  return <Collapsible open={expanded} onOpenChange={setExpanded} className="vp-shot-text">
    <div className="vp-shot-section-heading">
      <h4>{label}</h4>
      {expandable && <CollapsibleTrigger asChild>
        <Button variant="ghost" size="sm" className="group h-6 px-1.5 text-[11px]">{expanded ? '收起' : '展开全文'}<ChevronDown aria-hidden="true" className="transition-transform group-data-[state=open]:rotate-180" /></Button>
      </CollapsibleTrigger>}
    </div>
    {!expanded && <p className={`vp-summary ${expandable ? 'line-clamp-3' : ''} ${value ? '' : 'vp-muted'}`}>{value || empty}</p>}
    <CollapsibleContent><p className="vp-summary">{value}</p></CollapsibleContent>
  </Collapsible>
}

/** 将输出素材、引用图片和制作提示分区呈现，不解析或改写用户的长文本。 */
export function VisualShotDetails({ sessionId, productionId, shot, assets, media, state, active, onOpenAsset }: VisualShotDetailsProps): React.ReactElement {
  /** 当前作品媒体与资产按身份索引，后台刷新无需对每个引用重复扫描整库。 */
  const mediaById = React.useMemo(() => new Map(media.map(item => [item.id, item])), [media])
  const assetsById = React.useMemo(() => new Map(assets.map(item => [item.id, item])), [assets])
  /** 只展示该镜头实际采用的素材；未采用候选仍由制作记录承接。 */
  const output = shot.mediaId ? mediaById.get(shot.mediaId) : undefined
  return <div className="vp-shot-details">
    <section className="vp-shot-output" aria-label="当前画面素材">
      <div className="vp-shot-output-icon" aria-hidden="true">{output?.kind === 'video' ? <Film size={18} /> : <ImageIcon size={18} />}</div>
      <div className="min-w-0 flex-1">
        <h4>画面素材<span className="vp-muted">{output ? ` · ${MEDIA_LABELS[output.kind]} · 版本 ${state?.outputVersion ?? 0}` : ''}</span></h4>
        <p className="truncate vp-muted" title={output?.name}>{output?.name || (shot.mediaId ? '引用素材不可用' : '尚未采用画面')}</p>
      </div>
      <span className="vp-badge shrink-0">{!output ? shot.mediaId ? '素材缺失' : '待制作' : state?.needsUpdate ? '待更新' : '已采用'}</span>
    </section>
    <div className="vp-shot-detail-columns">
      <section className="vp-shot-assets" aria-label="镜头引用资产">
        <div className="vp-shot-section-heading"><h4>引用资产</h4><span className="vp-muted">{shot.assetIds.length} 项</span></div>
        <div className="vp-shot-asset-grid">{shot.assetIds.map(id => {
          /** 引用缺失时保留可见占位，不猜测其他同名资产。 */
          const asset = assetsById.get(id)
          /** 卡片只加载图片；视频、声音在资产详情中按需播放。 */
          const source = asset?.mediaId ? mediaById.get(asset.mediaId) : undefined
          return <Button key={id} variant="outline" className="vp-shot-asset" disabled={!asset} onClick={() => onOpenAsset(id)} aria-label={`查看资产：${asset?.name ?? '资产不可用'}`}>
            <span className="vp-shot-asset-image" aria-hidden="true">{source?.kind === 'image' && active
              ? <VisualMediaView key={`${productionId}:${source.id}`} sessionId={sessionId} productionId={productionId} media={source} />
              : source?.kind === 'video' ? <Film /> : source?.kind === 'audio' ? <Music2 /> : <ImageOff />}</span>
            <span className="vp-shot-asset-info"><span className="vp-shot-asset-name" title={asset?.name}>{asset?.name ?? '资产不可用'}</span><span className="vp-muted">{asset?.type ?? '引用已失效'}{source && source.kind !== 'image' ? ` · ${MEDIA_LABELS[source.kind]}` : ''}{asset?.locked ? ' · 已锁定' : ''}</span>{!source && asset && <span className="vp-muted">{asset.mediaId ? '素材不可用' : '待补充素材'}</span>}</span>
          </Button>
        })}</div>
        {!shot.assetIds.length && <p className="vp-muted">尚未引用资产，可在镜头设置中添加。</p>}
      </section>
      <section className="vp-shot-prompts" aria-label="镜头提示词">
        <div className="vp-shot-section-heading"><h4>制作提示词</h4><span className="vp-muted">来自镜头设定</span></div>
        <ShotText label="画面描述" value={shot.scene} empty="尚未填写画面描述" />
        <ShotText label="运镜与动作" value={shot.motion} empty="尚未设置运镜与动作" />
        <ShotText label="旁白 / 对白" value={shot.dialogue} empty="尚未设置旁白或对白" />
      </section>
    </div>
  </div>
}
