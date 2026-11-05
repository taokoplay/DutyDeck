import * as React from 'react'

/** 每个消息面板独立持有；只保存有界布尔状态，不持有历史正文。 */
export const TranscriptPresentationContext = React.createContext<{
  targetId?: string
  generation: string
  expansions: Map<string, boolean>
} | null>(null)

export function rememberTranscriptExpansion(cache: Map<string, boolean>, key: string, expanded: boolean): void {
  cache.delete(key)
  cache.set(key, expanded)
  while (cache.size > 1000) cache.delete(cache.keys().next().value!)
}

export function useTranscriptExpansion(key: string, fallback: boolean): [boolean, React.Dispatch<React.SetStateAction<boolean>>] {
  const context = React.useContext(TranscriptPresentationContext)
  const identity = `${context?.generation ?? ''}:${key}`
  const [expanded, setExpanded] = React.useState(context?.expansions.get(identity) ?? fallback)
  const update = React.useCallback<React.Dispatch<React.SetStateAction<boolean>>>((next) => {
    setExpanded(previous => {
      const value = typeof next === 'function' ? next(previous) : next
      if (context) rememberTranscriptExpansion(context.expansions, identity, value)
      return value
    })
  }, [context, identity])
  return [expanded, update]
}

/** 搜索沿父工具链展开；块数已受展示预算限制，额外防御循环关联。 */
export function containsTargetRecord<T extends { type: string; id?: string }>(blocks: readonly T[], ids: ReadonlyMap<T, string> | undefined, children: ReadonlyMap<string, readonly T[]> | undefined, target: string): boolean {
  const pending = [...blocks]
  const seen = new Set<T>()
  while (pending.length && seen.size < 1000) {
    const block = pending.pop()!
    if (seen.has(block)) continue
    seen.add(block)
    if (ids?.get(block) === target) return true
    if (block.type === 'tool_use' && block.id) pending.push(...(children?.get(block.id) ?? []))
  }
  return false
}
