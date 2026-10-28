import { atom } from 'jotai'
import { atomFamily } from 'jotai/utils'
import type { VisualProductionReference } from '@dutydeck/shared'

/** 引用草稿按会话隔离，不写入作品或改动正文草稿。 */
const referencesAtom = atom(new Map<string, VisualProductionReference[]>())
/** 单会话引用切片，支持原子合并和精确清理。 */
export const visualProductionReferencesAtomFamily = atomFamily((sessionId: string) => atom(
  get => get(referencesAtom).get(sessionId) ?? [],
  (get, set, update: VisualProductionReference[] | ((current: VisualProductionReference[]) => VisualProductionReference[])) => {
    /** 仅当前会话参与更新，其他会话保持原状。 */
    const previous = get(referencesAtom)
    const current = previous.get(sessionId) ?? []
    const references = typeof update === 'function' ? update(current) : update
    const next = new Map(previous)
    if (references.length) next.set(sessionId, references)
    else next.delete(sessionId)
    set(referencesAtom, next)
  },
))

/** 可见工作台的当前作品按会话隔离，不参与手动引用草稿的发送清理。 */
export const currentVisualProductionReferenceAtomFamily = atomFamily((_sessionId: string) => atom<VisualProductionReference | null>(null))

/** 可见选择始终保留身份；只有同作用域快照可提供展示信息，版本由宿主执行时重读。 */
export function resolveCurrentVisualProductionReference(
  paneActive: boolean,
  context: string,
  snapshotContext: string | null,
  reference: VisualProductionReference | null,
  selected: VisualProductionReference | null,
): VisualProductionReference | null {
  if (!paneActive || !selected) return null
  /** 不将旧作品或旧会话的标题、版本装配到新选择上。 */
  const current = context === snapshotContext && reference?.productionId === selected.productionId && reference.workspaceId === selected.workspaceId ? reference : selected
  return { ...current, source: 'current-view' }
}

/** 发送时复制目标；显式对象优先，自动作品仅在工作区一致时补齐。引用本身不授权写入。 */
export function snapshotVisualProductionReferences(
  explicit: readonly VisualProductionReference[],
  current: VisualProductionReference | null,
  workspaceId: string | null | undefined,
): VisualProductionReference[] {
  /** 错工作区的显式引用交由宿主拒绝，不能悄悄切换到当前作品。 */
  const references = explicit.length ? explicit : current && current.workspaceId === workspaceId ? [{ ...current, source: 'current-view' as const }] : []
  return references.map(reference => ({ ...reference, target: { ...reference.target } }))
}
