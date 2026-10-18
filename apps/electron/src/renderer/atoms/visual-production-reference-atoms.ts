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
