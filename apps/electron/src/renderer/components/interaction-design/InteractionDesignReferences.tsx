import * as React from 'react'
import type { PrototypeAsset, PrototypeDocument, PrototypeDraft, PrototypeReference, PrototypeReferenceRole } from '@dutydeck/shared'
import { Bot, ImagePlus, Images, Link2, MoreHorizontal, Trash2, Upload } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { Input } from '@/components/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { ImageLightbox, type LightboxImage } from '@/components/ui/image-lightbox'
import { addPrototypeReference, INTERACTION_REFERENCE_DROP_LIMIT, isInteractionReferenceImageFile, removePrototypeReference, setPrototypeReferencePages } from './interaction-design-reference-model'
import { createPrototypePreviewAssetReader, loadPrototypePreviewAssets, type PrototypePreviewAssetData } from './interaction-design-assets'
import './interaction-design.css'

/** 参考图页只接收已采纳正文、资产摘要和受控读取函数。 */
export interface InteractionDesignReferencesProps {
  /** 当前正式原型或候选正文。 */
  document: PrototypeDocument
  /** 当前模块资产摘要，不包含图片正文。 */
  assets: PrototypeAsset[]
  /** 当前工作区是否可见；隐藏页不发起迟到图片读取。 */
  active: boolean
  /** 候选预览只读；参考图拓扑仍必须回到正式版本或完整候选流程修改。 */
  readOnly?: boolean
  /** 当前页面身份，用于默认关联目标。 */
  selectedPageId: string | null
  /** 受控资产读取，避免组件自行接触 IPC。 */
  readAsset: (asset: PrototypeAsset) => Promise<PrototypePreviewAssetData>
  /** 保存参考图草稿；调用方执行现有 revision CAS。 */
  onSave: (draft: PrototypeDraft, summary: string) => void
  /** 导入项目图片，复用工作区现有资产导入表单。 */
  onImportAsset: () => void
  /** 导入用户主动拖入的外部图片；父组件负责资产落盘和版本 CAS。 */
  onImportFiles: (files: File[]) => void
  /** 将参考图与当前页面身份引用到主会话。 */
  onReference: (referenceId: string) => void
}

/** 角色只表达 Agent 使用图片的方式，不改变图片资产本身。 */
const ROLE_LABELS: Record<PrototypeReferenceRole, string> = {
  structure: '结构参考',
  visual: '视觉参考',
  copy: '文案参考',
}

/** 新增参考图的本地表单。 */
interface AddReferenceDraft {
  assetId: string
  title: string
  role: PrototypeReferenceRole
  pageIds: string[]
}

/** 页面多选列表在新增与重关联弹窗中复用。 */
function PageChecklist(props: {
  pages: PrototypeDocument['pages']
  selectedIds: string[]
  onChange: (ids: string[]) => void
}): React.ReactElement {
  return <div className="id-page-checklist" aria-label="参考图关联页面">
    {props.pages.map(page => <label key={page.id}>
      <input
        type="checkbox"
        checked={props.selectedIds.includes(page.id)}
        onChange={event => props.onChange(event.target.checked
          ? [...props.selectedIds, page.id]
          : props.selectedIds.filter(pageId => pageId !== page.id))}
      />
      <span><strong>{page.name}</strong><small>{page.route ?? page.role ?? page.id}</small></span>
    </label>)}
  </div>
}

/** 参考图卡片使用正方形外壳，图片自身始终保持完整比例。 */
function ReferenceCard(props: {
  reference: PrototypeReference
  asset: PrototypeAsset | undefined
  imageUrl: string | undefined
  imageError: string | undefined
  readOnly: boolean
  onOpen: () => void
  onLink: () => void
  onReference: () => void
  onRemove: () => void
}): React.ReactElement {
  const targetNames = props.reference.usages.length
    ? props.reference.usages.map(usage => usage.stateId ? `${usage.pageId} / ${usage.stateId}` : usage.flowId ? `${usage.pageId} / ${usage.flowId}` : usage.pageId).join('、')
    : '未关联页面'
  return <article className="id-reference-card">
    <button className="id-reference-square" onClick={props.onOpen} aria-label={`${props.reference.title}参考图`}>
      {props.imageUrl
        ? <span
            className="id-reference-square-image"
            aria-hidden="true"
            style={{ backgroundImage: `url("${props.imageUrl}")` }}
          />
        : <span className="id-reference-image-fallback"><Images size={20} /><small>{props.imageError ?? (props.asset ? '正在读取图片' : '资产缺失')}</small></span>}
      <span className="id-reference-role">{ROLE_LABELS[props.reference.role]}</span>
    </button>
    <div className="id-reference-card-copy">
      <div><strong title={props.reference.title}>{props.reference.title}</strong><small title={targetNames}>{targetNames}</small></div>
      {!props.readOnly && <DropdownMenu>
        <DropdownMenuTrigger asChild><button aria-label={`${props.reference.title}参考图操作`}><MoreHorizontal size={14} /></button></DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="id-directory-menu">
          <DropdownMenuItem onSelect={props.onLink}><Link2 size={14} />关联页面</DropdownMenuItem>
          <DropdownMenuItem onSelect={props.onReference}><Bot size={14} />引用到主会话</DropdownMenuItem>
          <DropdownMenuItem className="text-destructive" onSelect={props.onRemove}><Trash2 size={14} />移出参考图</DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>}
    </div>
  </article>
}

/** 参考图主视图：图库、添加、页面关联和大图查看都在同一受控组件内。 */
export function InteractionDesignReferences(props: InteractionDesignReferencesProps): React.ReactElement {
  /** 参考图数组只在正文变化时换身份，避免资源 effect 因空数组重建循环读取。 */
  const references = React.useMemo(() => props.document.references ?? [], [props.document.references])
  const assetsById = React.useMemo(() => new Map(props.assets.map(asset => [asset.id, asset])), [props.assets])
  const referencedAssetIds = React.useMemo(() => new Set(references.map(reference => reference.assetId)), [references])
  const unreferencedAssets = React.useMemo(() => props.assets.filter(asset => !referencedAssetIds.has(asset.id)), [props.assets, referencedAssetIds])
  const [imageData, setImageData] = React.useState<Record<string, string>>({})
  const [imageErrors, setImageErrors] = React.useState<Record<string, string>>({})
  const [addDraft, setAddDraft] = React.useState<AddReferenceDraft | null>(null)
  const [linkReference, setLinkReference] = React.useState<PrototypeReference | null>(null)
  const [linkPageIds, setLinkPageIds] = React.useState<string[]>([])
  const [viewer, setViewer] = React.useState<PrototypeReference | null>(null)
  const [formError, setFormError] = React.useState<string | null>(null)
  const [dropError, setDropError] = React.useState<string | null>(null)
  const [dropActive, setDropActive] = React.useState(false)
  /** 嵌套子元素会触发多组 enter/leave，用计数避免拖过文字时空态闪烁。 */
  const dragDepth = React.useRef(0)

  /** 原生图片查看器按参考图顺序展示已读取的大图，缺失正文的资产不进入翻页列表。 */
  const lightboxEntries = React.useMemo(() => references.flatMap(reference => {
    const src = imageData[reference.assetId]
    if (!src) return []
    const image: LightboxImage = {
      src,
      alt: `${reference.title} · ${ROLE_LABELS[reference.role]}${reference.source ? ` · ${reference.source}` : ''}`,
    }
    return [{ referenceId: reference.id, image }]
  }), [imageData, references])
  const viewerIndex = viewer ? Math.max(0, lightboxEntries.findIndex(entry => entry.referenceId === viewer.id)) : 0
  const viewerSource = viewer ? imageData[viewer.assetId] : undefined

  React.useEffect(() => {
    if (!props.active) return
    let disposed = false
    const used = props.assets.filter(asset => references.some(reference => reference.assetId === asset.id) || unreferencedAssets.some(candidate => candidate.id === asset.id))
    void loadPrototypePreviewAssets({
      assets: used,
      read: props.readAsset,
      isCurrent: () => !disposed && props.active,
      onSettled: (asset, outcome) => {
        if (outcome.status === 'fulfilled' && outcome.value.assetId === asset.id) {
          setImageData(previous => ({ ...previous, [asset.id]: outcome.value.dataUrl }))
          setImageErrors(previous => {
            const { [asset.id]: _removed, ...rest } = previous
            return rest
          })
        } else {
          setImageErrors(previous => ({ ...previous, [asset.id]: '图片读取失败' }))
        }
      },
    })
    return () => { disposed = true }
  }, [props.active, props.assets, props.readAsset, references, unreferencedAssets])

  const openAdd = (): void => {
    if (props.readOnly) return
    const asset = unreferencedAssets[0]
    if (!asset) { props.onImportAsset(); return }
    const pageId = props.selectedPageId && props.document.pages.some(page => page.id === props.selectedPageId)
      ? props.selectedPageId
      : props.document.entryPageId
    setFormError(null)
    setAddDraft({ assetId: asset.id, title: asset.name.replace(/\.[^.]+$/, ''), role: 'visual', pageIds: [pageId] })
  }

  const submitAdd = (): void => {
    if (!addDraft) return
    const asset = assetsById.get(addDraft.assetId)
    if (!asset) { setFormError('请选择项目图片'); return }
    try {
      const next = addPrototypeReference(props.document, asset, {
        id: crypto.randomUUID(),
        title: addDraft.title,
        role: addDraft.role,
        pageIds: addDraft.pageIds,
      })
      props.onSave(next, '添加参考图')
      setAddDraft(null)
    } catch (error) {
      setFormError(error instanceof Error ? error.message : '参考图保存失败')
    }
  }

  const submitLinks = (): void => {
    if (!linkReference) return
    try {
      props.onSave(setPrototypeReferencePages(props.document, linkReference.id, linkPageIds), '更新参考图关联')
      setLinkReference(null)
      setFormError(null)
    } catch (error) {
      setFormError(error instanceof Error ? error.message : '参考图关联失败')
    }
  }

  /** 只把用户主动拖入的受支持图片交给父组件，超量或非法格式在入口拒绝。 */
  const dropFiles = (files: File[]): void => {
    dragDepth.current = 0
    setDropActive(false)
    if (props.readOnly) return
    if (files.length > INTERACTION_REFERENCE_DROP_LIMIT) {
      setDropError(`一次最多拖入 ${INTERACTION_REFERENCE_DROP_LIMIT} 张参考图`)
      return
    }
    const accepted = files.filter(isInteractionReferenceImageFile)
    if (!accepted.length) {
      setDropError('请拖入 20 MB 以内的 PNG、JPG、GIF 或 WebP 图片')
      return
    }
    if (accepted.length !== files.length) setDropError('已忽略不支持或超过 20 MB 的文件')
    else setDropError(null)
    props.onImportFiles(accepted)
  }

  /** 文件进入参考图工作区时显示明确投放反馈。 */
  const handleDragEnter = (event: React.DragEvent<HTMLElement>): void => {
    if (props.readOnly || !event.dataTransfer.types.includes('Files')) return
    event.preventDefault()
    dragDepth.current += 1
    setDropActive(true)
  }

  /** 浏览器只有在 preventDefault 后才允许 drop。 */
  const handleDragOver = (event: React.DragEvent<HTMLElement>): void => {
    if (props.readOnly || !event.dataTransfer.types.includes('Files')) return
    event.preventDefault()
    event.dataTransfer.dropEffect = 'copy'
  }

  /** 离开所有子元素后才撤销投放态。 */
  const handleDragLeave = (event: React.DragEvent<HTMLElement>): void => {
    if (props.readOnly || !event.dataTransfer.types.includes('Files')) return
    dragDepth.current = Math.max(0, dragDepth.current - 1)
    if (dragDepth.current === 0) setDropActive(false)
  }

  /** 阻止 Electron 打开拖入文件，并转为受控资产导入。 */
  const handleDrop = (event: React.DragEvent<HTMLElement>): void => {
    event.preventDefault()
    dropFiles(Array.from(event.dataTransfer.files))
  }

  return <section
    className={`id-references-view${dropActive ? ' is-drop-target' : ''}`}
    aria-label="参考图"
    data-drop-active={dropActive}
    onDragEnter={handleDragEnter}
    onDragOver={handleDragOver}
    onDragLeave={handleDragLeave}
    onDrop={handleDrop}
  >
    <header className="id-references-toolbar">
      <div><span className="id-eyebrow">REFERENCES</span><h3>参考图 <small>{references.length}</small></h3></div>
      <p>拖入图片即可添加；参考图会随原型版本保存，Agent 可读取用途与原图。</p>
      {!props.readOnly && <Button size="sm" onClick={openAdd}><ImagePlus size={14} />{unreferencedAssets.length ? '添加参考图' : '导入项目图片'}</Button>}
    </header>
    {dropError && <div className="id-reference-drop-error" role="alert">{dropError}</div>}

    {references.length
      ? <div className="id-reference-grid">{references.map(reference => <ReferenceCard
          key={reference.id}
          reference={reference}
          asset={assetsById.get(reference.assetId)}
          imageUrl={imageData[reference.assetId]}
          imageError={imageErrors[reference.assetId]}
          readOnly={props.readOnly === true}
          onOpen={() => setViewer(reference)}
          onLink={() => { if (!props.readOnly) { setLinkReference(reference); setLinkPageIds([...new Set(reference.usages.map(usage => usage.pageId))]); setFormError(null) } }}
          onReference={() => props.onReference(reference.id)}
          onRemove={() => { if (!props.readOnly) props.onSave(removePrototypeReference(props.document, reference.id), '移除参考图') }}
        />)}</div>
      : <div className="id-reference-empty"><Upload size={28} /><strong>拖入参考图</strong><p>支持 PNG、JPG、GIF、WebP，最大 20 MB；拖入后会作为当前页面的视觉参考，也可以继续从项目图片中选择。</p>{!props.readOnly && <Button variant="outline" size="sm" onClick={openAdd}>{unreferencedAssets.length ? '选择项目图片' : '导入项目图片'}</Button>}</div>}

    {dropActive && <div className="id-reference-drop-overlay" aria-hidden="true"><span><Upload size={24} /></span><strong>松开即可添加参考图</strong><small>将关联到当前页面，并标记为视觉参考</small></div>}

    <Dialog open={addDraft !== null} onOpenChange={open => { if (!open) setAddDraft(null) }}>
      <DialogContent className="id-reference-dialog">
        <DialogHeader><DialogTitle>添加参考图</DialogTitle><DialogDescription>参考图只约束 Agent 的设计依据，不代表页面和交互已经实现。</DialogDescription></DialogHeader>
        {addDraft && <div className="id-reference-form">
          <label>项目图片<Select value={addDraft.assetId} onValueChange={assetId => setAddDraft({ ...addDraft, assetId })}>
            <SelectTrigger><SelectValue /></SelectTrigger>
            <SelectContent>{unreferencedAssets.map(asset => <SelectItem key={asset.id} value={asset.id}>{asset.name}</SelectItem>)}</SelectContent>
          </Select></label>
          <label>标题<Input value={addDraft.title} onChange={event => setAddDraft({ ...addDraft, title: event.target.value })} /></label>
          <label>用途<Select value={addDraft.role} onValueChange={role => setAddDraft({ ...addDraft, role: role as PrototypeReferenceRole })}>
            <SelectTrigger><SelectValue /></SelectTrigger>
            <SelectContent>{Object.entries(ROLE_LABELS).map(([value, label]) => <SelectItem key={value} value={value}>{label}</SelectItem>)}</SelectContent>
          </Select></label>
          <fieldset><legend>关联页面</legend><PageChecklist pages={props.document.pages} selectedIds={addDraft.pageIds} onChange={pageIds => setAddDraft({ ...addDraft, pageIds })} /></fieldset>
          {formError && <p role="alert">{formError}</p>}
        </div>}
        <DialogFooter><Button variant="ghost" onClick={() => setAddDraft(null)}>取消</Button><Button disabled={!addDraft?.title.trim() || !addDraft.pageIds.length} onClick={submitAdd}>保存参考图</Button></DialogFooter>
      </DialogContent>
    </Dialog>

    <Dialog open={linkReference !== null} onOpenChange={open => { if (!open) setLinkReference(null) }}>
      <DialogContent className="id-reference-dialog">
        <DialogHeader><DialogTitle>关联页面</DialogTitle><DialogDescription>{linkReference?.title} · {linkReference && ROLE_LABELS[linkReference.role]}</DialogDescription></DialogHeader>
        <PageChecklist pages={props.document.pages} selectedIds={linkPageIds} onChange={setLinkPageIds} />
        {formError && <p role="alert">{formError}</p>}
        <DialogFooter><Button variant="ghost" onClick={() => setLinkReference(null)}>取消</Button><Button disabled={!linkPageIds.length} onClick={submitLinks}>保存关联</Button></DialogFooter>
      </DialogContent>
    </Dialog>

    <ImageLightbox
      src={viewerSource}
      alt={viewer ? `${viewer.title} · ${ROLE_LABELS[viewer.role]}` : '参考图'}
      open={viewer !== null}
      onOpenChange={open => { if (!open) setViewer(null) }}
      images={lightboxEntries.length > 1 ? lightboxEntries.map(entry => entry.image) : undefined}
      index={viewerIndex}
      onIndexChange={index => {
        const next = lightboxEntries[index]
        if (!next) return
        setViewer(references.find(reference => reference.id === next.referenceId) ?? null)
      }}
    />
  </section>
}
