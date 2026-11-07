import * as React from 'react'
import { atom, useAtom } from 'jotai'
import type { InstalledModuleRuntimePluginView } from '@dutydeck/shared'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'

interface SettingsDraft { values: Record<string, unknown>; baseRevision: number; dirty: boolean }

/** 普通设置只在插件停用后编辑；重新启用时从已保存 revision 创建新实例。 */
export function PluginRuntimeSettingsPanel({ plugin, busy, onSave }: {
  plugin: InstalledModuleRuntimePluginView
  busy: boolean
  onSave(values: Record<string, unknown>, expectedSettingsRevision: number): Promise<boolean>
}): React.ReactElement {
  const draftAtom = React.useMemo(() => atom<SettingsDraft>({ values: { ...plugin.settings?.values }, baseRevision: plugin.settings?.revision ?? 0, dirty: false }), [plugin.manifest.id, plugin.packageHash])
  const [draft, setDraft] = useAtom(draftAtom)
  const currentRevision = plugin.settings?.revision ?? 0
  React.useEffect(() => {
    setDraft(previous => previous.dirty || previous.baseRevision === currentRevision ? previous : { values: { ...plugin.settings?.values }, baseRevision: currentRevision, dirty: false })
  }, [currentRevision, plugin.settings?.values, setDraft])
  const editField = (key: string, value: unknown): void => setDraft(previous => ({ ...previous, values: { ...previous.values, [key]: value }, dirty: true }))
  const fields = plugin.manifest.settings
  if (!fields.length) return <></>
  const disabled = busy || plugin.enabled
  const conflict = draft.dirty && draft.baseRevision !== currentRevision
  return <section aria-label="插件普通设置" className="space-y-3 rounded-lg border border-border/60 p-4">
    <h4 className="text-sm font-medium">普通设置 · revision {plugin.settings?.revision ?? 0}</h4>
    <p className="text-xs leading-5 text-muted-foreground">先停用再修改，保存不会自动启用。下一次启用会创建使用此设置快照的新实例。不要在普通文本设置中填写 Token 或密码。</p>
    {conflict && <div role="status" className="space-y-2 rounded border border-destructive/30 p-3 text-xs">
      <p>设置已被其他入口修改。你的草稿仍保留，保存已暂停。请比较最新值后明确选择。</p>
      <pre className="max-h-40 overflow-auto whitespace-pre-wrap break-all">{JSON.stringify(plugin.settings?.values ?? {}, null, 2)}</pre>
      <div className="flex flex-wrap gap-2">
        <Button variant="outline" size="sm" disabled={disabled} onClick={() => setDraft(previous => ({ ...previous, baseRevision: currentRevision }))}>保留草稿，确认使用最新 revision</Button>
        <Button variant="ghost" size="sm" disabled={disabled} onClick={() => setDraft({ values: { ...plugin.settings?.values }, baseRevision: currentRevision, dirty: false })}>放弃草稿，载入最新值</Button>
      </div>
    </div>}
    {fields.map(field => <label key={field.key} className="block space-y-1 text-sm">
      <span>{field.label}{field.required ? ' *' : ''}</span>
      {field.description && <span className="block text-xs text-muted-foreground">{field.description}</span>}
      {field.type === 'credentialRef' ? <span className="block text-xs text-destructive">凭据桥接尚未支持，此插件不能启用。</span>
        : field.type === 'boolean' ? <input type="checkbox" className="ml-2" checked={draft.values[field.key] === true} disabled={disabled} onChange={event => editField(field.key, event.target.checked)} />
        : field.type === 'enum' ? <select className="w-full rounded-md border border-input bg-background p-2" value={String(draft.values[field.key] ?? '')} disabled={disabled} onChange={event => editField(field.key, event.target.value)}>
          <option value="">请选择</option>{field.enumValues.map(value => <option key={value} value={value}>{value}</option>)}
        </select>
        : <Input type={field.type === 'integer' ? 'number' : 'text'} value={String(draft.values[field.key] ?? '')} disabled={disabled}
          {...(field.type === 'integer' ? { min: field.minimum, max: field.maximum, step: 1 } : { maxLength: field.maxLength ?? 4096 })}
          onChange={event => { const value = event.target.value; editField(field.key, field.type === 'integer' ? (value === '' ? undefined : Number(value)) : value) }} />}
    </label>)}
    <Button variant="outline" size="sm" disabled={disabled || conflict} onClick={() => {
      const values = Object.fromEntries(Object.entries(draft.values).filter(([, value]) => value !== undefined))
      void onSave(values, draft.baseRevision).then(saved => { if (saved) setDraft({ values, baseRevision: draft.baseRevision + 1, dirty: false }) })
    }}>保存普通设置</Button>
  </section>
}
