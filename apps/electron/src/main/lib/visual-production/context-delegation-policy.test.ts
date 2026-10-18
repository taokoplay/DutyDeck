import { describe, expect, test } from 'bun:test'
import { assertVisualReviewRun } from './context-delegation-policy'

describe('持久影像检查子会话恢复边界', () => {
  test('Given 普通会话 When 无扩展启动 Then原行为不变', () => {
    expect(() => assertVisualReviewRun({}, {})).not.toThrow()
  })
  test('Given 检查子会话 When 普通continue或手工重试未带可信合同 Then拒绝恢复普通工具', () => {
    expect(() => assertVisualReviewRun({ sourceVisualReviewRunId: 'r' }, {})).toThrow('VISUAL_REVIEW_RESUME_DENIED')
    expect(() => assertVisualReviewRun({ sourceVisualReviewRunId: 'r' }, { visualTaskContextPolicy: { runId: 'other' } })).toThrow('VISUAL_REVIEW_RESUME_DENIED')
  })
  test('Given 匹配宿主合同 When 工具集合包含read或未禁用Skills Then仍拒绝', () => {
    const extensions = { visualTaskContextPolicy: { runId: 'r' }, skillsMode: 'disabled' as const, allowedToolNamesMode: 'replace' as const,
      allowedToolNames: ['visual_production_inspect_media', 'visual_production_record_observation'], beforeToolCall: () => undefined }
    expect(() => assertVisualReviewRun({ sourceVisualReviewRunId: 'r' }, extensions)).not.toThrow()
    expect(() => assertVisualReviewRun({ sourceVisualReviewRunId: 'r' }, { ...extensions, allowedToolNames: [...extensions.allowedToolNames, 'read'] })).toThrow()
    expect(() => assertVisualReviewRun({ sourceVisualReviewRunId: 'r' }, { ...extensions, skillsMode: 'workspace' })).toThrow()
  })
})
