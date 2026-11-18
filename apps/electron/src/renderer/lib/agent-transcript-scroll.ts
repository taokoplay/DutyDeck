/** 滚动视口相对两个方向的距离（CSS 像素）与当前阅读窗口。 */
export interface TranscriptEdgeInput {
  top: number
  remaining: number
  direction: 'up' | 'down' | 'initial'
  short: boolean
  reading: boolean
  hasBefore: boolean
  hasAfter: boolean
  indexRequired: boolean
}

/** 根据用户滚动方向选择相邻页；恢复锚点不应当被当成用户向下滚动。 */
export function getTranscriptScrollAction(input: TranscriptEdgeInput): 'before' | 'after' | 'tail' | null {
  const preloadDistance = 120
  if (input.indexRequired && input.short) return 'tail'
  if (input.hasBefore && input.top <= preloadDistance && (input.direction === 'up' || (input.short && input.direction === 'initial'))) return 'before'
  if (input.reading && input.direction === 'down') {
    if (input.hasAfter && input.remaining <= preloadDistance) return 'after'
    if (!input.hasAfter && input.remaining <= 2) return 'tail'
  }
  return null
}
