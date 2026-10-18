import { describe, expect, it } from 'bun:test'
import * as React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import type { VisualEditingTimelineCandidate } from '@dutydeck/shared'
import { VisualEditingCandidates } from './VisualEditingCandidates'

/** 候选列表只使用结构化摘要，避免静态列表重复渲染完整时间线正文。 */
const candidate: VisualEditingTimelineCandidate = {
  id: 'candidate-1', baseRevision: 1,
  timeline: { schemaVersion: 1, id: 'timeline', productionId: 'production', episodeId: 'episode', revision: 1, baseProductionRevision: 1, tracks: [], duration: 3, createdAt: 1, updatedAt: 1 },
  operations: [{ type: 'removeClip', trackId: 'video', clipId: 'clip' }], summary: '删除片尾停顿', status: 'ready', sessionId: 'session', createdAt: 1,
}

describe('影像剪辑候选列表', () => {
  it('Given Agent 候选 When 渲染 Then 显示版本、变更摘要并提供预览入口', () => {
    const html = renderToStaticMarkup(<VisualEditingCandidates candidates={[candidate]} currentRevision={1} onPreview={() => undefined} />)
    expect(html).toContain('候选修改')
    expect(html).toContain('删除片尾停顿')
    expect(html).toContain('预览候选')
  })
})
