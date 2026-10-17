import * as React from 'react'
import { useSetAtom } from 'jotai'
import { Plus, RefreshCw, Settings2 } from 'lucide-react'
import { parseMediaModelRef } from '@proma/shared'
import type { VisualProductionMediaConfiguration, VisualProductionMediaEntry, VisualProductionMediaOption } from '@proma/shared'
import { settingsOpenAtom, settingsTabAtom } from '@/atoms/settings-tab'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'

/** 制作配置的保存复用工作台作用域和写锁，不独立更新正式快照。 */
interface ConfigurationProps {
  sessionId: string
  productionId: string
  configuration?: VisualProductionMediaConfiguration
  active: boolean
  busy: boolean
  onSave: (configuration: VisualProductionMediaConfiguration, onSaved: () => void) => void
}
/** 默认方案只区分实际生成的三类媒体。 */
const KINDS = ['image', 'video', 'audio'] as const
/** 用户界面的媒体类型名称。 */
const LABELS = { image: '图片', video: '视频', audio: '声音' }
/** 保留值用于 Select 的无默认选项，不参与持久化。 */
const NONE = '__none__'
/** 目录包含运行状态，保存时仅提取作品自身的配置。 */
function entryFromOption(option: VisualProductionMediaOption): VisualProductionMediaEntry {
  return { id: option.id, name: option.name, kind: option.kind, source: option.source, parameters: { ...option.parameters } }
}
/** 同一 ComfyUI 服务的媒体路由合并展示，不把路由误表示成已验证的工作流。 */
function groupEntries<T extends VisualProductionMediaEntry>(entries: T[]): T[][] {
  const groups = new Map<string, T[]>()
  for (const entry of entries) {
    const key = entry.source.type === 'connection' ? `connection:${entry.source.connectionId}` : entry.id
    const group = groups.get(key) ?? []
    group.push(entry); groups.set(key, group)
  }
  return [...groups.values()]
}
/** 配置采用独立版本；首次保存才将继承全局目录转为当前作品的明确范围。 */
export function VisualProductionMediaConfigurationPanel({ sessionId, productionId, configuration, active, busy, onSave }: ConfigurationProps): React.ReactElement {
  /** 全局设置保持现有统一入口。 */
  const setSettingsOpen = useSetAtom(settingsOpenAtom)
  const setSettingsTab = useSetAtom(settingsTabAtom)
  /** 只缓存无凭据的能力目录，切换作品通过父级 key 销毁。 */
  const [catalog, setCatalog] = React.useState<VisualProductionMediaOption[]>([])
  const [loading, setLoading] = React.useState(false)
  const [loaded, setLoaded] = React.useState(false)
  const [error, setError] = React.useState('')
  /** null 表示无本地修改，后台事件不会覆盖非空草稿。 */
  const [draft, setDraft] = React.useState<VisualProductionMediaConfiguration | null>(null)
  const [adding, setAdding] = React.useState(false)
  const [search, setSearch] = React.useState('')
  const [filter, setFilter] = React.useState('all')
  /** 参数表单保存到本地草稿后，仍需显式保存作品配置。 */
  const [editing, setEditing] = React.useState<VisualProductionMediaEntry | null>(null)
  /** 丢弃过时的目录响应；卸载后不回写。 */
  const request = React.useRef(0)
  React.useEffect(() => () => { request.current++ }, [])
  /** 仅请求已有目录，不探测服务器、不扫描权重、不发起生成。 */
  const refresh = React.useCallback(async (): Promise<void> => {
    const ticket = ++request.current
    setLoading(true); setError('')
    try {
      const options = await window.electronAPI.visualProduction.invoke('mediaCatalog', { sessionId, productionId })
      if (request.current === ticket) { setCatalog(options); setLoaded(true) }
    } catch (cause) { if (request.current === ticket) setError(String(cause)) }
    finally { if (request.current === ticket) setLoading(false) }
  }, [sessionId, productionId])
  React.useEffect(() => { if (active) void refresh() }, [active, refresh])
  /** 旧作品继承可用目录，但不猜测用户的默认模型。 */
  const current = draft ?? configuration ?? { revision: 0, entries: catalog.filter(item => item.available).map(entryFromOption), defaults: {} }
  /** 外部保存冲突时保留用户草稿，禁止以新版本覆盖提交。 */
  const stale = !!draft && draft.revision !== (configuration?.revision ?? 0)
  /** 所有操作仅编辑内存，不调用实际模型或修改全局配置。 */
  const change = (next: VisualProductionMediaConfiguration): void => { setDraft(next) }
  /** 来源身份由主进程目录给定，工作流需固定服务器和版本。 */
  const sourceLabel = (entry: VisualProductionMediaEntry): string => {
    if (entry.source.type === 'model') {
      /** 严格解析来源 provider，不因模型名称包含“即梦”而误标其他接入。 */
      try {
        if (parseMediaModelRef(entry.source.modelRef).provider === 'dreamina') return `即梦 · 本机 CLI 登录态 · ${entry.source.modelRef}`
      } catch { /* 兼容历史引用格式，仍保留其原始来源供用户核对。 */ }
      return `API 模型 · ${entry.source.modelRef}`
    }
    return entry.source.type === 'connection' ? `ComfyUI 服务 · ${entry.source.connectionId}` : `固定工作流 · ${entry.source.connectionId} / ${entry.source.workflowId} · v${entry.source.workflowRevision}`
  }
  /** 只按稳定身份匹配状态，已删除配置仍在作品列表中保留。 */
  const optionFor = (entry: VisualProductionMediaEntry): VisualProductionMediaOption | undefined => catalog.find(item => item.id === entry.id)
  /** 按服务分组移除，同时清理该组默认项，不回退到全局目录。 */
  const remove = (entries: VisualProductionMediaEntry[]): void => {
    const ids = new Set(entries.map(entry => entry.id))
    const defaults = { ...current.defaults }
    for (const kind of KINDS) if (defaults[kind] && ids.has(defaults[kind]!)) delete defaults[kind]
    change({ ...current, entries: current.entries.filter(item => !ids.has(item.id)), defaults })
  }
  /** 加入当前组中可用且尚未启用的路由，不把服务目录伪装为工作流能力。 */
  const add = (options: VisualProductionMediaOption[]): void => {
    change({ ...current, entries: [...current.entries, ...options.filter(option => option.available && !current.entries.some(item => item.id === option.id)).map(entryFromOption)] })
  }
  /** 继承状态不能暗示用户已经显式保存或加入目录。 */
  const inherited = !configuration && !draft
  /** 添加弹窗先按媒体类别筛选，再按服务聚合，默认方案仍按类别选择。 */
  const filteredOptions = catalog.filter(item => (filter === 'all' || item.kind === filter) && `${item.name} ${sourceLabel(item)}`.toLowerCase().includes(search.toLowerCase()))
  /** 进入已有媒体设置，凭据仍由全局配置管理。 */
  const openSettings = (): void => { setAdding(false); setSettingsTab('media'); setSettingsOpen(true) }
  /** 读取真实适配器支持的参数，无声明时不生成假参数表单。 */
  const parameterFields = editing ? optionFor(editing)?.constraints.parameters ?? [] : []
  return <section className="vp-section vp-media-configuration" hidden={!active} aria-label="制作配置">
    <div className="vp-row"><strong>制作配置</strong><Button size="sm" variant="ghost" disabled={loading || busy} onClick={() => void refresh()}><RefreshCw size={14} />刷新目录</Button><Button size="sm" variant="outline" onClick={openSettings}><Settings2 size={14} />全局媒体设置</Button></div>
    <p className="vp-muted">复用已配置的模型和 ComfyUI 服务。工作流由 Agent 按任务选择，生成前验证工作流与服务匹配。服务配置可用不代表已经验证输出能力。</p>
    {!configuration && !draft && <p className="vp-media-config-note">当前继承全局可用目录。保存后，仅允许使用此处加入的能力；空列表表示禁止新媒体生成。</p>}
    {error && <p className="vp-error" role="alert">{error}</p>}
    {stale && <div className="vp-error" role="alert">配置已被更新，草稿仍保留。请核对后读取最新配置。<Button size="sm" variant="outline" onClick={() => { setDraft(null); setEditing(null) }}>放弃草稿，读取最新</Button></div>}
    {!loaded && loading ? <p className="vp-muted" role="status">读取媒体目录…</p> : <>
      <div className="vp-media-defaults">{KINDS.map(kind => <label className="vp-card" key={kind}><span>{LABELS[kind]}默认方案</span><Select disabled={busy || !loaded} value={current.defaults[kind] ?? NONE} onValueChange={value => {
        const defaults = { ...current.defaults }
        if (value === NONE) delete defaults[kind]; else defaults[kind] = value
        change({ ...current, defaults })
      }}><SelectTrigger aria-label={`${LABELS[kind]}默认方案`}><SelectValue /></SelectTrigger><SelectContent><SelectItem value={NONE}>未指定，由 Agent 选择</SelectItem>{current.entries.filter(item => item.kind === kind).map(item => <SelectItem key={item.id} value={item.id} disabled={!optionFor(item)?.available}>{item.name}{!optionFor(item)?.available ? '（不可用）' : ''}</SelectItem>)}</SelectContent></Select></label>)}</div>
      <div className="vp-row"><strong>{inherited ? '已继承的模型与服务' : '作品模型与服务'} <span className="vp-muted">{groupEntries(current.entries).length}</span></strong><Button size="sm" variant="outline" disabled={!loaded || busy} onClick={() => setAdding(true)}><Plus size={14} />添加媒体能力</Button></div>
      <div className="vp-media-capabilities">{groupEntries(current.entries).map(group => {
        const entry = group[0]!
        const option = optionFor(entry)
        const connection = entry.source.type === 'connection'
        return <article className="vp-card vp-media-capability" key={entry.id} data-media-source={entry.source.type}>
          <div className="vp-row"><strong>{entry.name}</strong>{group.map(item => <span key={item.id} className="vp-badge">{LABELS[item.kind]}</span>)}<span className="vp-muted">{!loaded ? '待读取目录' : option?.available ? connection ? '服务配置可用 · 未验证输出' : '已接入 · 未验证' : '不可用'}</span></div>
          <p className="vp-muted vp-summary">{sourceLabel(entry)}</p>
          {loaded && !option?.available && <p className="vp-error">{option?.unavailableReason || '全局配置已删除或当前目录不再提供此能力'}</p>}
          <p className="vp-muted">{connection ? '工作流由 Agent 按任务选择；生成前验证工作流与服务匹配。' : option?.constraints.maxImageReferences === undefined ? '参考素材按实际接入方式校验' : `当前适配器最多支持 ${option.constraints.maxImageReferences} 张图片参考`}</p>
          <div className="vp-row">{!connection && <><span className="vp-muted">{Object.entries(entry.parameters).map(([key, value]) => `${key}: ${value}`).join(' · ') || '使用默认参数'}</span><Button className="ml-auto" size="sm" variant="ghost" disabled={busy || !loaded || !option} onClick={() => setEditing({ ...entry, parameters: { ...entry.parameters } })}>参数</Button></>}<Button className={connection ? 'ml-auto' : undefined} size="sm" variant="ghost" disabled={busy} onClick={() => remove(group)}>移除</Button></div>
        </article>
      })}</div>
      {!current.entries.length && <div className="vp-card vp-muted">当前作品未启用媒体能力。添加后保存，Agent 才可使用对应模型或工作流制作。</div>}
    </>}
    <footer className="vp-form-footer"><span className="vp-muted mr-auto">{draft ? '有未保存修改' : configuration ? `配置版本 ${configuration.revision}` : '尚未保存作品配置'}</span>{draft && <Button variant="outline" disabled={busy} onClick={() => { setDraft(null); setEditing(null) }}>撤销修改</Button>}<Button disabled={busy || loading || !loaded || stale || (!!configuration && !draft)} onClick={() => onSave(current, () => setDraft(null))}>{busy ? '保存中…' : '保存配置'}</Button></footer>
    <Dialog open={active && adding} onOpenChange={setAdding}><DialogContent className="vp-dialog sm:max-w-[680px]">
      <DialogHeader><DialogTitle>添加媒体能力</DialogTitle><DialogDescription>选择模型或 ComfyUI 服务。工作流由 Agent 按任务选择，无需手动挑选模板。</DialogDescription></DialogHeader>
      <div className="vp-row"><Input className="min-w-0 flex-1" aria-label="搜索媒体能力" placeholder="搜索模型或服务" value={search} onChange={event => setSearch(event.target.value)} /><Select value={filter} onValueChange={setFilter}><SelectTrigger className="w-[100px]" aria-label="能力类型"><SelectValue /></SelectTrigger><SelectContent><SelectItem value="all">全部</SelectItem>{KINDS.map(kind => <SelectItem key={kind} value={kind}>{LABELS[kind]}</SelectItem>)}</SelectContent></Select></div>
      <div className="vp-form-body vp-media-catalog">{groupEntries(filteredOptions).map(group => {
        const option = group[0]!
        const joined = group.every(item => current.entries.some(entry => entry.id === item.id))
        return <article className="vp-card" key={option.id} data-media-source={option.source.type}><div className="vp-row"><strong>{option.name}</strong>{group.map(item => <span key={item.id} className="vp-badge">{LABELS[item.kind]}</span>)}<Button size="sm" variant="outline" disabled={busy || !group.some(item => item.available) || joined} onClick={() => add(group)}>{joined ? inherited ? '已继承' : '已加入' : '加入'}</Button></div><p className="vp-muted vp-summary">{sourceLabel(option)}</p><p className="vp-muted">{option.available ? option.source.type === 'connection' ? '服务配置可用；工作流由 Agent 按任务选择，生成前验证工作流与服务匹配。' : '已接入，尚未验证服务在线状态' : option.unavailableReason || '不可用'}</p></article>
      })}{!filteredOptions.length && <p className="vp-muted">没有匹配的模型或服务，可前往全局媒体设置添加。</p>}</div>
      <footer className="vp-form-footer"><Button variant="ghost" onClick={openSettings}>全局媒体设置</Button><Button onClick={() => setAdding(false)}>完成选择</Button></footer>
    </DialogContent></Dialog>
    <Dialog open={active && !!editing} onOpenChange={open => { if (!open) setEditing(null) }}><DialogContent className="vp-dialog sm:max-w-[560px]"><DialogHeader><DialogTitle>{editing?.name} · 默认参数</DialogTitle><DialogDescription>仅展示当前接入方式实际支持的参数。应用后需保存作品配置。</DialogDescription></DialogHeader><form className="vp-form" onSubmit={event => { event.preventDefault(); if (!editing || busy) return; change({ ...current, entries: current.entries.map(item => item.id === editing.id ? editing : item) }); setEditing(null) }}><div className="vp-form-body">{parameterFields.map(field => <label key={field.key}>{field.label}{field.options?.length || field.type === 'boolean' ? <Select value={String(editing?.parameters[field.key] ?? field.defaultValue ?? (field.type === 'boolean' ? false : ''))} onValueChange={value => setEditing(previous => previous ? { ...previous, parameters: { ...previous.parameters, [field.key]: field.type === 'number' ? Number(value) : field.type === 'boolean' ? value === 'true' : value } } : null)}><SelectTrigger aria-label={field.label}><SelectValue placeholder="使用默认值" /></SelectTrigger><SelectContent>{(field.options ?? [true, false]).map(value => <SelectItem key={String(value)} value={String(value)}>{typeof value === 'boolean' ? value ? '开启' : '关闭' : String(value)}</SelectItem>)}</SelectContent></Select> : <Input aria-label={field.label} type={field.type === 'number' ? 'number' : 'text'} step={field.type === 'number' ? 'any' : undefined} min={field.min} max={field.max} value={String(editing?.parameters[field.key] ?? field.defaultValue ?? '')} onChange={event => {
      const value = event.target.value
      setEditing(previous => {
        if (!previous) return null
        const parameters = { ...previous.parameters }
        if (value === '') delete parameters[field.key]; else parameters[field.key] = field.type === 'number' ? Number(value) : value
        return { ...previous, parameters }
      })
    }} />}</label>)}{!parameterFields.length && <p className="vp-muted">此接入方式暂无可配置的默认参数。</p>}</div><footer className="vp-form-footer"><Button type="button" variant="outline" onClick={() => setEditing(null)}>取消</Button><Button type="submit" disabled={busy}>应用参数</Button></footer></form></DialogContent></Dialog>
  </section>
}
