import * as React from 'react'
import { Film, X } from 'lucide-react'
import { visualProductionReferenceKey } from '@dutydeck/shared'
import type { VisualProductionReference } from '@dutydeck/shared'

/** Composer 与历史共用引用展示，只有草稿允许移除。 */
export function VisualProductionReferenceChips({ references, onRemove }: {
  references: readonly VisualProductionReference[]
  onRemove?: (reference: VisualProductionReference) => void
}): React.ReactElement | null {
  if (!references.length) return null
  return <div className="flex flex-wrap gap-1.5" data-visual-production-references>
    {references.map(reference => <span key={visualProductionReferenceKey(reference)} className="inline-flex max-w-full items-center gap-1.5 rounded-md border border-border/70 bg-muted/60 px-2 py-1 text-xs text-foreground">
      <Film className="size-3.5 shrink-0 text-primary" aria-hidden="true" />
      <span className="shrink-0 text-muted-foreground">{reference.target.kind === 'shot' ? '镜头' : reference.target.kind === 'asset' ? '资产' : '作品'}</span>
      <span className="max-w-48 truncate font-medium" title={reference.title}>{reference.title}</span>
      <span className="max-w-32 truncate text-muted-foreground" title={reference.productionTitle}>{reference.productionTitle}</span>
      <span className="shrink-0 text-muted-foreground">v{reference.productionRevision}</span>
      {onRemove && <button type="button" aria-label={`移除${reference.title}引用`} onClick={() => onRemove(reference)} className="flex size-5 shrink-0 items-center justify-center rounded-sm hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"><X className="size-3" /></button>}
    </span>)}
  </div>
}
