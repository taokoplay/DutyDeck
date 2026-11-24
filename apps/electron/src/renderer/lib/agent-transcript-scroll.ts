/** 滚动视口相对两个方向的距离（CSS 像素）与当前阅读窗口。 */
export interface TranscriptEdgeInput {
  top: number
  remaining: number
  direction: 'up' | 'down' | 'initial'
  short: boolean
  reading: boolean
  /** 历史页请求已开始但 React 尚未完成提交。 */
  loading: boolean
  /** 当前导航仍在等待新页挂载并恢复滚动锚点。 */
  pendingNavigation: boolean
  hasBefore: boolean
  hasAfter: boolean
  indexRequired: boolean
}

/** 根据用户滚动方向选择相邻页；恢复锚点不应当被当成用户向下滚动。 */
export function getTranscriptScrollAction(input: TranscriptEdgeInput): 'before' | 'after' | 'tail' | null {
  // 边缘事件可能在同一帧内连续到达；等待当前页完成提交和锚点恢复后再允许下一次导航。
  if (input.loading || input.pendingNavigation) return null
  const preloadDistance = 120
  if (input.indexRequired && input.short) return 'tail'
  if (input.hasBefore && input.top <= preloadDistance && (input.direction === 'up' || (input.short && input.direction === 'initial'))) return 'before'
  if (input.reading && input.direction === 'down') {
    if (input.hasAfter && input.remaining <= preloadDistance) return 'after'
    if (!input.hasAfter && input.remaining <= 2) return 'tail'
  }
  return null
}

/**
 * 判断导航请求是否可以释放边缘锁。
 * @param input 请求是否成功以及新页锚点是否已经恢复。
 * @returns 失败请求或已完成对齐时释放，否则继续等待 React 提交新页。
 */
export function shouldReleaseTranscriptNavigation(input: { succeeded: boolean; aligned: boolean }): boolean {
  return !input.succeeded || input.aligned
}
