import * as React from 'react'
import { useAtom, useSetAtom } from 'jotai'
import { pluginMarketAtom, pluginMarketSearchAtom, runPluginMarketActionAtom } from '@/atoms/plugin-market-atoms'
import { PluginCompatibilityDetail } from './PluginCompatibilityDetail'
import { Button } from '@/components/ui/button'
import { SettingsCard } from './primitives'
import { PluginStaticImportView } from './PluginStaticImportView'

/** 进入页面只读取缓存；明确点击后才连接公开目录，搜索/分页不联网。 */
export function PluginMarketView(): React.ReactElement {
  const [state, setState] = useAtom(pluginMarketAtom)
  const [search, setSearch] = useAtom(pluginMarketSearchAtom)
  const run = useSetAtom(runPluginMarketActionAtom)
  const api = window.electronAPI.pluginMarket
  React.useEffect(() => { void run({ api, kind: 'list' }) }, [api, run])
  const page = state.page
  const offset = state.query.offset ?? 0
  const list = (next: number, submittedSearch?: string): void => {
    void run({ api, kind: 'list', query: { offset: next, ...(submittedSearch !== undefined ? { query: submittedSearch } : {}) } })
  }
  return <div className="space-y-4"><SettingsCard><section aria-label="社区插件目录" className="space-y-4 p-5">
    <div className="flex flex-wrap items-start justify-between gap-3">
      <div className="min-w-0 flex-1"><h2 className="font-medium">社区插件目录 · 只读预览</h2>
        <p className="mt-1 text-sm text-muted-foreground">目录不等于兼容或安全认证。不会自动下载插件包、执行脚本或启用插件。</p>
      </div>
      <Button variant="outline" disabled={state.busy} onClick={() => { void run({ api, kind: 'refresh' }) }}>{state.busy ? '正在读取…' : page?.fetchedAt ? '联网刷新目录' : '加载社区目录（联网）'}</Button>
    </div>
    <p className="break-all text-xs text-muted-foreground">来源：{page?.sourceUrl ?? 'https://cdn.jsdelivr.net/npm/dsh-plugin-catalog/index.json'}。只有点击加载或刷新才向该来源发起请求；详情中的包分析另需主动点击，不发送会话、项目或凭据。</p>
    {state.error && <p role="alert" className="rounded border border-destructive/30 p-3 text-sm text-destructive">{state.error}</p>}
    {state.busy && <p role="status" className="text-sm text-muted-foreground">正在读取目录，请稍候。</p>}
    {page?.fetchedAt && <p className="text-xs text-muted-foreground">快照时间：{new Date(page.fetchedAt).toLocaleString()} · {page.stale ? '缓存需关注，详情见提示或重新刷新' : '缓存可用'} · 来源未审查</p>}
    {page?.fetchedAt && <form className="flex gap-2" onSubmit={event => { event.preventDefault(); list(0, search) }}>
      <input aria-label="搜索社区插件" disabled={state.busy} value={search} maxLength={256} onChange={event => setSearch(event.target.value)} placeholder="搜索名称、简介或分类" className="min-w-0 flex-1 rounded border border-border bg-background px-3 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring" />
      <Button type="submit" variant="outline" disabled={state.busy}>搜索缓存</Button>
    </form>}
    {!page?.fetchedAt && !state.busy && <p className="text-sm text-muted-foreground">尚未加载社区目录。你也可以继续使用上方的本地插件导入。</p>}
    {page?.fetchedAt && page.total === 0 && <p className="text-sm text-muted-foreground">当前缓存中没有匹配的插件。</p>}
    <div className="grid gap-3 md:grid-cols-2">{page?.entries.map(entry => <button type="button" key={entry.name} disabled={state.busy} onClick={() => void run({ api, kind: 'detail', name: entry.name })} className="min-w-0 rounded-lg border border-border bg-background/40 p-4 text-left hover:bg-muted/30 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-60">
      <div className="flex flex-wrap justify-between gap-2"><h3 className="break-all text-sm font-medium">{entry.title}</h3><span className="text-xs text-muted-foreground">待分析</span></div>
      <p className="mt-1 break-all font-mono text-xs text-muted-foreground">{entry.name}</p>
      <p className="mt-2 line-clamp-3 break-words text-sm text-muted-foreground">{entry.description || '暂无简介'}</p>
      <p className="mt-3 text-xs text-muted-foreground">{entry.category ?? '未分类'} · {entry.versions.length} 个声明版本 · 查看诊断</p>
    </button>)}</div>
    {page?.fetchedAt && <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-muted-foreground">
      <span>匹配 {page.total} 项 · 当前 {page.entries.length ? offset + 1 : 0}–{page.entries.length ? offset + page.entries.length : 0}</span>
      <div className="flex gap-2"><Button variant="outline" disabled={state.busy || offset === 0} onClick={() => list(Math.max(0, offset - 30))}>上一页</Button><Button variant="outline" disabled={state.busy || page.nextOffset === null} onClick={() => list(page.nextOffset ?? 0)}>下一页</Button></div>
    </div>}
    <PluginCompatibilityDetail report={state.detail} busy={state.busy} error={state.error} onAnalyze={version => void run({ api, kind: 'analyze', version })} onClose={() => setState(current => ({ ...current, detail: null }))} />
  </section></SettingsCard><PluginStaticImportView /></div>
}
