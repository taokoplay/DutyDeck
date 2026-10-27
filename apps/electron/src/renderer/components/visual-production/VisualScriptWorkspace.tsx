import * as React from 'react'
import { AlertTriangle, ArrowRight, Check, ChevronDown, ChevronUp, Film, Map, Pencil, Plus, ScrollText, Sparkles, Trash2 } from 'lucide-react'
import type { VisualEpisodeScript, VisualProductionDocument, VisualProductionSnapshot, VisualScriptBeat, VisualScriptBeatPurpose, VisualShot } from '@dutydeck/shared'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Textarea } from '@/components/ui/textarea'
import { buildVisualScriptOverview, emptyVisualEpisodeScript, SCRIPT_PURPOSE_LABELS } from './visual-script-model'

/** 脚本页只处理集级叙事；镜头、资产和媒体仍由原工作台承接。 */
interface VisualScriptWorkspaceProps {
  document: VisualProductionDocument
  snapshot: VisualProductionSnapshot
  episodeId: string
  active: boolean
  busy: boolean
  onEpisodeChange: (episodeId: string) => void
  onOpenShot: (shotId: string) => void
  onGenerate: () => void
  onReference: () => void
  onSave: (script: VisualEpisodeScript) => void
}

/** 将集级剧本、叙事节拍和真实镜头制作进度放在同一制作视图中。 */
export function VisualScriptWorkspace(props: VisualScriptWorkspaceProps): React.ReactElement {
  const { document, snapshot, episodeId, busy, onEpisodeChange, onOpenShot, onGenerate, onReference, onSave } = props
  const episode = document.episodes.find(item => item.id === episodeId)
  const shots = React.useMemo(() => document.shots.filter(item => item.episodeId === episodeId), [document.shots, episodeId])
  const overview = React.useMemo(() => buildVisualScriptOverview(snapshot, episodeId), [snapshot, episodeId])
  const [selectedBeatId, setSelectedBeatId] = React.useState<string | null>(episode?.script?.beats[0]?.id ?? null)
  const [editing, setEditing] = React.useState(false)
  const [draft, setDraft] = React.useState<VisualEpisodeScript | null>(null)
  const [selectedEditBeatId, setSelectedEditBeatId] = React.useState<string | null>(null)
  /** 集级故事弧默认折叠，避免每集重复挤占节拍和镜头编辑空间。 */
  const [thesisExpanded, setThesisExpanded] = React.useState(false)
  const beats = episode?.script?.beats ?? []
  const selectedBeat = beats.find(beat => beat.id === selectedBeatId) ?? beats[0]
  const selectedBeatShots = selectedBeat ? mappedShots(selectedBeat, shots) : []

  React.useEffect(() => {
    setSelectedBeatId(episode?.script?.beats[0]?.id ?? null)
    setEditing(false)
    setDraft(null)
    setSelectedEditBeatId(null)
    setThesisExpanded(false)
  }, [episodeId, episode?.script])

  /** 打开编辑器时复制正式剧本，关闭不保存；保存仍由宿主 CAS 提交。 */
  const beginEdit = (): void => {
    const next = structuredClone(episode?.script ?? emptyVisualEpisodeScript())
    if (!next.beats.length && shots.length) next.beats.push(createBeat('hook', shots.slice(0, Math.min(2, shots.length)).map(shot => shot.id)))
    if (!next.targetDurationSeconds) next.targetDurationSeconds = Math.round(shots.reduce((sum, shot) => sum + shot.duration, 0) * 10) / 10
    setDraft(next)
    setSelectedEditBeatId(next.beats[0]?.id ?? null)
    setEditing(true)
  }

  return <div className="vp-section vp-script-page" data-testid="visual-script-workspace" data-active={props.active}>
    <header className="vp-script-toolbar">
      <div className="vp-script-episode">
        <span className="vp-script-kicker">SCREENPLAY</span>
        <Select value={episodeId} onValueChange={onEpisodeChange}>
          <SelectTrigger aria-label="剧本集数" className="h-8 min-w-0 max-w-80 gap-2 text-xs"><SelectValue placeholder="选择集数" /></SelectTrigger>
          <SelectContent>{document.episodes.map(item => <SelectItem key={item.id} value={item.id}>{item.title}</SelectItem>)}</SelectContent>
        </Select>
      </div>
      <div className="vp-script-toolbar-stats">
        <span>{overview.beatCount} 个节拍</span>
        <span>{overview.mappedShotCount}/{overview.totalShotCount} 镜已映射</span>
        <span>{overview.shotDurationSeconds}s{overview.targetDurationSeconds ? ` / 目标 ${overview.targetDurationSeconds}s` : ''}</span>
      </div>
      <div className="vp-script-toolbar-actions">
        <Button size="sm" variant="outline" disabled={busy} onClick={onGenerate}><Sparkles size={14} />让 Agent 生成 / 重构</Button>
        <Button size="sm" disabled={busy} onClick={beginEdit}><Pencil size={14} />{episode?.script ? '编辑剧本' : '新建剧本'}</Button>
      </div>
    </header>

    {!episode?.script ? <div className="vp-script-empty">
      <section className="vp-script-empty-main">
        <span className="vp-script-kicker">SCRIPT FIRST</span>
        <ScrollText size={31} />
        <h2>先把整集拍摄逻辑写成剧本</h2>
        <p>当前作品已有 {shots.length} 个镜头和制作正文，但叙事因果、观众问题、节拍与镜头映射尚未成为正式合同。先用 Agent 从现有内容整理，或手动建立第一版。</p>
        <div className="vp-script-empty-actions"><Button disabled={busy} onClick={onGenerate}><Sparkles size={14} />从现有作品整理剧本</Button><Button variant="outline" disabled={busy} onClick={beginEdit}><Plus size={14} />手动建立</Button></div>
        <div className="vp-script-shadow-brief"><span>现有创作依据</span><p>{document.brief || '作品简介尚未填写。'}</p></div>
      </section>
      <aside className="vp-script-empty-shots">
        <div className="vp-script-section-heading"><h3>现有镜头稿</h3><span>{shots.length} 个镜头</span></div>
        {shots.map((shot, index) => <button key={shot.id} className="vp-script-shot-row" onClick={() => onOpenShot(shot.id)}>
          <span>{String(index + 1).padStart(2, '0')}</span><div><strong>{shot.title}</strong><small>{shot.duration}s · {shot.scene || '画面描述为空'}</small></div><ArrowRight size={14} />
        </button>)}
        {!shots.length && <div className="vp-script-inline-empty"><Film size={24} /><p>本集尚无镜头，先在分镜中加入拍摄单元。</p></div>}
      </aside>
    </div> : <div className="vp-script-layout">
      <aside className="vp-script-outline" aria-label="剧本节拍">
        <div className="vp-script-section-heading"><h3>叙事节拍</h3><span>{beats.length}</span></div>
        <div className="vp-script-beats">{beats.map((beat, index) => {
          const mapped = mappedShots(beat, shots)
          const duration = mapped.reduce((sum, shot) => sum + shot.duration, 0)
          return <button key={beat.id} data-purpose={beat.purpose} aria-pressed={selectedBeat?.id === beat.id} onClick={() => setSelectedBeatId(beat.id)}>
            <span className="vp-script-beat-index">{String(index + 1).padStart(2, '0')}</span>
            <span className="vp-script-beat-copy"><small>{SCRIPT_PURPOSE_LABELS[beat.purpose]}</small><strong>{beat.title}</strong><span>{mapped.length} 镜 · {duration}s</span></span>
          </button>
        })}</div>
        <div className="vp-script-outline-note"><Map size={14} /><p>节拍数组决定叙事顺序，镜头顺序决定成片执行顺序。两者通过 shotId 对齐。</p></div>
      </aside>

      <main className="vp-script-main">
        <section className="vp-script-thesis" data-expanded={thesisExpanded}>
          <button type="button" className="vp-script-thesis-toggle" aria-expanded={thesisExpanded} onClick={() => setThesisExpanded(value => !value)}>
            <div><span className="vp-script-kicker">本集故事弧</span><strong>开场钩子 <ArrowRight size={11} /> 核心转折 <ArrowRight size={11} /> 阶段结果</strong></div>
            <span>{thesisExpanded ? '收起全文' : '展开全文'}{thesisExpanded ? <ChevronUp size={13} /> : <ChevronDown size={13} />}</span>
          </button>
          <div className="vp-script-thesis-body" hidden={!thesisExpanded}>
            <div><span className="vp-script-kicker">LOGLINE · 本集专属</span><h2>{episode.script.logline || '尚未填写一句话故事'}</h2></div>
            <p>{episode.script.audiencePromise || '尚未填写观众承诺。'}</p>
            <div className="vp-script-arc"><div><span>开场钩子</span><p>{episode.script.hook || '未填写'}</p></div><ArrowRight size={14} /><div><span>核心转折</span><p>{episode.script.turningPoint || '未填写'}</p></div><ArrowRight size={14} /><div><span>阶段结果</span><p>{episode.script.payoff || '未填写'}</p></div></div>
          </div>
        </section>
        {selectedBeat ? <section className="vp-script-beat-detail" data-purpose={selectedBeat.purpose}>
          <header><div><span className="vp-script-kicker">{SCRIPT_PURPOSE_LABELS[selectedBeat.purpose]}</span><h2>{selectedBeat.title}</h2></div><span className="vp-badge">{selectedBeatShots.length} 个镜头</span></header>
          <div className="vp-script-detail-grid">
            <ScriptTextBlock label="戏剧问题" value={selectedBeat.dramaticQuestion} />
            <ScriptTextBlock label="节拍概述" value={selectedBeat.synopsis} />
            <ScriptTextBlock label="视觉动作方向" value={selectedBeat.visualAction} featured />
            <ScriptTextBlock label="对白 / 旁白意图" value={selectedBeat.dialogue} />
            <ScriptTextBlock label="声音" value={selectedBeat.sound} />
            <ScriptTextBlock label="连续性" value={selectedBeat.continuity} />
          </div>
          <div className="vp-script-shot-mapping">
            <div className="vp-script-section-heading"><h3>映射分镜</h3><span>{selectedBeatShots.length} 个</span></div>
            <div className="vp-script-shot-grid">{selectedBeatShots.map(shot => <button key={shot.id} onClick={() => onOpenShot(shot.id)}>
              <span>{String(shots.indexOf(shot) + 1).padStart(2, '0')}</span>
              <div><strong>{shot.title}</strong><small>{shot.duration}s · {shot.videoPlan ? '已有生成设计' : '待定生成设计'}</small></div>
              <ArrowRight size={14} />
            </button>)}{!selectedBeatShots.length && <p className="vp-muted">尚未映射镜头，剧本计划还不能直接进入生成。</p>}</div>
          </div>
        </section> : <div className="vp-script-inline-empty"><ScrollText size={24} /><p>至少添加一个叙事节拍。</p></div>}
        {episode.script.productionNotes && <section className="vp-script-production-notes"><div className="vp-script-section-heading"><h3>拍摄总要求</h3><span>事实 · 连续 · 声音 · 验收</span></div><p>{episode.script.productionNotes}</p></section>}
      </main>

      <aside className="vp-script-flow" aria-label="整集制作准备">
        <div className="vp-script-section-heading"><h3>拍摄流程</h3><span data-status={overview.status}>{overview.status === 'ready' ? '结构就绪' : '仍有缺口'}</span></div>
        <div className="vp-script-flow-stages">{overview.stages.map((stage, index) => <div key={stage.id} data-status={stage.status}>
          <span className="vp-script-flow-index">{String(index + 1).padStart(2, '0')}</span>
          <div><strong>{stage.label}</strong><p>{stage.detail}</p></div>
          {stage.status === 'ready' ? <Check size={14} /> : <AlertTriangle size={14} />}
        </div>)}</div>
        <section className="vp-script-issues"><div className="vp-script-section-heading"><h3>当前风险</h3><span>{overview.issues.length}</span></div>{overview.issues.length ? <ul>{overview.issues.map(issue => <li key={issue}>{issue}</li>)}</ul> : <p className="vp-script-flow-complete"><Check size={14} />剧本、分镜、资产和生成设计已形成完整链路。</p>}</section>
        <div className="vp-script-flow-actions"><Button variant="outline" size="sm" onClick={onGenerate} disabled={busy}><Sparkles size={14} />让 Agent 重构缺口</Button><Button variant="ghost" size="sm" onClick={onReference}>引用本集到 Agent</Button></div>
      </aside>
    </div>}

    <Dialog open={editing} onOpenChange={setEditing}>
      <DialogContent className="vp-dialog vp-script-editor-dialog sm:max-w-[960px]">
        <DialogHeader><DialogTitle>编辑整集剧本</DialogTitle><DialogDescription>关闭保留本次输入；保存后生成新的正式作品版本。剧本不直接修改镜头和媒体。</DialogDescription></DialogHeader>
        {draft && <ScriptEditor
          script={draft}
          shots={shots}
          selectedBeatId={selectedEditBeatId}
          onSelectBeat={setSelectedEditBeatId}
          onChange={setDraft}
        />}
        <DialogFooter><Button variant="outline" onClick={() => setEditing(false)}>取消</Button><Button disabled={busy} onClick={() => { if (!draft) return; onSave(draft); setEditing(false) }}>保存剧本</Button></DialogFooter>
      </DialogContent>
    </Dialog>
  </div>
}

/** 剧本编辑保持整集字段和节拍顺序，不直接触碰正式作品。 */
function ScriptEditor(props: {
  script: VisualEpisodeScript
  shots: VisualShot[]
  selectedBeatId: string | null
  onSelectBeat: (id: string) => void
  onChange: (script: VisualEpisodeScript) => void
}): React.ReactElement {
  const { script, shots, selectedBeatId, onSelectBeat, onChange } = props
  const beat = script.beats.find(item => item.id === selectedBeatId) ?? script.beats[0]
  /** 所有编辑先复制整集，再按稳定身份替换目标节拍。 */
  const updateBeat = (change: (target: VisualScriptBeat) => void): void => {
    if (!beat) return
    const next = structuredClone(script)
    const target = next.beats.find(item => item.id === beat.id)
    if (!target) return
    change(target)
    onChange(next)
  }
  /** 新增节拍默认映射到尚未使用的第一个镜头。 */
  const addBeat = (): void => {
    const mapped = new Set(script.beats.flatMap(item => item.shotIds))
    const nextShot = shots.find(shot => !mapped.has(shot.id))
    const created = createBeat(script.beats.length ? 'rising-action' : 'hook', nextShot ? [nextShot.id] : [])
    onChange({ ...script, beats: [...script.beats, created] })
    onSelectBeat(created.id)
  }
  /** 删除节拍只影响剧本候选，不删除其映射镜头。 */
  const removeBeat = (): void => {
    if (!beat) return
    const index = script.beats.findIndex(item => item.id === beat.id)
    const beats = script.beats.filter(item => item.id !== beat.id)
    onChange({ ...script, beats })
    onSelectBeat(beats[Math.max(0, index - 1)]?.id ?? '')
  }
  /** 节拍上下移动同时表达叙事顺序变化。 */
  const moveBeat = (offset: -1 | 1): void => {
    if (!beat) return
    const index = script.beats.findIndex(item => item.id === beat.id)
    const target = index + offset
    if (target < 0 || target >= script.beats.length) return
    const beats = [...script.beats]
    ;[beats[index], beats[target]] = [beats[target]!, beats[index]!]
    onChange({ ...script, beats })
  }
  return <div className="vp-script-editor">
    <section className="vp-script-editor-overview">
      <label>一句话故事<Textarea rows={2} maxLength={2000} value={script.logline} onChange={event => onChange({ ...script, logline: event.target.value })} /></label>
      <label>观众承诺<Textarea rows={2} maxLength={4000} value={script.audiencePromise} onChange={event => onChange({ ...script, audiencePromise: event.target.value })} /></label>
      <div className="vp-grid"><label>目标时长（秒）<Input type="number" min={0} max={3600} value={script.targetDurationSeconds} onChange={event => onChange({ ...script, targetDurationSeconds: Number(event.target.value) })} /></label><label>开场钩子<Input maxLength={4000} value={script.hook} onChange={event => onChange({ ...script, hook: event.target.value })} /></label></div>
      <div className="vp-grid"><label>核心转折<Textarea rows={2} maxLength={4000} value={script.turningPoint} onChange={event => onChange({ ...script, turningPoint: event.target.value })} /></label><label>阶段结果<Textarea rows={2} maxLength={4000} value={script.payoff} onChange={event => onChange({ ...script, payoff: event.target.value })} /></label></div>
      <label>拍摄总要求<Textarea rows={3} maxLength={16000} value={script.productionNotes} onChange={event => onChange({ ...script, productionNotes: event.target.value })} /></label>
    </section>
    <section className="vp-script-editor-body">
      <aside className="vp-script-editor-beats">
        <div className="vp-script-section-heading"><h3>节拍</h3><Button type="button" size="sm" variant="outline" onClick={addBeat}><Plus size={13} />新增</Button></div>
        {script.beats.map((item, index) => <button type="button" key={item.id} aria-pressed={beat?.id === item.id} onClick={() => onSelectBeat(item.id)}><span>{String(index + 1).padStart(2, '0')}</span><div><small>{SCRIPT_PURPOSE_LABELS[item.purpose]}</small><strong>{item.title || '未命名节拍'}</strong></div></button>)}
      </aside>
      {beat ? <div className="vp-script-editor-fields">
        <div className="vp-script-editor-beat-actions"><Button type="button" size="icon-sm" variant="ghost" aria-label="前移节拍" disabled={script.beats.findIndex(item => item.id === beat.id) <= 0} onClick={() => moveBeat(-1)}><ChevronUp size={14} /></Button><Button type="button" size="icon-sm" variant="ghost" aria-label="后移节拍" disabled={script.beats.findIndex(item => item.id === beat.id) >= script.beats.length - 1} onClick={() => moveBeat(1)}><ChevronDown size={14} /></Button><Button type="button" size="sm" variant="ghost" className="ml-auto" onClick={removeBeat}><Trash2 size={13} />删除</Button></div>
        <div className="vp-grid"><label>节拍名称<Input required maxLength={120} value={beat.title} onChange={event => updateBeat(target => { target.title = event.target.value })} /></label><label>叙事功能<Select value={beat.purpose} onValueChange={value => updateBeat(target => { target.purpose = value as VisualScriptBeatPurpose })}><SelectTrigger aria-label="叙事功能"><SelectValue /></SelectTrigger><SelectContent>{Object.entries(SCRIPT_PURPOSE_LABELS).map(([value, label]) => <SelectItem key={value} value={value}>{label}</SelectItem>)}</SelectContent></Select></label></div>
        <label>观众问题<Input maxLength={4000} value={beat.dramaticQuestion} onChange={event => updateBeat(target => { target.dramaticQuestion = event.target.value })} /></label>
        <label>节拍概述<Textarea rows={3} maxLength={8000} value={beat.synopsis} onChange={event => updateBeat(target => { target.synopsis = event.target.value })} /></label>
        <label>视觉动作方向<Textarea rows={3} maxLength={8000} value={beat.visualAction} onChange={event => updateBeat(target => { target.visualAction = event.target.value })} /></label>
        <div className="vp-grid"><label>对白 / 旁白意图<Textarea rows={3} maxLength={8000} value={beat.dialogue} onChange={event => updateBeat(target => { target.dialogue = event.target.value })} /></label><label>声音<Textarea rows={3} maxLength={4000} value={beat.sound} onChange={event => updateBeat(target => { target.sound = event.target.value })} /></label></div>
        <label>连续性<Textarea rows={3} maxLength={8000} value={beat.continuity} onChange={event => updateBeat(target => { target.continuity = event.target.value })} /></label>
        <fieldset className="vp-script-shot-select"><legend>映射分镜</legend>{shots.map((shot, index) => <label key={shot.id}><input className="vp-themed-checkbox" type="checkbox" checked={beat.shotIds.includes(shot.id)} onChange={event => updateBeat(target => { target.shotIds = event.target.checked ? [...target.shotIds, shot.id] : target.shotIds.filter(id => id !== shot.id) })} /><span>{String(index + 1).padStart(2, '0')} · {shot.title}</span><small>{shot.duration}s</small></label>)}</fieldset>
      </div> : <div className="vp-script-editor-fields vp-script-inline-empty"><ScrollText size={24} /><p>新增一个叙事节拍开始编辑。</p></div>}
    </section>
  </div>
}

/** 展示一个剧本字段并保留多行原文。 */
function ScriptTextBlock({ label, value, featured = false }: { label: string; value: string; featured?: boolean }): React.ReactElement {
  return <section className={featured ? 'vp-script-text vp-script-text-featured' : 'vp-script-text'}><span>{label}</span><p>{value || '尚未填写'}</p></section>
}

/** 按稳定 shotId 取出当前节拍实际映射的镜头。 */
function mappedShots(beat: VisualScriptBeat, shots: VisualShot[]): VisualShot[] {
  const ids = new Set(beat.shotIds)
  return shots.filter(shot => ids.has(shot.id))
}

/** 建立带稳定身份的空白节拍。 */
function createBeat(purpose: VisualScriptBeatPurpose, shotIds: string[]): VisualScriptBeat {
  return {
    id: crypto.randomUUID(), title: '新节拍', purpose,
    dramaticQuestion: '', synopsis: '', visualAction: '', dialogue: '', sound: '', continuity: '', shotIds,
  }
}
