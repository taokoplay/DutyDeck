import { mergeVisualProductionReferences, resolveVisualShotOutputs, withVisualShotOutput } from '@dutydeck/shared'
import { visualProductionReferencesAtomFamily } from '@/atoms/visual-production-reference-atoms'
import * as React from 'react'
import { useAtom, useSetAtom } from 'jotai'
import { ChevronLeft, ChevronRight, Film, FolderOpen, Plus, RefreshCw, ScrollText, Settings2, X } from 'lucide-react'
import { VISUAL_PRODUCTION_RATIOS } from '@dutydeck/shared'
import type { VisualProductionDraft, VisualProductionKind, VisualProductionSnapshot, VisualProductionSummary, VisualShotActionPhase, VisualShotContinuityPlan, VisualShotVideoPlan } from '@dutydeck/shared'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible'
import { agentPendingPromptAtom } from '@/atoms/agent-atoms'
import { visualProductionViewsAtom, type VisualProductionView } from '@/atoms/visual-production-atoms'
import { buildVisualCandidateReviewPrompt, buildVisualReference, buildVisualRetryPrompt, copyVisualDraft, reorderVisualShot, VisualRequestGate, VisualScopeEpoch, VISUAL_KIND_LABELS as KIND_LABELS } from './model'
import { VisualMediaView } from './VisualMediaView'
import { VisualProductionMediaConfigurationPanel } from './VisualProductionMediaConfiguration'
import { VisualProductionRecords } from './VisualProductionRecords'
import { VisualAssetReference } from './VisualAssetReference'
import { VisualShotMedia } from './VisualShotMedia'
import { VisualShotDetails } from './VisualShotDetails'
import { VisualShotSoundFields } from './VisualShotSoundFields'
import { VisualScriptWorkspace } from './VisualScriptWorkspace'
import { buildVisualScriptPrompt } from './visual-script-model'
import { buildShotMediaSlots, findRunningShotJob, SHOT_MEDIA_KINDS, SHOT_MEDIA_LABELS, visualJobActivityLabel, visualShotStatusLabel } from './shot-media-model'
import { VisualRelationCanvas } from './VisualRelationCanvas'
import { VisualProductionDelivery } from './VisualProductionDelivery'
import { VisualEditingWorkspace } from './VisualEditingWorkspace'
import { visualDeliveryFileName } from './visual-delivery-model'
import './visual-production.css'

/** 动作相位使用导演制作语言，供复杂动作逐个建立可读中间态。 */
const ACTION_PHASE_LABELS: Record<VisualShotActionPhase, string> = {
  start: '起始',
  development: '过程',
  contact: '接触',
  peak: '峰值',
  result: '结果',
  reaction: '反应',
  exit: '出口',
}

/** 声音接续与画面转场分开编辑，避免把 J-cut 当作视频模型输入。 */
const AUDIO_TRANSITION_LABELS = {
  'hard-cut': '同步硬切',
  'carry-over': '声音延续',
  prelap: '声音先入',
  'dialogue-carry': '对白跨切点',
} as const

/** 编辑器冻结作品与版本；后台刷新仅更新正式数据，不覆盖输入草稿。 */
interface VisualEditor { key: string; kind: 'project' | 'asset' | 'shot' | 'sound' | 'episode'; targetId: string; productionId: string; baseRevision: number; draft: VisualProductionDraft }
/** 没有业务数据时采用空视图，不种入演示作品。 */
const EMPTY_VIEW: VisualProductionView = { productionId: null, episodeId: null, shotId: null, tab: 'project' }
/** 资产类型使用内容角色分类，媒体格式单独显示。 */
const ASSET_TYPES = ['角色', '场景', '产品', '道具', '风格', '品牌', '声音']
/** Select 选项不能使用空字符串；下划线开头与合法媒体身份隔离，保存时还原为 null。 */
const NO_MEDIA_VALUE = '__no_media__'
/** 未选择生成计划时保留旧镜头缺省语义。 */
const NO_VIDEO_PLAN_VALUE = '__no_video_plan__'
/** 首帧选择当前已采用画面，避免另建重复的图片输出槽。 */
const CURRENT_SHOT_IMAGE_VALUE = '__current_shot_image__'
/** 动作锚点可以只保留文字状态，不要求每镜额外生成关键帧。 */
const NO_CONTINUITY_ANCHOR_VALUE = '__no_continuity_anchor__'

/** 独立影像制作工作台，所有 Agent 请求统一引用到主会话。 */
export function VisualProductionWorkspace({ projectId, sessionId, paneActive = true }: { projectId: string; sessionId: string; paneActive?: boolean }): React.ReactElement {
  const [views, setViews] = useAtom(visualProductionViewsAtom)
  const view = views[projectId] ?? EMPTY_VIEW
  const setPrompt = useSetAtom(agentPendingPromptAtom)
  /** 引用仅修改当前会话独立chip，不接触正文草稿。 */
  const setReferences = useSetAtom(visualProductionReferencesAtomFamily(sessionId))
  const [summaries, setSummaries] = React.useState<VisualProductionSummary[]>([])
  const [snapshot, setSnapshot] = React.useState<VisualProductionSnapshot | null>(null)
  const [directory, setDirectory] = React.useState(false)
  const [search, setSearch] = React.useState('')
  const [assetSearch, setAssetSearch] = React.useState('')
  const [assetType, setAssetType] = React.useState('全部')
  const [assetId, setAssetId] = React.useState<string | null>(null)
  const [editor, setEditor] = React.useState<VisualEditor | null>(null)
  const [create, setCreate] = React.useState(false)
  const [title, setTitle] = React.useState('')
  const [kind, setKind] = React.useState<VisualProductionKind>('film')
  const [importPath, setImportPath] = React.useState('')
  const [error, setError] = React.useState('')
  const [notice, setNotice] = React.useState('')
  const [busy, setBusy] = React.useState(false)
  const [loading, setLoading] = React.useState(true)
  const [playing, setPlaying] = React.useState(false)
  /** 记录弹窗打开时停止并卸载背景媒体，关闭后才恢复预览。 */
  const [recordsOpen, setRecordsOpen] = React.useState(false)
  /** 每次点击生成独立请求，支持重复打开同一候选。 */
  const [candidatePreview, setCandidatePreview] = React.useState<{ id: string; sequence: number } | null>(null)
  /** 镜头切换只滚动序列容器，不移动主舞台；窄屏自动使用横排。 */
  const shotStrip = React.useRef<HTMLDivElement>(null)
  /** 关闭弹窗保留本会话内草稿，每个作品/对象独立保存。 */
  const drafts = React.useRef(new Map<string, VisualEditor>())
  /** 弹窗关闭后还原入口焦点，便于键盘连续编辑。 */
  const editorOpener = React.useRef<HTMLElement | null>(null)
  /** 详情与编辑共用一个弹窗，切换内容时将焦点移到可见表单或标题。 */
  const editorDialog = React.useRef<HTMLDivElement>(null)
  /** 资产详情标题可接收程序焦点，打开长内容时从顶部开始阅读。 */
  const assetHeading = React.useRef<HTMLHeadingElement>(null)
  const gate = React.useRef(new VisualRequestGate())
  const listGate = React.useRef(new VisualRequestGate())
  const context = `${projectId}:${sessionId}:${view.productionId ?? ''}`
  const currentContext = React.useRef(context)
  /** 写操作采用独立作用域代次，不被同作用域的后台读取打断。 */
  const scope = React.useRef(new VisualScopeEpoch())
  const editorSequence = React.useRef(0)
  scope.current.enter(context)
  if (currentContext.current !== context) { currentContext.current = context; gate.current.next(); listGate.current.next() }
  const document = snapshot?.document.id === view.productionId ? snapshot.document : undefined
  const episodeId = document?.episodes.some(item => item.id === view.episodeId) ? view.episodeId : document?.episodes[0]?.id
  const shots = React.useMemo(() => document?.shots.filter(item => item.episodeId === episodeId) ?? [], [document, episodeId])
  const shot = shots.find(item => item.id === view.shotId) ?? shots[0]
  const selectedAsset = document?.assets.find(item => item.id === assetId)
  /** 详情只读取当前作品的正式资产，编辑草稿仍由原编辑器管理。 */
  const showingAssetDetails = !!selectedAsset && !editor
  /** 使用位置仅按资产身份关联，不把同名资产或其他作品镜头混入。 */
  const assetUsages = React.useMemo(() => document?.shots.filter(item => item.assetIds.includes(selectedAsset?.id ?? '')) ?? [], [document, selectedAsset?.id])
  /** 三类素材共享一次元数据索引，正式视觉优先影片。 */
  const mediaById = React.useMemo(() => new Map(snapshot?.media.map(item => [item.id, item]) ?? []), [snapshot?.media])
  /** 同一快照只解析一次当前集数素材，播放时不重复扫描所有候选。 */
  const shotSlotsById = React.useMemo(() => new Map(shots.map(item => [item.id, snapshot ? buildShotMediaSlots(snapshot, item) : []])), [snapshot, shots])
  /** 主窗口只接受影片，静帧保留在下方画面参考。 */
  const currentPreviewMedia = shotSlotsById.get(shot?.id ?? '')?.find(slot => slot.kind === 'video')?.preview
  /** 当前镜头的运行任务用于输出桶和列表状态，不把“静帧就绪”误写成影片完成。 */
  const runningShotJob = shot && snapshot ? findRunningShotJob(snapshot, shot.id) : undefined
  /** 预演只能在当前可见分镜上执行，弹窗中的试听拥有独立焦点。 */
  const shotMediaActive = paneActive && view.tab === 'shots' && !recordsOpen && !editor && !selectedAsset
  const shotIndex = shots.findIndex(item => item.id === shot?.id)
  /** 异步回流读取当前作用域，避免闭包把旧作品写回新面板。 */
  const latest = React.useRef({ busy, document, snapshot })
  latest.current = { busy, document, snapshot }
  const updateView = React.useCallback((patch: Partial<VisualProductionView>): void => { setViews(previous => ({ ...previous, [projectId]: { ...EMPTY_VIEW, ...previous[projectId], ...patch } })) }, [projectId, setViews])
  const accept = React.useCallback((next: VisualProductionSnapshot): void => {
    setSnapshot(previous => previous?.document.id === next.document.id && previous.document.revision === next.document.revision ? { ...next, document: previous.document } : next)
    setSummaries(previous => {
      const summary: VisualProductionSummary = { id: next.document.id, title: next.document.title, kind: next.document.kind, revision: next.document.revision, episodeCount: next.document.episodes.length, assetCount: next.document.assets.length, shotCount: next.document.shots.length, updatedAt: next.document.updatedAt }
      return previous.some(item => item.id === summary.id) ? previous.map(item => item.id === summary.id ? summary : item) : [...previous, summary]
    })
  }, [])
  const refreshList = React.useCallback(async (): Promise<void> => {
    const ticket = listGate.current.next()
    const identity = `${projectId}:${sessionId}`
    try {
      const next = await window.electronAPI.visualProduction.invoke('list', { sessionId })
      if (!listGate.current.accepts(ticket) || !currentContext.current.startsWith(`${identity}:`)) return
      setSummaries(next)
      if (!view.productionId && next[0]) updateView({ productionId: next[0].id })
    } catch (cause) { if (listGate.current.accepts(ticket)) setError(String(cause)) }
    finally { if (listGate.current.accepts(ticket)) setLoading(false) }
  }, [projectId, sessionId, view.productionId, updateView])
  const load = React.useCallback(async (autoAdopt = false): Promise<void> => {
    if (!view.productionId || latest.current.busy) return
    const ticket = gate.current.next()
    const target = currentContext.current; const epoch = scope.current.capture()
    setLoading(true)
    try {
      /** 自动采用只在打开/切换或用户刷新时显式触发；后台通知始终保持纯读取。 */
      const next = autoAdopt
        ? await window.electronAPI.visualProduction.invoke('autoAdoptShots', { sessionId, productionId: view.productionId })
        : await window.electronAPI.visualProduction.invoke('load', { sessionId, productionId: view.productionId })
      if (gate.current.accepts(ticket) && currentContext.current === target && scope.current.accepts(epoch)) accept(next)
    } catch (cause) { if (gate.current.accepts(ticket) && currentContext.current === target && scope.current.accepts(epoch)) setError(String(cause)) }
    finally { if (gate.current.accepts(ticket) && currentContext.current === target && scope.current.accepts(epoch)) setLoading(false) }
  }, [sessionId, view.productionId, accept])
  React.useEffect(() => () => scope.current.invalidate(), [])
  React.useEffect(() => { void refreshList(); return () => { listGate.current.next() } }, [refreshList])
  React.useEffect(() => {
    latest.current.busy = false; editorSequence.current++
    setSnapshot(null); setEditor(null); setCreate(false); setAssetId(null); setError(''); setNotice(''); setBusy(false); setPlaying(false); setRecordsOpen(false); setCandidatePreview(null); setImportPath('')
    void load(true)
    return () => { gate.current.next() }
  }, [context, load])
  React.useEffect(() => window.electronAPI.visualProduction.onChanged(event => {
    if (event.workspaceId !== projectId) return
    void refreshList()
    if ((!event.productionId || event.productionId === view.productionId) && !latest.current.busy) void load()
  }), [projectId, view.productionId, refreshList, load])
  React.useEffect(() => { if (!paneActive) setPlaying(false) }, [paneActive])
  React.useEffect(() => {
    if (!paneActive || !selectedAsset) return
    if (editor) editorDialog.current?.querySelector<HTMLInputElement>('form input')?.focus({ preventScroll: true })
    else assetHeading.current?.focus({ preventScroll: true })
  }, [editor?.key, selectedAsset?.id, paneActive])
  React.useEffect(() => {
    /** 只读取当前卡片和容器的边界，连续播放时无需逐帧测量整排镜头。 */
    const strip = shotStrip.current
    /** 使用实际选中节点，兼容镜头删除或集数切换后的默认选择。 */
    const selected = strip?.querySelector<HTMLElement>('.vp-shot[aria-pressed="true"]')
    if (!paneActive || !strip || !selected) return
    /** 分镜条可见区域，用于计算横向裁切范围。 */
    const viewport = strip.getBoundingClientRect()
    /** 当前卡片边界，仅超出可见范围时调整横向滚动。 */
    const card = selected.getBoundingClientRect()
    if (card.left < viewport.left + 4) strip.scrollLeft += card.left - viewport.left - 4
    else if (card.right > viewport.right - 4) strip.scrollLeft += card.right - viewport.right + 4
    if (card.top < viewport.top + 4) strip.scrollTop += card.top - viewport.top - 4
    else if (card.bottom > viewport.bottom - 4) strip.scrollTop += card.bottom - viewport.bottom + 4
  }, [shot?.id, shotIndex, document?.id, episodeId, view.tab, paneActive])
  React.useEffect(() => {
    if (!directory) return
    const close = (event: KeyboardEvent): void => { if (event.key === 'Escape') setDirectory(false) }
    window.addEventListener('keydown', close)
    return () => window.removeEventListener('keydown', close)
  }, [directory])
  React.useEffect(() => { setPlaying(false) }, [episodeId, view.tab, editor, assetId])
  React.useEffect(() => {
    const hide = (): void => { if (window.document.hidden) setPlaying(false) }
    window.document.addEventListener('visibilitychange', hide)
    return () => window.document.removeEventListener('visibilitychange', hide)
  }, [])
  /** 镜头切换按正式排序进行，末镜头播完停止。 */
  const advance = React.useCallback((): void => {
    /** 未采用视觉素材的镜头不能继续计时，也不能用待采用候选冒充正式预演。 */
    const next = shots[shotIndex + 1]
    if (!next) { setPlaying(false); return }
    updateView({ shotId: next.id })
    /** 连续预演只推进到下一镜已有影片的镜头，静帧不能冒充影片播放。 */
    if (!snapshot) { setPlaying(false); return }
    const nextVideo = buildShotMediaSlots(snapshot, next).find(slot => slot.kind === 'video')?.preview
    if (!nextVideo) setPlaying(false)
  }, [shots, shotIndex, updateView, snapshot])
  /** 所有写操作冻结上下文；旧返回既不清新草稿，也不更换新选择。 */
  const mutate = async (operation: () => Promise<VisualProductionSnapshot>, after?: () => void): Promise<void> => {
    if (latest.current.busy) return
    latest.current.busy = true
    const target = context; const epoch = scope.current.capture()
    gate.current.next(); listGate.current.next(); setBusy(true); setError(''); setPlaying(false)
    try { const next = await operation(); if (currentContext.current === target && scope.current.accepts(epoch)) { accept(next); after?.() } }
    catch (cause) { if (currentContext.current === target && scope.current.accepts(epoch)) setError(String(cause)) }
    finally { if (currentContext.current === target && scope.current.accepts(epoch)) { latest.current.busy = false; setBusy(false) } }
  }
  const reference = (targetShot?: string, targetAsset?: string): void => {
    if (!document) return
    setReferences(current => mergeVisualProductionReferences(current, [buildVisualReference(projectId, document, targetShot, targetAsset)]))
    setNotice('已添加对象引用，草稿已保留；请在 Agent 中说明需要的操作。')
  }
  /** 在当前页签打开资产详情；记录原入口，关闭后恢复焦点与滚动位置。 */
  const openAsset = (targetId: string): void => {
    editorOpener.current = window.document.activeElement instanceof HTMLElement ? window.document.activeElement : null
    setError(''); setPlaying(false); setAssetId(targetId)
  }
  const openEditor = (editorKind: VisualEditor['kind'], targetId?: string): void => {
    if (!document) return
    editorSequence.current++
    if (!selectedAsset) editorOpener.current = window.document.activeElement instanceof HTMLElement ? window.document.activeElement : null
    setError('')
    const id = targetId ?? crypto.randomUUID()
    const key = `${context}:${editorKind}:${targetId ?? 'new'}`
    const previous = drafts.current.get(key)
    if (previous) { setEditor(previous); return }
    const draft = copyVisualDraft(document)
    if (!targetId && editorKind === 'asset') draft.assets.push({ id, name: '', type: '角色', description: '', locked: false, mediaId: null })
    if (!targetId && editorKind === 'episode') draft.episodes.push({ id, title: '' })
    if (!targetId && editorKind === 'shot' && episodeId) draft.shots.push({ id, episodeId, title: '', duration: document.kind === 'image' ? 0 : 3, scene: '', motion: '', dialogue: '', assetIds: [], mediaId: null })
    setEditor({ key, kind: editorKind, targetId: id, productionId: document.id, baseRevision: document.revision, draft }); setImportPath('')
  }
  const changeEditor = (change: (draft: VisualProductionDraft) => void): void => {
    if (!editor) return
    editorSequence.current++
    const next = { ...editor, draft: copyVisualDraft(editor.draft) }
    change(next.draft); drafts.current.set(next.key, next); if (drafts.current.size > 100) drafts.current.delete(drafts.current.keys().next().value!); setEditor(next)
  }
  const closeEditor = (): void => { editorSequence.current++; if (editor) drafts.current.set(editor.key, editor); setEditor(null) }
  const saveEditor = (event: React.FormEvent): void => {
    event.preventDefault()
    if (!editor) return
    const frozen = editor
    const sequence = editorSequence.current
    void mutate(() => window.electronAPI.visualProduction.invoke('save', { sessionId, productionId: frozen.productionId, baseRevision: frozen.baseRevision, draft: frozen.draft }), () => { if (sequence !== editorSequence.current) { setNotice('提交版本已保存，保留你之后输入的草稿；请按最新版本核对。'); return }; drafts.current.delete(frozen.key); setEditor(null); setNotice('已保存设定'); if (frozen.kind === 'episode') updateView({ episodeId: frozen.targetId, shotId: null }) })
  }
  /** 文件只能来自当前已授权项目；主进程再次检查路径、类型和大小。 */
  const importFile = async (): Promise<void> => {
    if (!document || !importPath.trim() || latest.current.busy) return
    const sequence = editorSequence.current
    latest.current.busy = true
    const target = context; const epoch = scope.current.capture()
    setBusy(true); setError('')
    try {
      const media = await window.electronAPI.visualProduction.invoke('importFile', { sessionId, productionId: document.id, relativePath: importPath.trim() })
      if (currentContext.current !== target || !scope.current.accepts(epoch)) return
      setSnapshot(previous => previous ? { ...previous, media: [...previous.media.filter(item => item.id !== media.id), media] } : previous)
      if (sequence === editorSequence.current) setImportPath(''); setNotice(`已导入 ${media.name}，请在素材选择中绑定后保存。`)
    } catch (cause) { if (currentContext.current === target && scope.current.accepts(epoch)) setError(String(cause)) }
    finally { if (currentContext.current === target && scope.current.accepts(epoch)) { latest.current.busy = false; setBusy(false) } }
  }
  /** 下载只包含真实存储的清单或媒体，不冒充视频合成。 */
  const download = (blob: Blob, fileName: string): void => {
    const url = URL.createObjectURL(blob)
    const anchor = window.document.createElement('a')
    anchor.href = url; anchor.download = fileName; anchor.click()
    window.setTimeout(() => URL.revokeObjectURL(url), 1000)
  }
  const exportManifest = async (): Promise<void> => {
    if (!document) return
    setError('')
    const target = context; const epoch = scope.current.capture()
    try { const result = await window.electronAPI.visualProduction.invoke('exportManifest', { sessionId, productionId: document.id }); if (target === currentContext.current && scope.current.accepts(epoch)) download(new Blob([result.json], { type: 'application/json' }), visualDeliveryFileName(`${document.title}-制作清单`, 'application/json')) }
    catch (cause) { if (target === currentContext.current && scope.current.accepts(epoch)) setError(String(cause)) }
  }
  /** 使用来源名称命名下载副本，原素材身份与持久化文件名保持稳定。 */
  const exportMedia = async (mediaId: string, name: string): Promise<void> => {
    if (!document) return
    setError('')
    const target = context; const epoch = scope.current.capture()
    try { const result = await window.electronAPI.visualProduction.invoke('mediaContent', { sessionId, productionId: document.id, mediaId }); if (target === currentContext.current && scope.current.accepts(epoch)) download(new Blob([new Uint8Array(result.bytes)], { type: result.mime }), visualDeliveryFileName(name, result.mime)) }
    catch (cause) { if (target === currentContext.current && scope.current.accepts(epoch)) setError(String(cause)) }
  }
  const editShot = editor?.draft.shots.find(item => item.id === editor.targetId)
  const editAsset = editor?.draft.assets.find(item => item.id === editor.targetId)
  const editEpisode = editor?.draft.episodes.find(item => item.id === editor.targetId)
  /** 首尾帧只能从当前镜头已引用且具有图片媒体的资产中选择。 */
  const editShotImageAssets = editor && editShot ? editor.draft.assets.filter(asset => editShot.assetIds.includes(asset.id) && snapshot?.media.some(item => item.id === asset.mediaId && item.kind === 'image')) : []
  /**
   * 更新当前镜头视频计划；模式切换时清理不适用的首尾帧槽。
   * @param patch 本次生成方式、帧身份、转场或依据变更。
   */
  const updateShotVideoPlan = (patch: Partial<VisualShotVideoPlan>): void => {
    if (!editor || editor.kind !== 'shot') return
    changeEditor(draft => {
      /** 当前草稿镜头只按稳定身份定位，避免受列表顺序变化影响。 */
      const target = draft.shots.find(item => item.id === editor.targetId)!
      /** 首次设置时采用已明显义，后续切换保留用户已经填写的依据。 */
      const previous = target.videoPlan ?? { mode: 'image-to-video' as const, firstFrameAssetId: null, lastFrameAssetId: null, transitionIn: 'hard-cut' as const, rationale: '' }
      const next = { ...previous, ...patch }
      if (next.mode === 'text-to-video') next.firstFrameAssetId = null
      if (next.mode !== 'first-last-frame') next.lastFrameAssetId = null
      target.videoPlan = next
    })
  }
  /**
   * 更新当前镜头的分镜衔接合同；未创建时从空状态建立，便于表单逐项填写。
   * @param patch 本次入场、出场、中间锚点、声音接续或依据变更。
   */
  const updateShotContinuityPlan = (patch: Partial<VisualShotContinuityPlan>): void => {
    if (!editor || editor.kind !== 'shot') return
    changeEditor(draft => {
      const target = draft.shots.find(item => item.id === editor.targetId)!
      const previous = target.continuityPlan ?? {
        entryState: '',
        exitState: '',
        anchors: [],
        audioTransition: 'hard-cut' as const,
        rationale: '',
      }
      target.continuityPlan = { ...previous, ...patch }
    })
  }
  return <div className="vp-workspace" data-testid="visual-production-workspace">
    <header className="vp-top">
      <Button variant="ghost" size="icon" aria-label="影像项目目录" onClick={() => setDirectory(!directory)}>
        <FolderOpen size={17} />
      </Button>
      <Film size={17} />
      <strong>{document?.title ?? '影像创作'}</strong>{document && <span className="vp-badge">v{document.revision}</span>}
      {document && snapshot && <VisualProductionRecords key={context} sessionId={sessionId} snapshot={snapshot} paneActive={paneActive} busy={busy} error={error}
        previewRequest={candidatePreview}
        onOpenChange={open => { setRecordsOpen(open); if (open) setPlaying(false) }}
        onAdopt={candidateId => void mutate(() => window.electronAPI.visualProduction.invoke('adopt', { sessionId, productionId: document.id, baseRevision: document.revision, candidateId }))}
        onDiscard={candidateId => void mutate(() => window.electronAPI.visualProduction.invoke('discardCandidate', { sessionId, productionId: document.id, candidateId }))}
        onCancel={jobId => void mutate(() => window.electronAPI.visualProduction.invoke('cancelJob', { sessionId, productionId: document.id, jobId }))}
        onRetry={job => {
          /** 点击时用最新正式版本构造重试要求，不恢复旧任务或自动发送。 */
          const message = buildVisualRetryPrompt(document, job)
          if (message) { reference(job.shotId); setPrompt({ sessionId, message, autoSend: false, appendToDraft: true }); setNotice('已将重试要求引用到 Agent，请核对后发送。') }
        }}
        onReview={candidate => {
          /** 审片要求绑定具体候选版本和相邻镜头范围，同样只引用到输入框。 */
          const job = snapshot.jobs.find(item => item.id === candidate.jobId)
          const message = job ? buildVisualCandidateReviewPrompt(document, candidate, job) : null
          if (message) { reference(job?.shotId); setPrompt({ sessionId, message, autoSend: false, appendToDraft: true }); setNotice('已将视频审片要求引用到 Agent，请核对后发送。') }
        }} />}
      <Button variant="ghost" size="icon" aria-label="刷新作品" disabled={busy} onClick={() => { void refreshList(); void load(true) }}>
        <RefreshCw size={15} />
      </Button>
    </header>
    {directory && <>
      <button className="vp-overlay" aria-label="关闭项目目录" onClick={() => setDirectory(false)} />
      <aside className="vp-directory">
        <div className="vp-row">
          <strong>当前 Agent 项目的作品</strong>
          <Button variant="ghost" size="icon" aria-label="关闭目录" onClick={() => setDirectory(false)}>
            <X size={15} />
          </Button>
        </div>
        <Input aria-label="搜索作品" placeholder="搜索影像项目" value={search} onChange={event => setSearch(event.target.value)} />{summaries.filter(item => item.title.toLowerCase().includes(search.toLowerCase())).map(item => <Button key={item.id} variant={item.id === view.productionId ? 'secondary' : 'ghost'} onClick={() => { updateView({ productionId: item.id, episodeId: null, shotId: null }); setDirectory(false) }}>{item.title}<span className="vp-muted">{KIND_LABELS[item.kind]}</span>
        </Button>)}<Button variant="outline" onClick={() => { setCreate(true); setDirectory(false) }}>
          <Plus size={14} />新建影像项目</Button>
      </aside>
    </>}
    {error && <div className="vp-error" role="alert">
      <span>{error}</span>
      <Button variant="ghost" size="sm" onClick={() => { setError(''); void load() }}>重新读取</Button>
    </div>}
    {notice && <div className="vp-toolbar vp-muted" role="status">
      <span>{notice}</span>
      <Button variant="ghost" size="icon" aria-label="关闭提示" onClick={() => setNotice('')}>
        <X size={12} />
      </Button>
    </div>}
    {document && <nav className="vp-tabs">{([['project', '项目'], ['assets', '资产'], ['script', '脚本'], ['shots', document.kind === 'image' ? '图片' : '分镜'], ['relations', '画布'], ['editing', '剪辑成片'], ['delivery', '素材导出'], ['configuration', '制作配置']] as const).map(([tab, label]) => <Button key={tab} size="sm" variant="ghost" aria-current={view.tab === tab ? 'page' : undefined} onClick={() => updateView({ tab })}>{label}</Button>)}</nav>}
    <main className={`vp-body${view.tab === 'relations' && document ? ' vp-body-relations' : ''}${view.tab === 'shots' && document?.kind !== 'image' ? ' vp-body-shots' : ''}`}>
      {!document ? <div className="vp-empty">
        <Film size={32} />
        <h3>{loading ? '读取影像项目…' : '开始你的第一部作品'}</h3>
        <p className="vp-muted">在当前 Agent 项目中管理漫剧、影片、宣传片和图片。</p>
        <Button onClick={() => setCreate(true)}>新建影像项目</Button>
      </div> : <>
        {snapshot && <VisualProductionMediaConfigurationPanel key={context} sessionId={sessionId} productionId={document.id} configuration={snapshot.mediaConfiguration} active={paneActive && view.tab === 'configuration'} busy={busy} onSave={(configuration, onSaved) => { void mutate(() => window.electronAPI.visualProduction.invoke('saveMediaConfiguration', { sessionId, productionId: document.id, expectedRevision: configuration.revision, entries: configuration.entries, defaults: configuration.defaults }), () => { onSaved(); setNotice('已保存制作配置，新任务将使用此配置。') }) }} />}
        {view.tab === 'project' && <div className="vp-section">
          <section className="vp-card">
            <div className="vp-row">
              <strong>作品目标</strong>
              <Button variant="outline" size="sm" onClick={() => openEditor('project', document.id)}>
                <Settings2 size={14} />编辑设定</Button>
            </div>
            <p className="vp-summary mt-3">{document.brief || '尚未填写目标，可以在设定中编辑，或引用到 Agent 对话完善。'}</p>
            <div className="vp-row mt-4">
              <span className="vp-badge">{KIND_LABELS[document.kind]}</span>
              <span className="vp-badge">{document.ratio}</span>{document.kind !== 'image' && <span className="vp-badge">{document.fps} fps</span>}</div>
            <p className="vp-muted mt-3">声音：{document.voice || '未设置'} · 配乐：{document.music || '未设置'}</p>
            <Button variant="ghost" size="sm" className="mt-3" onClick={() => reference()}>引用到 Agent</Button>
          </section>
          <section className="vp-card">
            <div className="vp-row">
              <strong>{document.kind === 'image' ? '图片分组' : '集数'}</strong>
              <Button variant="outline" size="sm" onClick={() => openEditor('episode')}>
                <Plus size={14} />新增</Button>
            </div>{document.episodes.map(item => <div className="vp-row mt-3" key={item.id}>
              <Button variant="ghost" onClick={() => { updateView({ episodeId: item.id, shotId: null, tab: 'shots' }) }}>{item.title}</Button>
              <span className="vp-muted">{document.shots.filter(value => value.episodeId === item.id).length} 个镜头</span>
              <Button variant="ghost" size="sm" onClick={() => openEditor('episode', item.id)}>重命名</Button>
            </div>)}{!document.episodes.length && <p className="vp-muted mt-3">先新增集数，再安排镜头。</p>}</section>
        </div>}
        {view.tab === 'assets' && <div className="vp-section">
          <div className="flex min-w-0 items-center gap-2">
            <Input className="min-w-0 flex-1" aria-label="搜索资产" placeholder="搜索资产名称或说明" value={assetSearch} onChange={event => setAssetSearch(event.target.value)} />
            <Button className="shrink-0" variant="outline" onClick={() => openEditor('asset')}>
              <Plus size={14} />新增资产</Button>
          </div>
          <div className="vp-row">{['全部', ...ASSET_TYPES].map(type => <Button size="sm" key={type} variant={assetType === type ? 'secondary' : 'ghost'} onClick={() => setAssetType(type)}>{type}</Button>)}</div>
          <div className="vp-grid">{document.assets.filter(item => (assetType === '全部' || item.type === assetType) && `${item.name} ${item.description}`.toLowerCase().includes(assetSearch.toLowerCase())).map(item => <button className="vp-card vp-asset-card" key={item.id} onClick={() => openAsset(item.id)}>
            <VisualMediaView active={paneActive} sessionId={sessionId} productionId={document.id} media={snapshot?.media.find(media => media.id === item.mediaId)} />
            <strong>{item.name}</strong>
            <span className="vp-muted">{item.type} · {item.locked ? '已锁定' : '可编辑'}</span>
          </button>)}</div>{!document.assets.length && <p className="vp-muted">新增角色、场景或产品资产，镜头引用后可查看关联影响。</p>}</div>}
        {view.tab === 'script' && episodeId && snapshot && <VisualScriptWorkspace
          key={`script:${context}:${episodeId}:${document.revision}`}
          document={document}
          snapshot={snapshot}
          episodeId={episodeId}
          active={paneActive}
          busy={busy}
          onEpisodeChange={value => updateView({ episodeId: value, shotId: null })}
          onOpenShot={shotId => updateView({ tab: 'shots', episodeId, shotId })}
          onReference={() => reference()}
          onGenerate={() => {
            const message = buildVisualScriptPrompt(document, episodeId)
            if (!message) return
            reference()
            setPrompt({ sessionId, message, autoSend: false, appendToDraft: true })
            setNotice('已将整集剧本整理要求引用到 Agent，请核对后发送。')
          }}
          onSave={script => {
            const draft = copyVisualDraft(document)
            const target = draft.episodes.find(item => item.id === episodeId)
            if (!target) return
            target.script = structuredClone(script)
            void mutate(
              () => window.electronAPI.visualProduction.invoke('save', { sessionId, productionId: document.id, baseRevision: document.revision, draft }),
              () => setNotice('已保存结构化剧本。分镜与媒体未改动。'),
            )
          }}
        />}
        {view.tab === 'script' && !episodeId && <div className="vp-empty"><ScrollText size={30} /><h3>先新增一集</h3><p className="vp-muted">剧本按集组织，创建集数后才能建立整集叙事。</p></div>}
        {view.tab === 'shots' && <div className="vp-section vp-shot-page" aria-label="分镜工作台">
          <div className="vp-shot-page-toolbar flex min-w-0 items-center gap-2">
            <Select value={episodeId ?? ''} disabled={!document.episodes.length} onValueChange={value => updateView({ episodeId: value, shotId: null })}>
              <SelectTrigger aria-label="当前集数" className="h-8 min-w-0 max-w-72 flex-1 gap-2 text-xs [&>span]:min-w-0 [&>svg]:shrink-0"><SelectValue placeholder="尚无集数" /></SelectTrigger>
              <SelectContent>{document.episodes.map(item => <SelectItem key={item.id} value={item.id}>{item.title}</SelectItem>)}</SelectContent>
            </Select>
            <span className="vp-muted shrink-0 whitespace-nowrap">{shots.length} 个{document.kind === 'image' ? '图片' : '镜头'}</span>
            <Button className="ml-auto shrink-0" size="sm" variant="outline" disabled={!episodeId} onClick={() => openEditor('shot')}>
              <Plus size={14} />新增</Button>
          </div>{document.kind === 'image' ? <div className="vp-grid">{shots.map(item => <button className="vp-card" key={item.id} onClick={() => { updateView({ shotId: item.id }); openEditor('shot', item.id) }}>
            <VisualMediaView active={paneActive} sessionId={sessionId} productionId={document.id} media={snapshot?.media.find(media => media.id === item.mediaId)} />
            <p className="mt-2">{item.title}</p>
          </button>)}</div> : <div className="vp-shot-layout">
            <aside className="vp-shot-sidebar" aria-label="镜头序列">
              <div className="vp-shot-sidebar-heading"><div><span className="vp-muted">STORYBOARD</span><strong>镜头序列</strong></div><span className="vp-muted">{String(shots.length).padStart(2, '0')}</span></div>
              <p className="vp-muted">当前集数 · 影片优先</p>
              <div ref={shotStrip} className="vp-strip" role="group" aria-label="分镜序列">{shots.map((item, index) => {
              /** 明确影片状态，只有静帧不能被称为影片已采用。 */
              const slots = shotSlotsById.get(item.id) ?? []
              const image = slots.find(slot => slot.kind === 'image')
              const status = snapshot ? visualShotStatusLabel(snapshot, item) : '未生成'
              return <button key={item.id} className="vp-shot" aria-pressed={shot?.id === item.id} aria-label={`镜头 ${index + 1}，${item.title}，${item.duration} 秒，${status}`} onClick={() => { setPlaying(false); updateView({ shotId: item.id }) }}>
                <div className="vp-shot-preview">
                  {image?.preview ? <VisualMediaView active={paneActive} sessionId={sessionId} productionId={document.id} media={image.preview} /> : <div className="vp-shot-thumbnail-empty"><Film size={20} /></div>}
                  <span className="vp-shot-number" aria-hidden="true">{String(index + 1).padStart(2, '0')}</span>
                  <span className="vp-shot-duration">{item.duration}s</span>
                </div>
                <span className="vp-shot-title" title={item.title}>{item.title}</span>
                <span className="vp-shot-footer"><span className="vp-shot-status">{status}</span>{shot?.id === item.id && <span className="vp-shot-current">当前</span>}</span>
              </button>
              })}</div>
              <p className="vp-shot-sidebar-foot vp-muted">影片、画面、声音独立管理</p>
            </aside>
            <section className="vp-shot-main" aria-label="当前镜头预览">
              {shot && <header className="vp-shot-main-heading"><span className="vp-shot-main-index">{String(shotIndex + 1).padStart(2, '0')}</span><div className="vp-shot-heading-copy"><span className="vp-muted">当前镜头 · {shot.duration} 秒</span><h2>{shot.title}</h2></div><nav className="vp-shot-navigation" aria-label="切换镜头">
              <Button size="icon-sm" variant="ghost" disabled={shotIndex <= 0} aria-label="上一镜头" onClick={() => { setPlaying(false); updateView({ shotId: shots[shotIndex - 1]?.id ?? null }) }}>
                <ChevronLeft size={14} />
              </Button>
              <span>{shotIndex + 1} / {shots.length}</span>
              <Button size="icon-sm" variant="ghost" disabled={shotIndex >= shots.length - 1} aria-label="下一镜头" onClick={() => { setPlaying(false); updateView({ shotId: shots[shotIndex + 1]?.id ?? null }) }}>
                <ChevronRight size={14} />
              </Button>
              </nav></header>}
              {shot && snapshot ? <VisualShotMedia key={`${document.id}:${shot.id}`} sessionId={sessionId} snapshot={snapshot} shot={shot} active={shotMediaActive} playing={playing} onEnded={advance} onError={() => setPlaying(false)} onAudioPlay={() => setPlaying(false)} onPause={() => setPlaying(false)} onEditSound={() => openEditor('sound', shot.id)} onPreviewCandidate={id => { setPlaying(false); setCandidatePreview(previous => ({ id, sequence: (previous?.sequence ?? 0) + 1 })) }} /> : <div className="vp-player-empty">新增镜头，开始安排画面</div>}
              {shot && <div className="vp-shot-main-footer"><span>镜头 {String(shotIndex + 1).padStart(2, '0')} / {shots.length} · 影片、画面分别确认</span><Button size="sm" variant="ghost" disabled={!currentPreviewMedia} onClick={() => setPlaying(!playing)}>{playing ? '停止连续播放' : '连续播放'}</Button><Button size="sm" variant="ghost" onClick={() => reference(shot.id)}>引用到 Agent</Button></div>}
            </section>
            {shot && <aside className="vp-shot-inspector" aria-label="镜头设定">
              <header className="vp-shot-inspector-heading"><div><h3><Settings2 size={15} />镜头设定</h3><span className="vp-muted">制作依据</span></div><Button size="sm" variant="outline" onClick={() => openEditor('shot', shot.id)}>编辑</Button></header>
              <div className="vp-shot-inspector-copy">
                <section className="vp-shot-inspector-section"><span className="vp-muted">画面描述</span><p>{shot.scene || '尚未填写画面描述'}</p></section>
                <section className="vp-shot-inspector-section"><span className="vp-muted">运镜与表演</span><p>{shot.motion || '尚未设置运镜与表演'}</p></section>
                <section className="vp-shot-inspector-section"><span className="vp-muted">对白</span><blockquote>{shot.dialogue || '尚未设置旁白或对白'}</blockquote></section>
              </div>
              <section className="vp-shot-inspector-output" aria-label="本镜输出"><div className="vp-shot-section-heading"><h4>本镜输出</h4><span className="vp-muted">独立确认</span></div>{shotSlotsById.get(shot.id)?.map(slot => <div className="vp-shot-output-row" key={slot.kind}><span>{slot.kind === 'video' ? '影片' : slot.kind === 'image' ? '画面' : '独立音频'}</span><span className={slot.preview || (slot.kind === 'video' && runningShotJob) ? 'vp-shot-output-ready' : 'vp-muted'}>{slot.preview ? (slot.adopted ? '已采用' : '待采用') : slot.kind === 'video' && runningShotJob ? visualJobActivityLabel(runningShotJob) : '未生成'}</span></div>)}</section>
              <div className="vp-shot-inspector-note"><span aria-hidden="true">i</span><p>影片、画面分别确认。替换其中一项，保留其余输出。</p></div>
              <section className="vp-shot-inspector-assets" aria-label="引用资产"><div className="vp-shot-section-heading"><h4>引用资产</h4><span className="vp-muted">{shot.assetIds.length} 项</span></div><div className="vp-shot-asset-links">{shot.assetIds.map(assetId => { const asset = document.assets.find(item => item.id === assetId); return <Button key={assetId} variant="ghost" size="sm" disabled={!asset} onClick={() => openAsset(assetId)}>{asset?.name ?? '资产不可用'}</Button> })}</div>{!shot.assetIds.length && <p className="vp-muted">尚未引用资产</p>}</section>
              <div className="vp-row vp-shot-detail-footer"><span className="vp-muted mr-auto">调整顺序</span><Button variant="ghost" size="sm" disabled={busy || shotIndex <= 0} onClick={() => { const draft = copyVisualDraft(document); draft.shots = reorderVisualShot(draft.shots, shot.id, -1); void mutate(() => window.electronAPI.visualProduction.invoke('save', { sessionId, productionId: document.id, baseRevision: document.revision, draft })) }}>前移</Button><Button variant="ghost" size="sm" disabled={busy || shotIndex >= shots.length - 1} onClick={() => { const draft = copyVisualDraft(document); draft.shots = reorderVisualShot(draft.shots, shot.id, 1); void mutate(() => window.electronAPI.visualProduction.invoke('save', { sessionId, productionId: document.id, baseRevision: document.revision, draft })) }}>后移</Button></div>
            </aside>}
          </div>}{document.kind === 'image' && shot && snapshot && <div className="vp-card vp-shot-detail-card"><div className="vp-row"><strong>{shot.title}</strong><Button variant="ghost" size="sm" onClick={() => reference(shot.id)}>引用到 Agent</Button><Button variant="outline" size="sm" onClick={() => openEditor('shot', shot.id)}>编辑</Button></div><VisualShotDetails sessionId={sessionId} productionId={document.id} shot={shot} assets={document.assets} media={snapshot.media} state={snapshot.shotStates[shot.id]} active={shotMediaActive} onOpenAsset={openAsset} /></div>}</div>}
        {view.tab === 'relations' && snapshot && <VisualRelationCanvas key={document.id} projectId={projectId} sessionId={sessionId} snapshot={snapshot} active={paneActive && !recordsOpen && !editor && !selectedAsset} onOpenAsset={openAsset} onOpenShots={(targetEpisodeId, targetShotId) => updateView({ tab: 'shots', episodeId: targetEpisodeId, shotId: targetShotId })} />}
        {view.tab === 'editing' && snapshot && <VisualEditingWorkspace key={`editing:${context}:${episodeId ?? ''}`} sessionId={sessionId} productionId={document.id} snapshot={snapshot} episodeId={episodeId ?? null} active={paneActive && view.tab === 'editing'} onEpisodeChange={nextEpisodeId => updateView({ tab: 'editing', episodeId: nextEpisodeId, shotId: null })} />}
        {view.tab === 'delivery' && snapshot && <VisualProductionDelivery key={`delivery:${context}`} sessionId={sessionId} snapshot={snapshot} active={paneActive} onExportManifest={exportManifest} onExportMedia={exportMedia} onOpenAsset={openAsset} onOpenShot={(targetEpisodeId, targetShotId) => updateView({ tab: 'shots', episodeId: targetEpisodeId, shotId: targetShotId })} onOpenShots={() => updateView({ tab: 'shots' })} />}
      </>}
    </main>
    <Dialog open={create} onOpenChange={open => { if (!busy) setCreate(open) }}>
      <DialogContent className="vp-dialog">
        <DialogHeader>
          <DialogTitle>新建影像项目</DialogTitle>
          <DialogDescription>作品归属当前 Agent 项目，资产与镜头独立保存。</DialogDescription>
        </DialogHeader>
        <form className="vp-form" onSubmit={event => { event.preventDefault(); if (busy) return; const target = context; const epoch = scope.current.capture(); setBusy(true); setError(''); void window.electronAPI.visualProduction.invoke('create', { sessionId, title: title.trim(), kind }).then(next => { if (currentContext.current === target && scope.current.accepts(epoch)) { accept(next); updateView({ productionId: next.document.id, episodeId: null, shotId: null, tab: 'project' }); setCreate(false); setTitle('') } }).catch(cause => { if (currentContext.current === target && scope.current.accepts(epoch)) setError(String(cause)) }).finally(() => { if (currentContext.current === target && scope.current.accepts(epoch)) setBusy(false) }) }}>
          <div className="vp-form-body">
            {error && <p role="alert" className="vp-error">{error}</p>}
            <label>作品名称<Input required maxLength={120} disabled={busy} value={title} onChange={event => setTitle(event.target.value)} autoFocus />
            </label>
            <label>作品类型<Select disabled={busy} value={kind} onValueChange={value => setKind(value as VisualProductionKind)}>
              <SelectTrigger aria-label="作品类型"><SelectValue /></SelectTrigger>
              <SelectContent>{Object.entries(KIND_LABELS).map(([value, label]) => <SelectItem value={value} key={value}>{label}</SelectItem>)}</SelectContent>
            </Select>
            </label>
          </div>
          <footer className="vp-form-footer">
            <Button type="button" variant="outline" disabled={busy} onClick={() => setCreate(false)}>取消</Button>
            <Button type="submit" disabled={busy || !title.trim()}>创建作品</Button>
          </footer>
        </form>
      </DialogContent>
    </Dialog>
    <Dialog open={paneActive && (!!editor || !!selectedAsset)} onOpenChange={open => { if (!open) { if (editor) closeEditor(); else setAssetId(null) } }}>
      <DialogContent ref={editorDialog} onOpenAutoFocus={event => { if (showingAssetDetails) { event.preventDefault(); assetHeading.current?.focus() } }} onCloseAutoFocus={event => { event.preventDefault(); if (paneActive && editorOpener.current?.isConnected) editorOpener.current.focus({ preventScroll: true }) }} className={showingAssetDetails ? 'vp-dialog vp-asset-dialog sm:max-w-[900px]' : editor?.kind === 'shot' ? 'vp-dialog sm:max-w-[880px]' : 'vp-dialog sm:max-w-[640px]'}>
        <DialogHeader className="pr-6">
          <DialogTitle ref={assetHeading} tabIndex={-1} className="break-words leading-snug">{showingAssetDetails ? selectedAsset.name : editor?.kind === 'sound' ? '声音设计' : editor?.kind === 'project' ? '作品设定' : editor?.kind === 'shot' ? '镜头设置' : editor?.kind === 'asset' ? '资产设置' : '集数设置'}</DialogTitle>
          <DialogDescription>{showingAssetDetails ? `${selectedAsset.type} · ${selectedAsset.locked ? '已锁定' : '可编辑'}` : editor?.kind === 'sound' ? `${editShot?.title ?? ''} · 关闭保留草稿，保存后更新声音设定。` : '关闭保留本次草稿，保存后更新正式版本。'}</DialogDescription>
        </DialogHeader>
        {showingAssetDetails && document && <>
          <div className="vp-asset-dialog-body">
            {error && <p className="vp-error" role="alert">{error}</p>}
            <VisualMediaView key={`${document.id}:${selectedAsset.id}:${selectedAsset.mediaId}`} sessionId={sessionId} productionId={document.id} media={snapshot?.media.find(item => item.id === selectedAsset.mediaId)} controls className="vp-asset-dialog-preview" />
            <section className="grid gap-2"><h3 className="text-sm font-medium">资产说明</h3><p className="vp-summary text-sm leading-relaxed">{selectedAsset.description || '尚无说明'}</p></section>
            <Collapsible key={selectedAsset.id}>
              <CollapsibleTrigger asChild><Button variant="ghost" size="sm" className="group px-0"><ChevronRight size={14} className="transition-transform group-data-[state=open]:rotate-90" />使用位置（{assetUsages.length}）</Button></CollapsibleTrigger>
              <CollapsibleContent><div className="grid gap-1 pt-2">{assetUsages.map(item => <Button key={item.id} variant="ghost" size="sm" className="h-auto justify-start whitespace-normal text-left" onClick={() => { setAssetId(null); updateView({ tab: 'shots', episodeId: item.episodeId, shotId: item.id }) }}>{document.episodes.find(episode => episode.id === item.episodeId)?.title} / {item.title}</Button>)}{!assetUsages.length && <p className="vp-muted">尚未被镜头引用</p>}</div></CollapsibleContent>
            </Collapsible>
          </div>
          <footer className="vp-form-footer vp-asset-dialog-footer">
            <Button variant="outline" disabled={busy} onClick={() => openEditor('asset', selectedAsset.id)}>编辑资产</Button>
            <Button variant="outline" disabled={busy} onClick={() => { const draft = copyVisualDraft(document); draft.assets.find(item => item.id === selectedAsset.id)!.locked = !selectedAsset.locked; void mutate(() => window.electronAPI.visualProduction.invoke('save', { sessionId, productionId: document.id, baseRevision: document.revision, draft })) }}>{selectedAsset.locked ? '解锁' : '锁定'}</Button>
            <Button variant="ghost" onClick={() => { reference(undefined, selectedAsset.id); setAssetId(null) }}>引用到 Agent</Button>
            <Button variant="outline" className="ml-auto" onClick={() => setAssetId(null)}>关闭</Button>
          </footer>
        </>}
        {editor && <form className="vp-form" onSubmit={saveEditor}>
          <div className="vp-form-body">{document && editor.baseRevision !== document.revision && <div role="alert" className="vp-error">
            <span>作品已更新，当前草稿基于旧版本。可先复制所需内容，或放弃旧草稿并读取最新版本。</span>
            <Button type="button" variant="outline" size="sm" onClick={() => { drafts.current.delete(editor.key); editorSequence.current++; setEditor(null); setNotice('已放弃旧草稿，请重新打开设置读取最新版本。') }}>放弃草稿，读取最新</Button>
          </div>}{error && <p className="vp-error" role="alert">{error}</p>}
            {editor.kind === 'project' && <>
              <label>作品名称<Input required maxLength={120} value={editor.draft.title} onChange={event => changeEditor(draft => { draft.title = event.target.value })} />
              </label>
              <label>作品目标<Textarea rows={4} value={editor.draft.brief} onChange={event => changeEditor(draft => { draft.brief = event.target.value })} />
              </label>
              <div className="vp-grid">
                <label>画面比例<Select value={editor.draft.ratio} onValueChange={value => changeEditor(draft => { draft.ratio = value })}>
                  <SelectTrigger aria-label="画面比例"><SelectValue /></SelectTrigger>
                  <SelectContent>{VISUAL_PRODUCTION_RATIOS.map(value => <SelectItem key={value} value={value}>{value}</SelectItem>)}</SelectContent>
                </Select>
                </label>{editor.draft.kind !== 'image' && <label>帧率<Select value={String(editor.draft.fps)} onValueChange={value => changeEditor(draft => { draft.fps = Number(value) })}>
                  <SelectTrigger aria-label="帧率"><SelectValue /></SelectTrigger>
                  <SelectContent>{[24, 25, 30, 50, 60].map(value => <SelectItem key={value} value={String(value)}>{value}</SelectItem>)}</SelectContent>
                </Select>
                </label>}</div>{editor.draft.kind !== 'image' && <div className="vp-grid">
                  <label>配音要求<Input value={editor.draft.voice} onChange={event => changeEditor(draft => { draft.voice = event.target.value })} />
                  </label>
                  <label>音乐要求<Input value={editor.draft.music} onChange={event => changeEditor(draft => { draft.music = event.target.value })} />
                  </label>
                </div>}</>}
            {editor.kind === 'episode' && editEpisode && <label>集数 / 分组名称<Input required maxLength={120} value={editEpisode.title} onChange={event => changeEditor(draft => { draft.episodes.find(item => item.id === editor.targetId)!.title = event.target.value })} />
            </label>}
            {editor.kind === 'asset' && editAsset && <>
              <label>资产名称<Input required maxLength={120} value={editAsset.name} onChange={event => changeEditor(draft => { draft.assets.find(item => item.id === editor.targetId)!.name = event.target.value })} />
              </label>
              <label>资产类型<Select value={editAsset.type} onValueChange={value => changeEditor(draft => { draft.assets.find(item => item.id === editor.targetId)!.type = value })}>
                <SelectTrigger aria-label="资产类型"><SelectValue /></SelectTrigger>
                <SelectContent>{ASSET_TYPES.map(value => <SelectItem key={value} value={value}>{value}</SelectItem>)}</SelectContent>
              </Select>
              </label>
              <label>描述<Textarea rows={4} value={editAsset.description} onChange={event => changeEditor(draft => { draft.assets.find(item => item.id === editor.targetId)!.description = event.target.value })} />
              </label>
              <label className="vp-check">
                <input type="checkbox" className="vp-themed-checkbox" checked={editAsset.locked} onChange={event => changeEditor(draft => { draft.assets.find(item => item.id === editor.targetId)!.locked = event.target.checked })} />锁定资产，Agent 候选不可修改</label>
            </>}
            {editor.kind === 'sound' && editShot && <>
              <VisualShotSoundFields shot={editShot} onChange={patch => changeEditor(draft => { Object.assign(draft.shots.find(item => item.id === editor.targetId)!, patch) })} />
              <p className="vp-muted">这里保存本镜头的声音制作要求。当前支持一份独立音频的试听与采用。</p>
            </>}
            {editor.kind === 'shot' && editShot && <div className="vp-form-columns">
              <div className="vp-form-fields">
                <label>镜头名称<Input required maxLength={120} value={editShot.title} onChange={event => changeEditor(draft => { draft.shots.find(item => item.id === editor.targetId)!.title = event.target.value })} />
                </label>
                <div className="vp-grid">{editor.draft.kind !== 'image' && <label>时长（秒）<Input type="number" required min={0.1} max={600} step={0.1} value={editShot.duration} onChange={event => changeEditor(draft => { draft.shots.find(item => item.id === editor.targetId)!.duration = Number(event.target.value) })} />
                </label>}<label>运镜<Input value={editShot.motion} onChange={event => changeEditor(draft => { draft.shots.find(item => item.id === editor.targetId)!.motion = event.target.value })} />
                  </label>
                </div>
                {editor.draft.kind !== 'image' && <section className="vp-video-plan-fields" aria-label="视频生成设计">
                  <header><strong>视频生成设计</strong><span className="vp-muted">Agent 按动作连续性和镜头边界确定</span></header>
                  <div className="vp-grid">
                    <label>生成方式<Select value={editShot.videoPlan?.mode ?? NO_VIDEO_PLAN_VALUE} onValueChange={value => {
                      /** 选择未设定时删除可选计划，保持旧镜头兼容。 */
                      if (value === NO_VIDEO_PLAN_VALUE) {
                        changeEditor(draft => { delete draft.shots.find(item => item.id === editor.targetId)!.videoPlan })
                        return
                      }
                      updateShotVideoPlan({ mode: value as VisualShotVideoPlan['mode'] })
                    }}>
                      <SelectTrigger aria-label="视频生成方式"><SelectValue /></SelectTrigger>
                      <SelectContent><SelectItem value={NO_VIDEO_PLAN_VALUE}>未设定</SelectItem><SelectItem value="image-to-video">当前画面驱动</SelectItem><SelectItem value="first-last-frame">首尾帧驱动</SelectItem><SelectItem value="text-to-video">文生视频</SelectItem></SelectContent>
                    </Select></label>
                    <label>入场转场<Select value={editShot.videoPlan?.transitionIn ?? 'hard-cut'} disabled={!editShot.videoPlan} onValueChange={value => updateShotVideoPlan({ transitionIn: value as NonNullable<VisualShotVideoPlan['transitionIn']> })}>
                      <SelectTrigger aria-label="镜头入场转场"><SelectValue /></SelectTrigger>
                      <SelectContent><SelectItem value="hard-cut">硬切</SelectItem><SelectItem value="match-cut">匹配剪辑</SelectItem><SelectItem value="dissolve">叠化</SelectItem></SelectContent>
                    </Select></label>
                  </div>
                  {editShot.videoPlan && editShot.videoPlan.mode !== 'text-to-video' && <label>首帧来源<Select value={editShot.videoPlan.firstFrameAssetId ?? CURRENT_SHOT_IMAGE_VALUE} onValueChange={value => updateShotVideoPlan({ firstFrameAssetId: value === CURRENT_SHOT_IMAGE_VALUE ? null : value })}>
                    <SelectTrigger aria-label="首帧来源"><SelectValue /></SelectTrigger>
                    <SelectContent><SelectItem value={CURRENT_SHOT_IMAGE_VALUE}>当前已采用画面</SelectItem>{editShotImageAssets.map(asset => <SelectItem key={asset.id} value={asset.id}>{asset.name}</SelectItem>)}</SelectContent>
                  </Select></label>}
                  {editShot.videoPlan?.mode === 'first-last-frame' && <label>尾帧来源<Select value={editShot.videoPlan.lastFrameAssetId ?? ''} onValueChange={value => updateShotVideoPlan({ lastFrameAssetId: value || null })}>
                    <SelectTrigger aria-label="尾帧来源"><SelectValue placeholder="选择已引用图片资产" /></SelectTrigger>
                    <SelectContent>{editShotImageAssets.map(asset => <SelectItem key={asset.id} value={asset.id}>{asset.name}</SelectItem>)}</SelectContent>
                  </Select></label>}
                  {editShot.videoPlan && <label>判断依据<Textarea rows={2} maxLength={2000} value={editShot.videoPlan.rationale} placeholder="说明为什么采用该生成方式和转场" onChange={event => updateShotVideoPlan({ rationale: event.target.value })} /></label>}
                  <p className="vp-muted">硬切、匹配剪辑与叠化在剪辑中完成；首尾帧只约束生成画面，不能证明中间动作正确。</p>
                </section>}
                {editor.draft.kind !== 'image' && <section className="vp-continuity-plan-fields" aria-label="分镜衔接设计">
                  <header>
                    <div><strong>分镜衔接</strong><span className="vp-muted">入场事实 · 出场交付 · 中间锚点 · 声音接续</span></div>
                    {editShot.continuityPlan && <Button type="button" variant="ghost" size="sm" onClick={() => changeEditor(draft => { delete draft.shots.find(item => item.id === editor.targetId)!.continuityPlan })}>清除</Button>}
                  </header>
                  <div className="vp-grid">
                    <label>入场状态<Textarea rows={3} maxLength={4000} value={editShot.continuityPlan?.entryState ?? ''} placeholder="本镜开始时从上一镜继承的人物、道具、空间、光线或界面状态" onChange={event => updateShotContinuityPlan({ entryState: event.target.value })} /></label>
                    <label>出场状态<Textarea rows={3} maxLength={4000} value={editShot.continuityPlan?.exitState ?? ''} placeholder="本镜结束时必须稳定交给下一镜的状态" onChange={event => updateShotContinuityPlan({ exitState: event.target.value })} /></label>
                  </div>
                  <label>声音接续<Select value={editShot.continuityPlan?.audioTransition ?? 'hard-cut'} onValueChange={value => updateShotContinuityPlan({ audioTransition: value as VisualShotContinuityPlan['audioTransition'] })}>
                    <SelectTrigger aria-label="声音接续方式"><SelectValue /></SelectTrigger>
                    <SelectContent>{Object.entries(AUDIO_TRANSITION_LABELS).map(([value, label]) => <SelectItem key={value} value={value}>{label}</SelectItem>)}</SelectContent>
                  </Select></label>
                  <div className="vp-continuity-anchors">
                    <div className="vp-row"><strong>动作中间锚点</strong><span className="vp-muted">{editShot.continuityPlan?.anchors.length ?? 0} / 12</span></div>
                    {(editShot.continuityPlan?.anchors ?? []).map((anchor, index) => <div className="vp-continuity-anchor" key={`${index}:${anchor.phase}`}>
                      <label>动作相位<Select value={anchor.phase} onValueChange={value => updateShotContinuityPlan({ anchors: editShot.continuityPlan!.anchors.map((item, itemIndex) => itemIndex === index ? { ...item, phase: value as VisualShotActionPhase } : item) })}>
                        <SelectTrigger aria-label={`第 ${index + 1} 个动作锚点相位`}><SelectValue /></SelectTrigger>
                        <SelectContent>{Object.entries(ACTION_PHASE_LABELS).map(([value, label]) => <SelectItem key={value} value={value} disabled={editShot.continuityPlan?.anchors.some((candidate, candidateIndex) => candidateIndex !== index && candidate.phase === value)}>{label}</SelectItem>)}</SelectContent>
                      </Select></label>
                      <label>可读状态<Input maxLength={2000} value={anchor.state} placeholder="该相位必须清楚呈现的事实" onChange={event => updateShotContinuityPlan({ anchors: editShot.continuityPlan!.anchors.map((item, itemIndex) => itemIndex === index ? { ...item, state: event.target.value } : item) })} /></label>
                      <label>画面锚点<Select value={anchor.assetId ?? NO_CONTINUITY_ANCHOR_VALUE} onValueChange={value => updateShotContinuityPlan({ anchors: editShot.continuityPlan!.anchors.map((item, itemIndex) => itemIndex === index ? { ...item, assetId: value === NO_CONTINUITY_ANCHOR_VALUE ? null : value } : item) })}>
                        <SelectTrigger aria-label={`第 ${index + 1} 个动作锚点画面`}><SelectValue placeholder="无正式画面" /></SelectTrigger>
                        <SelectContent><SelectItem value={NO_CONTINUITY_ANCHOR_VALUE}>无正式画面</SelectItem>{editShotImageAssets.map(asset => <SelectItem key={asset.id} value={asset.id} disabled={editShot.continuityPlan?.anchors.some((candidate, candidateIndex) => candidateIndex !== index && candidate.assetId === asset.id)}>{asset.name}</SelectItem>)}</SelectContent>
                      </Select></label>
                      <Button type="button" variant="ghost" size="sm" aria-label={`移除第 ${index + 1} 个动作锚点`} onClick={() => updateShotContinuityPlan({ anchors: editShot.continuityPlan!.anchors.filter((_, itemIndex) => itemIndex !== index) })}>移除</Button>
                    </div>)}
                    <Button type="button" variant="outline" size="sm" disabled={(editShot.continuityPlan?.anchors.length ?? 0) >= 12} onClick={() => {
                      /** 新锚点自动选择尚未使用的首个相位，仍允许随后人工调整。 */
                      const used = new Set(editShot.continuityPlan?.anchors.map(item => item.phase) ?? [])
                      const phase = (Object.keys(ACTION_PHASE_LABELS) as VisualShotActionPhase[]).find(value => !used.has(value))
                      if (phase) updateShotContinuityPlan({ anchors: [...(editShot.continuityPlan?.anchors ?? []), { phase, state: '', assetId: null }] })
                    }}>添加动作锚点</Button>
                  </div>
                  <label>衔接依据<Textarea rows={2} maxLength={2000} value={editShot.continuityPlan?.rationale ?? ''} placeholder="说明哪些动作必须连续、哪些元素允许省略，以及声音为何这样接" onChange={event => updateShotContinuityPlan({ rationale: event.target.value })} /></label>
                  <p className="vp-muted">单镜头视频生成前必须填写入场、出场和依据。已选图片锚点会作为真实参考输入，所用工作流必须支持相应参考数量。</p>
                </section>}
                <label>画面描述<Textarea rows={4} value={editShot.scene} onChange={event => changeEditor(draft => { draft.shots.find(item => item.id === editor.targetId)!.scene = event.target.value })} />
                </label>
                <VisualShotSoundFields shot={editShot} includeSound={editor.draft.kind !== 'image'} onChange={patch => changeEditor(draft => { Object.assign(draft.shots.find(item => item.id === editor.targetId)!, patch) })} />
              </div>
              <aside className="vp-form-fields vp-asset-references">
                <strong>引用资产</strong>{editor.draft.assets.map(item => <VisualAssetReference key={`${editor.key}:${item.id}`} sessionId={sessionId} productionId={editor.productionId} asset={item} media={snapshot?.media.find(media => media.id === item.mediaId)} active={paneActive} checked={editShot.assetIds.includes(item.id)} onCheckedChange={checked => changeEditor(draft => {
                  /** 只更新当前镜头的引用集合，预览不修改资产或触发生成。 */
                  const target = draft.shots.find(value => value.id === editor.targetId)!
                  target.assetIds = checked ? [...target.assetIds, item.id] : target.assetIds.filter(id => id !== item.id)
                })} />)}{!editor.draft.assets.length && <p className="vp-muted">先在资产库添加素材。</p>}<p className="vp-muted">设定修订 {snapshot?.shotStates[editShot.id]?.revision ?? 0} · 画面版本 {snapshot?.shotStates[editShot.id]?.outputVersion ?? 0}</p>
              </aside>
            </div>}
            {(editor.kind === 'asset' || editor.kind === 'shot') && <>
              {editor.kind === 'asset' && editAsset && <label>采用素材<Select value={editAsset.mediaId ?? NO_MEDIA_VALUE} onValueChange={value => changeEditor(draft => { draft.assets.find(item => item.id === editor.targetId)!.mediaId = value === NO_MEDIA_VALUE ? null : value })}>
                <SelectTrigger aria-label="采用素材"><SelectValue /></SelectTrigger>
                <SelectContent><SelectItem value={NO_MEDIA_VALUE}>暂无素材</SelectItem>{snapshot?.media.filter(item => editAsset.type === '声音' ? item.kind === 'audio' : item.kind !== 'audio').map(item => <SelectItem key={item.id} value={item.id}>{item.name}</SelectItem>)}</SelectContent>
              </Select></label>}
              {editor.kind === 'shot' && editShot && <div className="vp-shot-output-selects">{SHOT_MEDIA_KINDS.filter(kind => editor.draft.kind !== 'image' || kind === 'image').map(kind => <label key={kind}>采用{SHOT_MEDIA_LABELS[kind]}<Select value={resolveVisualShotOutputs(editShot, mediaById)[kind] ?? NO_MEDIA_VALUE} onValueChange={value => changeEditor(draft => {
                /** 只替换选中的输出槽，并同步旧版使用的主视觉身份。 */
                draft.shots = draft.shots.map(item => item.id === editor.targetId ? withVisualShotOutput(item, kind, value === NO_MEDIA_VALUE ? null : value, mediaById) : item)
              })}>
                <SelectTrigger aria-label={`采用${SHOT_MEDIA_LABELS[kind]}`}><SelectValue /></SelectTrigger>
                <SelectContent><SelectItem value={NO_MEDIA_VALUE}>尚未采用{SHOT_MEDIA_LABELS[kind]}</SelectItem>{snapshot?.media.filter(item => item.kind === kind).map(item => <SelectItem key={item.id} value={item.id}>{item.name}</SelectItem>)}</SelectContent>
              </Select></label>)}</div>}
              <Collapsible>
                <CollapsibleTrigger asChild><Button type="button" variant="ghost" size="sm" className="group justify-start px-0"><ChevronRight size={14} className="transition-transform group-data-[state=open]:rotate-90" />从当前项目导入媒体</Button></CollapsibleTrigger>
                <CollapsibleContent>
                <div className="vp-row mt-2">
                  <Input aria-label="项目内媒体相对路径" placeholder="例如 assets/shot-01.mp4" value={importPath} onChange={event => setImportPath(event.target.value)} />
                  <Button type="button" variant="outline" disabled={busy || !importPath.trim()} onClick={() => void importFile()}>导入</Button>
                </div>
                <p className="vp-muted mt-2">也可让 Agent 使用现有媒体工具生成后提交候选。</p>
                </CollapsibleContent>
              </Collapsible>
            </>}
          </div>
          <footer className="vp-form-footer">
            <Button type="button" variant="outline" onClick={closeEditor}>{selectedAsset ? '返回详情' : '关闭'}</Button>
            <Button type="submit" disabled={busy || editor.baseRevision !== document?.revision}>{editor.kind === 'sound' ? '保存声音设计' : '保存设置'}</Button>
          </footer>
        </form>}</DialogContent>
    </Dialog>
  </div>
}
