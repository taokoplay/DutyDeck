import { describe, expect, test } from 'bun:test'
import { getTranscriptScrollAction, shouldReleaseTranscriptNavigation, type TranscriptEdgeInput } from '../../lib/agent-transcript-scroll'

/** 默认模拟长会话中部；用覆盖项模拟滚动方向、边界与读取状态。 */
function input(overrides: Partial<TranscriptEdgeInput> = {}): TranscriptEdgeInput {
  return { top: 400, remaining: 400, direction: 'up', reading: false, loading: false, pendingNavigation: false, hasBefore: true,
    hasAfter: false, short: false, indexRequired: false, ...overrides }
}

describe('连续阅读边缘触发', () => {
  test('向上到达顶部区域才补旧消息；没有前页或正在离开顶部则不触发', () => {
    expect(getTranscriptScrollAction(input({ top: 120 }))).toBe('before')
    expect(getTranscriptScrollAction(input({ top: 121 }))).toBeNull()
    expect(getTranscriptScrollAction(input({ top: 0, hasBefore: false }))).toBeNull()
    expect(getTranscriptScrollAction(input({ top: 0, direction: 'down' }))).toBeNull()
  })
  test('初次定位只补不足一屏的历史，不在尾页自动请求下一页', () => {
    expect(getTranscriptScrollAction(input({ top: 0, direction: 'initial' }))).toBeNull()
    expect(getTranscriptScrollAction(input({ top: 0, direction: 'initial', short: true }))).toBe('before')
    expect(getTranscriptScrollAction(input({ remaining: 0, direction: 'down' }))).toBeNull()
  })
  test('阅读中向下自动补较新记录，只有用户抵达真实底部才跟随实时输出', () => {
    expect(getTranscriptScrollAction(input({ reading: true, remaining: 110, direction: 'down', hasAfter: true }))).toBe('after')
    expect(getTranscriptScrollAction(input({ reading: true, remaining: 110, direction: 'down' }))).toBeNull()
    expect(getTranscriptScrollAction(input({ reading: true, remaining: 1, direction: 'down' }))).toBe('tail')
    expect(getTranscriptScrollAction(input({ reading: true, remaining: 0, direction: 'up' }))).toBeNull()
  })
  test('巨型尾记录需要续扫时自动发起有界请求，不等用户点建索引', () => {
    expect(getTranscriptScrollAction(input({ direction: 'initial', short: true, indexRequired: true }))).not.toBeNull()
  })
  test('触顶后正在等待上一页提交或锚点恢复时不重复触发加载', () => {
    expect(getTranscriptScrollAction(input({ top: 0, loading: true }))).toBeNull()
    expect(getTranscriptScrollAction(input({ top: 0, pendingNavigation: true }))).toBeNull()
  })
  test('成功请求尚未完成锚点恢复时继续持有导航锁', () => {
    expect(shouldReleaseTranscriptNavigation({ succeeded: true, aligned: false })).toBe(false)
    expect(shouldReleaseTranscriptNavigation({ succeeded: true, aligned: true })).toBe(true)
    expect(shouldReleaseTranscriptNavigation({ succeeded: false, aligned: false })).toBe(true)
  })
})
