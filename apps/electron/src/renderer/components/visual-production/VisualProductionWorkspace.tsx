import * as React from 'react'
import { useAtom, useSetAtom } from 'jotai'
import { ChevronLeft, ChevronRight, Download, Film, FolderOpen, Plus, RefreshCw, Settings2, X } from 'lucide-react'
import { VISUAL_PRODUCTION_RATIOS } from '@proma/shared'
import type { VisualProductionDraft, VisualProductionKind, VisualProductionSnapshot, VisualProductionSummary, VisualCandidate } from '@proma/shared'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { agentPendingPromptAtom } from '@/atoms/agent-atoms'
import { visualProductionViewsAtom, type VisualProductionView } from '@/atoms/visual-production-atoms'
import { buildVisualPrompt, copyVisualDraft, reorderVisualShot, VisualRequestGate, VisualScopeEpoch } from './model'
import { VisualMediaView } from './VisualMediaView'
import './visual-production.css'

/** 编辑器冻结作品与版本；后台刷新仅更新正式数据，不覆盖输入草稿。 */
interface VisualEditor { key: string; kind: 'project' | 'asset' | 'shot' | 'episode'; targetId: string; productionId: string; baseRevision: number; draft: VisualProductionDraft }
/** 没有业务数据时采用空视图，不种入演示作品。 */
const EMPTY_VIEW: VisualProductionView = { productionId: null, episodeId: null, shotId: null, tab: 'project' }
/** 资产类型使用内容角色分类，媒体格式单独显示。 */
const ASSET_TYPES = ['角色', '场景', '产品', '道具', '风格', '品牌', '声音']
/** 作品类型名称用于目录与新建表单。 */
const KIND_LABELS: Record<VisualProductionKind, string> = { comic: '漫剧', film: '影片', promo: '宣传片', image: '图片' }

/** 独立影像制作工作台，所有 Agent 请求统一引用到主会话。 */
export function VisualProductionWorkspace({ projectId, sessionId, paneActive = true }: { projectId: string; sessionId: string; paneActive?: boolean }): React.ReactElement {
  const [views, setViews] = useAtom(visualProductionViewsAtom)
  const view = views[projectId] ?? EMPTY_VIEW
  const setPrompt = useSetAtom(agentPendingPromptAtom)
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
  /** 等待实际媒体加载后再计时，避免读取耗时吞掉预演。 */
  const [mediaReady, setMediaReady] = React.useState('')
  const [candidateId, setCandidateId] = React.useState<string | null>(null)
  /** 关闭弹窗保留本会话内草稿，每个作品/对象独立保存。 */
  const drafts = React.useRef(new Map<string, VisualEditor>())
  /** 弹窗关闭后还原入口焦点，便于键盘连续编辑。 */
  const editorOpener = React.useRef<HTMLElement | null>(null)
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
  const candidate = snapshot?.candidates.find(item => item.id === candidateId)
  const currentMedia = snapshot?.media.find(item => item.id === shot?.mediaId)
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
  const load = React.useCallback(async (): Promise<void> => {
    if (!view.productionId || latest.current.busy) return
    const ticket = gate.current.next()
    const target = currentContext.current; const epoch = scope.current.capture()
    setLoading(true)
    try {
      const next = await window.electronAPI.visualProduction.invoke('load', { sessionId, productionId: view.productionId })
      if (gate.current.accepts(ticket) && currentContext.current === target && scope.current.accepts(epoch)) accept(next)
    } catch (cause) { if (gate.current.accepts(ticket) && currentContext.current === target && scope.current.accepts(epoch)) setError(String(cause)) }
    finally { if (gate.current.accepts(ticket) && currentContext.current === target && scope.current.accepts(epoch)) setLoading(false) }
  }, [sessionId, view.productionId, accept])
  React.useEffect(() => () => scope.current.invalidate(), [])
  React.useEffect(() => { void refreshList(); return () => { listGate.current.next() } }, [refreshList])
  React.useEffect(() => {
    latest.current.busy = false; editorSequence.current++
    setSnapshot(null); setEditor(null); setCreate(false); setCandidateId(null); setAssetId(null); setError(''); setNotice(''); setBusy(false); setPlaying(false); setImportPath('')
    void load()
    return () => { gate.current.next() }
  }, [context, load])
  React.useEffect(() => window.electronAPI.visualProduction.onChanged(event => {
    if (event.workspaceId !== projectId) return
    void refreshList()
    if ((!event.productionId || event.productionId === view.productionId) && !latest.current.busy) void load()
  }), [projectId, view.productionId, refreshList, load])
  React.useEffect(() => { if (!paneActive) setPlaying(false) }, [paneActive])
  React.useEffect(() => {
    if (!directory) return
    const close = (event: KeyboardEvent): void => { if (event.key === 'Escape') setDirectory(false) }
    window.addEventListener('keydown', close)
    return () => window.removeEventListener('keydown', close)
  }, [directory])
  React.useEffect(() => { setPlaying(false) }, [episodeId, view.tab, editor, candidateId])
  React.useEffect(() => {
    const hide = (): void => { if (window.document.hidden) setPlaying(false) }
    window.document.addEventListener('visibilitychange', hide)
    return () => window.document.removeEventListener('visibilitychange', hide)
  }, [])
  /** 镜头切换按正式排序进行，末镜头播完停止。 */
  const advance = React.useCallback((): void => {
    if (shots[shotIndex + 1]) updateView({ shotId: shots[shotIndex + 1]!.id })
    else setPlaying(false)
  }, [shots, shotIndex, updateView])
  React.useEffect(() => {
    if (!playing || !paneActive || !shot || mediaReady !== `${shot.id}:${shot.mediaId}`) return
    const timer = window.setTimeout(advance, Math.max(0.1, shot.duration) * 1000)
    return () => window.clearTimeout(timer)
  }, [playing, paneActive, shot?.id, shot?.duration, currentMedia?.kind, advance, mediaReady])
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
    setPrompt({ sessionId, message: buildVisualPrompt(document, targetShot, targetAsset), autoSend: false })
    setNotice('已引用到旁边 Agent 对话，请补充制作要求。')
  }
  const openEditor = (editorKind: VisualEditor['kind'], targetId?: string): void => {
    if (!document) return
    editorSequence.current++
    editorOpener.current = window.document.activeElement instanceof HTMLElement ? window.document.activeElement : null
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
    const target = context; const epoch = scope.current.capture()
    try { const result = await window.electronAPI.visualProduction.invoke('exportManifest', { sessionId, productionId: document.id }); if (target === currentContext.current && scope.current.accepts(epoch)) download(new Blob([result.json], { type: 'application/json' }), result.fileName) }
    catch (cause) { if (target === currentContext.current && scope.current.accepts(epoch)) setError(String(cause)) }
  }
  const exportMedia = async (mediaId: string): Promise<void> => {
    if (!document) return
    const target = context; const epoch = scope.current.capture()
    try { const result = await window.electronAPI.visualProduction.invoke('mediaContent', { sessionId, productionId: document.id, mediaId }); if (target === currentContext.current && scope.current.accepts(epoch)) download(new Blob([new Uint8Array(result.bytes)], { type: result.mime }), snapshot?.media.find(item => item.id === mediaId)?.name ?? mediaId) }
    catch (cause) { if (target === currentContext.current && scope.current.accepts(epoch)) setError(String(cause)) }
  }
  const editShot = editor?.draft.shots.find(item => item.id === editor.targetId)
  const editAsset = editor?.draft.assets.find(item => item.id === editor.targetId)
  const editEpisode = editor?.draft.episodes.find(item => item.id === editor.targetId)
  /** 候选预览只使用其草稿，不改变正式播放器或已采用画面。 */
  const renderCandidate = (item: VisualCandidate): React.ReactElement => <div className="vp-card vp-candidate" key={item.id}>
    <div className="vp-row">
      <strong>{item.summary || '制作候选'}</strong>
      <span className="vp-badge">{item.status === 'ready' ? '待采用' : item.status === 'stale' ? '已过期' : item.status === 'adopted' ? '已采用' : '已丢弃'}</span>
    </div>
    <span className="vp-muted">基于版本 {item.baseRevision} · {item.draft.shots.length} 个镜头</span>
    <div className="vp-row">
      <Button variant="outline" size="sm" onClick={() => setCandidateId(item.id)}>预览</Button>{item.status === 'ready' && <Button size="sm" disabled={busy || item.baseRevision !== document?.revision} onClick={() => { if (document) void mutate(() => window.electronAPI.visualProduction.invoke('adopt', { sessionId, productionId: document.id, baseRevision: document.revision, candidateId: item.id })) }}>采用候选</Button>}{(item.status === 'ready' || item.status === 'stale') && <Button variant="ghost" size="sm" disabled={busy} onClick={() => { if (document) void mutate(() => window.electronAPI.visualProduction.invoke('discardCandidate', { sessionId, productionId: document.id, candidateId: item.id })) }}>丢弃</Button>}</div>
  </div>
  return <div className="vp-workspace" data-testid="visual-production-workspace">
    <header className="vp-top">
      <Button variant="ghost" size="icon" aria-label="影像项目目录" onClick={() => setDirectory(!directory)}>
        <FolderOpen size={17} />
      </Button>
      <Film size={17} />
      <strong>{document?.title ?? '影像创作'}</strong>{document && <span className="vp-badge">v{document.revision}</span>}<Button variant="ghost" size="icon" aria-label="刷新作品" disabled={busy} onClick={() => { void refreshList(); void load() }}>
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
    {document && <nav className="vp-tabs">{([['project', '项目'], ['assets', '资产'], ['shots', document.kind === 'image' ? '图片' : '分镜'], ['relations', '关系'], ['delivery', '交付']] as const).map(([tab, label]) => <Button key={tab} size="sm" variant={view.tab === tab ? 'secondary' : 'ghost'} onClick={() => updateView({ tab })}>{label}</Button>)}</nav>}
    <main className="vp-body">
      {!document ? <div className="vp-empty">
        <Film size={32} />
        <h3>{loading ? '读取影像项目…' : '开始你的第一部作品'}</h3>
        <p className="vp-muted">在当前 Agent 项目中管理漫剧、影片、宣传片和图片。</p>
        <Button onClick={() => setCreate(true)}>新建影像项目</Button>
      </div> : <>
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
        {view.tab === 'assets' && <div className="vp-section">{selectedAsset ? <>
          <div className="vp-row">
            <Button variant="ghost" onClick={() => setAssetId(null)}>
              <ChevronLeft size={14} />返回资产库</Button>
            <strong>{selectedAsset.name}</strong>
            <span className="vp-badge">{selectedAsset.type}{selectedAsset.locked ? ' · 已锁定' : ''}</span>
          </div>
          <VisualMediaView active={paneActive} key={selectedAsset.id} sessionId={sessionId} productionId={document.id} media={snapshot?.media.find(item => item.id === selectedAsset.mediaId)} className="vp-player" />
          <p className="vp-summary">{selectedAsset.description || '尚无说明'}</p>
          <div className="vp-detail-actions">
            <Button variant="outline" onClick={() => openEditor('asset', selectedAsset.id)}>编辑资产</Button>
            <Button variant="outline" disabled={busy} onClick={() => { const draft = copyVisualDraft(document); draft.assets.find(item => item.id === selectedAsset.id)!.locked = !selectedAsset.locked; void mutate(() => window.electronAPI.visualProduction.invoke('save', { sessionId, productionId: document.id, baseRevision: document.revision, draft })) }}>{selectedAsset.locked ? '解锁' : '锁定'}</Button>
            <Button variant="ghost" onClick={() => reference(undefined, selectedAsset.id)}>引用到 Agent</Button>
          </div>
          <details>
            <summary>使用位置（{document.shots.filter(item => item.assetIds.includes(selectedAsset.id)).length}）</summary>{document.shots.filter(item => item.assetIds.includes(selectedAsset.id)).map(item => <Button key={item.id} variant="ghost" onClick={() => updateView({ tab: 'shots', episodeId: item.episodeId, shotId: item.id })}>{item.title}</Button>)}</details>
        </> : <>
          <div className="vp-row">
            <Input aria-label="搜索资产" placeholder="搜索资产名称或说明" value={assetSearch} onChange={event => setAssetSearch(event.target.value)} />
            <Button variant="outline" onClick={() => openEditor('asset')}>
              <Plus size={14} />新增资产</Button>
          </div>
          <div className="vp-row">{['全部', ...ASSET_TYPES].map(type => <Button size="sm" key={type} variant={assetType === type ? 'secondary' : 'ghost'} onClick={() => setAssetType(type)}>{type}</Button>)}</div>
          <div className="vp-grid">{document.assets.filter(item => (assetType === '全部' || item.type === assetType) && `${item.name} ${item.description}`.toLowerCase().includes(assetSearch.toLowerCase())).map(item => <button className="vp-card vp-asset-card" key={item.id} onClick={() => setAssetId(item.id)}>
            <VisualMediaView active={paneActive} sessionId={sessionId} productionId={document.id} media={snapshot?.media.find(media => media.id === item.mediaId)} />
            <strong>{item.name}</strong>
            <span className="vp-muted">{item.type} · {item.locked ? '已锁定' : '可编辑'}</span>
          </button>)}</div>{!document.assets.length && <p className="vp-muted">新增角色、场景或产品资产，镜头引用后可查看关联影响。</p>}</>}</div>}
        {view.tab === 'shots' && <div className="vp-section">
          <div className="vp-toolbar">
            <select aria-label="当前集数" value={episodeId ?? ''} onChange={event => updateView({ episodeId: event.target.value, shotId: null })}>{!document.episodes.length && <option value="">尚无集数</option>}{document.episodes.map(item => <option key={item.id} value={item.id}>{item.title}</option>)}</select>
            <span className="vp-muted">{shots.length} 个{document.kind === 'image' ? '图片' : '镜头'}</span>
            <Button size="sm" variant="outline" disabled={!episodeId} onClick={() => openEditor('shot')}>
              <Plus size={14} />新增</Button>
          </div>{document.kind === 'image' ? <div className="vp-grid">{shots.map(item => <button className="vp-card" key={item.id} onClick={() => { updateView({ shotId: item.id }); openEditor('shot', item.id) }}>
            <VisualMediaView active={paneActive} sessionId={sessionId} productionId={document.id} media={snapshot?.media.find(media => media.id === item.mediaId)} />
            <p className="mt-2">{item.title}</p>
          </button>)}</div> : <>
            <div className="vp-strip">{shots.map((item, index) => <button key={item.id} className="vp-shot" aria-pressed={shot?.id === item.id} onClick={() => { setPlaying(false); updateView({ shotId: item.id }) }}>
              <VisualMediaView active={paneActive} sessionId={sessionId} productionId={document.id} media={snapshot?.media.find(media => media.id === item.mediaId)} />
              <span>{index + 1}. {item.title}</span>
              <span className="vp-muted">{item.duration}s{snapshot?.shotStates[item.id]?.needsUpdate ? ' · 待更新' : ''}</span>
            </button>)}</div>
            <div className="vp-player" style={{ aspectRatio: document.ratio.replace(':', '/'), width: `min(100%, calc(46vh * ${document.ratio.replace(':', ' / ')}))`, height: 'auto', maxHeight: '46vh', marginInline: 'auto' }} onClick={event => { if (shot && currentMedia && (event.target instanceof HTMLImageElement || event.target instanceof HTMLVideoElement)) setPlaying(value => !value) }}>{shot ? <VisualMediaView active={paneActive} key={`${document.id}:${shot.id}:${shot.mediaId}`} sessionId={sessionId} productionId={document.id} media={currentMedia} playing={playing && paneActive} onReady={() => setMediaReady(`${shot.id}:${shot.mediaId}`)} onEnded={advance} onError={() => setPlaying(false)} /> : <div className="vp-player-empty">新增镜头，开始安排画面</div>}</div>{shot && <div className="vp-row">
              <Button variant="outline" disabled={shotIndex <= 0} aria-label="上一镜头" onClick={() => { setPlaying(false); updateView({ shotId: shots[shotIndex - 1]?.id ?? null }) }}>
                <ChevronLeft size={14} />
              </Button>
              <Button disabled={!currentMedia} onClick={() => setPlaying(!playing)}>{playing ? '暂停' : '连续播放'}</Button>
              <Button variant="outline" disabled={shotIndex >= shots.length - 1} aria-label="下一镜头" onClick={() => { setPlaying(false); updateView({ shotId: shots[shotIndex + 1]?.id ?? null }) }}>
                <ChevronRight size={14} />
              </Button>
              <span className="vp-muted">{currentMedia?.kind === 'video' ? '视频素材' : '静帧预演'} · {shotIndex + 1} / {shots.length}</span>
            </div>}</>}{shot && <section className="vp-card">
              <div className="vp-row">
                <strong>{shot.title}</strong>
                <Button size="sm" variant="outline" onClick={() => openEditor('shot', shot.id)}>镜头设置</Button>
                <Button size="sm" variant="ghost" onClick={() => reference(shot.id)}>引用到 Agent</Button>
              </div>
              <details className="mt-3">
                <summary>画面与镜头信息</summary>
                <p className="vp-summary mt-2">{shot.scene || '尚无画面描述'}</p>
                <p className="vp-muted">运镜：{shot.motion || '未设置'} · 台词：{shot.dialogue || '未设置'}</p>
                <div className="vp-row mt-2">{shot.assetIds.map(id => <Button variant="ghost" size="sm" key={id} onClick={() => { setAssetId(id); updateView({ tab: 'assets' }) }}>{document.assets.find(item => item.id === id)?.name}</Button>)}</div>
              </details>
              <div className="vp-row mt-3">
                <Button variant="ghost" size="sm" disabled={busy || shotIndex <= 0} onClick={() => { const draft = copyVisualDraft(document); draft.shots = reorderVisualShot(draft.shots, shot.id, -1); void mutate(() => window.electronAPI.visualProduction.invoke('save', { sessionId, productionId: document.id, baseRevision: document.revision, draft })) }}>前移</Button>
                <Button variant="ghost" size="sm" disabled={busy || shotIndex >= shots.length - 1} onClick={() => { const draft = copyVisualDraft(document); draft.shots = reorderVisualShot(draft.shots, shot.id, 1); void mutate(() => window.electronAPI.visualProduction.invoke('save', { sessionId, productionId: document.id, baseRevision: document.revision, draft })) }}>后移</Button>
              </div>
            </section>}</div>}
        {view.tab === 'relations' && <div className="vp-section">
          <h3>资产 → 镜头 → 集数</h3>
          <p className="vp-muted">关系来自镜头的真实资产引用。资产变化会标记关联镜头待更新，采用新画面后恢复。</p>{document.assets.map(item => <section className="vp-card vp-relations" key={item.id}>
            <Button variant="ghost" onClick={() => { setAssetId(item.id); updateView({ tab: 'assets' }) }}>{item.name} · {item.type}</Button>{document.shots.filter(value => value.assetIds.includes(item.id)).map(value => <Button key={value.id} variant="outline" onClick={() => updateView({ tab: 'shots', episodeId: value.episodeId, shotId: value.id })}>{document.episodes.find(episode => episode.id === value.episodeId)?.title} / {value.title}{snapshot?.shotStates[value.id]?.needsUpdate ? ' · 待更新' : ''}</Button>)}{!document.shots.some(value => value.assetIds.includes(item.id)) && <span className="vp-muted">尚未被镜头引用</span>}</section>)}{!document.assets.length && <p className="vp-muted">创建资产并在镜头设置中绑定后，这里会显示制作关系。</p>}</div>}
        {view.tab === 'delivery' && <div className="vp-section">
          <section className="vp-card">
            <h3>制作交付</h3>
            <p className="vp-muted">下载制作清单与已采用素材。第一版不提供自动剪辑、混音或成片合成。</p>
            <Button className="mt-3" onClick={() => void exportManifest()}>
              <Download size={14} />下载制作清单</Button>
            <div className="vp-row mt-3">{Array.from(new Set([...document.shots.map(item => item.mediaId), ...document.assets.map(item => item.mediaId)].filter((id): id is string => !!id))).map(id => <Button key={id} variant="outline" size="sm" onClick={() => void exportMedia(id)}>{snapshot?.media.find(item => item.id === id)?.name ?? id}</Button>)}</div>
          </section>
        </div>}
        {(snapshot?.jobs.length || snapshot?.candidates.length) ? <section className="vp-section mt-5">
          <h3>制作任务与候选</h3>{snapshot.jobs.slice(-10).reverse().map(item => <div key={item.id} className="vp-card vp-row">
            <strong>{item.instruction}</strong>
            <span className="vp-muted">{({ running: '处理中', candidate: '候选已提交', failed: '失败', cancelled: '已取消', interrupted: '已中断' })[item.status]}{item.message ? ` · ${item.message}` : ''}</span>
            {item.status === 'running' && <Button variant="outline" size="sm" disabled={busy} onClick={() => void mutate(() => window.electronAPI.visualProduction.invoke('cancelJob', { sessionId, productionId: document.id, jobId: item.id }))}>取消任务</Button>}
          </div>)}{snapshot.candidates.slice().reverse().map(renderCandidate)}</section> : null}
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
            <label>作品类型<select disabled={busy} value={kind} onChange={event => setKind(event.target.value as VisualProductionKind)}>{Object.entries(KIND_LABELS).map(([value, label]) => <option value={value} key={value}>{label}</option>)}</select>
            </label>
          </div>
          <footer className="vp-form-footer">
            <Button type="button" variant="outline" disabled={busy} onClick={() => setCreate(false)}>取消</Button>
            <Button type="submit" disabled={busy || !title.trim()}>创建作品</Button>
          </footer>
        </form>
      </DialogContent>
    </Dialog>
    <Dialog open={!!editor} onOpenChange={open => { if (!open) closeEditor() }}>
      <DialogContent onCloseAutoFocus={event => { event.preventDefault(); editorOpener.current?.focus() }} className={editor?.kind === 'shot' ? 'vp-dialog sm:max-w-[880px]' : 'vp-dialog sm:max-w-[640px]'}>
        <DialogHeader>
          <DialogTitle>{editor?.kind === 'project' ? '作品设定' : editor?.kind === 'shot' ? '镜头设置' : editor?.kind === 'asset' ? '资产设置' : '集数设置'}</DialogTitle>
          <DialogDescription>关闭保留本次草稿，保存后更新正式版本。</DialogDescription>
        </DialogHeader>{editor && <form className="vp-form" onSubmit={saveEditor}>
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
                <label>画面比例<select value={editor.draft.ratio} onChange={event => changeEditor(draft => { draft.ratio = event.target.value })}>{VISUAL_PRODUCTION_RATIOS.map(value => <option key={value}>{value}</option>)}</select>
                </label>{editor.draft.kind !== 'image' && <label>帧率<select value={editor.draft.fps} onChange={event => changeEditor(draft => { draft.fps = Number(event.target.value) })}>{[24, 25, 30, 60].map(value => <option key={value}>{value}</option>)}</select>
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
              <label>资产类型<select value={editAsset.type} onChange={event => changeEditor(draft => { draft.assets.find(item => item.id === editor.targetId)!.type = event.target.value })}>{ASSET_TYPES.map(value => <option key={value}>{value}</option>)}</select>
              </label>
              <label>描述<Textarea rows={4} value={editAsset.description} onChange={event => changeEditor(draft => { draft.assets.find(item => item.id === editor.targetId)!.description = event.target.value })} />
              </label>
              <label className="vp-check">
                <input type="checkbox" checked={editAsset.locked} onChange={event => changeEditor(draft => { draft.assets.find(item => item.id === editor.targetId)!.locked = event.target.checked })} />锁定资产，Agent 候选不可修改</label>
            </>}
            {editor.kind === 'shot' && editShot && <div className="vp-form-columns">
              <div className="vp-form-fields">
                <label>镜头名称<Input required maxLength={120} value={editShot.title} onChange={event => changeEditor(draft => { draft.shots.find(item => item.id === editor.targetId)!.title = event.target.value })} />
                </label>
                <div className="vp-grid">{editor.draft.kind !== 'image' && <label>时长（秒）<Input type="number" required min={0.1} max={600} step={0.1} value={editShot.duration} onChange={event => changeEditor(draft => { draft.shots.find(item => item.id === editor.targetId)!.duration = Number(event.target.value) })} />
                </label>}<label>运镜<Input value={editShot.motion} onChange={event => changeEditor(draft => { draft.shots.find(item => item.id === editor.targetId)!.motion = event.target.value })} />
                  </label>
                </div>
                <label>画面描述<Textarea rows={4} value={editShot.scene} onChange={event => changeEditor(draft => { draft.shots.find(item => item.id === editor.targetId)!.scene = event.target.value })} />
                </label>
                <label>旁白 / 对白<Textarea rows={2} value={editShot.dialogue} onChange={event => changeEditor(draft => { draft.shots.find(item => item.id === editor.targetId)!.dialogue = event.target.value })} />
                </label>
              </div>
              <aside className="vp-form-fields">
                <strong>引用资产</strong>{editor.draft.assets.map(item => <label key={item.id} className="vp-check">
                  <input type="checkbox" checked={editShot.assetIds.includes(item.id)} onChange={event => changeEditor(draft => { const target = draft.shots.find(value => value.id === editor.targetId)!; target.assetIds = event.target.checked ? [...target.assetIds, item.id] : target.assetIds.filter(id => id !== item.id) })} />{item.name} <span className="vp-muted">{item.type}</span>
                </label>)}{!editor.draft.assets.length && <p className="vp-muted">先在资产库添加素材。</p>}<p className="vp-muted">设定修订 {snapshot?.shotStates[editShot.id]?.revision ?? 0} · 画面版本 {snapshot?.shotStates[editShot.id]?.outputVersion ?? 0}</p>
              </aside>
            </div>}
            {(editor.kind === 'asset' || editor.kind === 'shot') && <>
              <label>采用素材<select value={editAsset?.mediaId ?? editShot?.mediaId ?? ''} onChange={event => changeEditor(draft => { if (editor.kind === 'asset') draft.assets.find(item => item.id === editor.targetId)!.mediaId = event.target.value || null; else draft.shots.find(item => item.id === editor.targetId)!.mediaId = event.target.value || null })}>
                <option value="">暂无素材</option>{snapshot?.media.filter(item => editor.kind === 'asset' || (item.kind !== 'audio' && (editor.draft.kind !== 'image' || item.kind === 'image'))).map(item => <option key={item.id} value={item.id}>{item.name} · {item.kind}</option>)}</select>
              </label>
              <details>
                <summary>从当前项目导入媒体</summary>
                <div className="vp-row mt-2">
                  <Input aria-label="项目内媒体相对路径" placeholder="例如 assets/shot-01.mp4" value={importPath} onChange={event => setImportPath(event.target.value)} />
                  <Button type="button" variant="outline" disabled={busy || !importPath.trim()} onClick={() => void importFile()}>导入</Button>
                </div>
                <p className="vp-muted mt-2">也可让 Agent 使用现有媒体工具生成后提交候选。</p>
              </details>
            </>}
          </div>
          <footer className="vp-form-footer">
            <Button type="button" variant="outline" onClick={closeEditor}>关闭</Button>
            <Button type="submit" disabled={busy || editor.baseRevision !== document?.revision}>保存设置</Button>
          </footer>
        </form>}</DialogContent>
    </Dialog>
    <Dialog open={!!candidate} onOpenChange={open => { if (!open) setCandidateId(null) }}>
      <DialogContent className="vp-dialog sm:max-w-[800px]">
        <DialogHeader>
          <DialogTitle>候选预览</DialogTitle>
          <DialogDescription>预览不会替换已采用的画面。基于版本 {candidate?.baseRevision}。</DialogDescription>
        </DialogHeader>
        <div className="vp-form-body" style={{ maxHeight: '65vh' }}>{candidate && <>
          <p>{candidate.summary}</p>
          <section className="vp-card">
            <h3>作品设定</h3>
            <p>{candidate.draft.title} · {KIND_LABELS[candidate.draft.kind]} · {candidate.draft.ratio} · {candidate.draft.fps} fps</p>
            <p className="vp-summary">{candidate.draft.brief || '未填写作品目标'}</p>
            <p className="vp-muted">配音：{candidate.draft.voice || '未设置'} · 音乐：{candidate.draft.music || '未设置'}</p>
          </section>
          <section className="vp-card">
            <h3>集数（{candidate.draft.episodes.length}）</h3>{candidate.draft.episodes.map(item => <p key={item.id}>{item.title}</p>)}</section>
          <section className="vp-card">
            <h3>资产（{candidate.draft.assets.length}）</h3>{candidate.draft.assets.map(item => <div key={item.id} className="vp-card">
              <strong>{item.name} · {item.type}{item.locked ? ' · 锁定' : ''}</strong>
              <p className="vp-summary">{item.description}</p>{item.mediaId && <VisualMediaView active={paneActive} sessionId={sessionId} productionId={view.productionId!} media={snapshot?.media.find(media => media.id === item.mediaId)} />}</div>)}</section>
          <h3>镜头（{candidate.draft.shots.length}）</h3>
          <div className="vp-grid">{candidate.draft.shots.map(item => <div className="vp-card" key={item.id}>
            <VisualMediaView active={paneActive} sessionId={sessionId} productionId={view.productionId!} media={snapshot?.media.find(media => media.id === item.mediaId)} />
            <strong>{item.title}</strong>
            <p className="vp-muted">{item.scene}</p>
          </div>)}</div>{renderCandidate(candidate)}</>}</div>
      </DialogContent>
    </Dialog>
  </div>
}
