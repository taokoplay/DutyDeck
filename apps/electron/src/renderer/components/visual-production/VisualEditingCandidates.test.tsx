import { describe, expect, it } from 'bun:test'
import * as React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import type { VisualEditingTimelineCandidate } from '@dutydeck/shared'
import { VisualEditingCandidates, VisualCandidatePlayback, VisualNativePreview } from './VisualEditingCandidates'

/** 候选列表只使用结构化摘要，避免静态列表重复渲染完整时间线正文。 */
const candidate: VisualEditingTimelineCandidate = {
  id: 'candidate-1', baseRevision: 1,
  timeline: { schemaVersion: 1, id: 'timeline', productionId: 'production', episodeId: 'episode', revision: 1, baseProductionRevision: 1, tracks: [], duration: 3, createdAt: 1, updatedAt: 1 },
  operations: [{ type: 'removeClip', trackId: 'video', clipId: 'clip' }], summary: '删除片尾停顿', status: 'ready', sessionId: 'session', createdAt: 1,
}

describe('影像剪辑候选列表', () => {
  it('Given 未采用候选 When 打开预演 Then 显示候选来源片段且不修改候选', () => {
    const draft = { ...candidate, timeline: { ...candidate.timeline, tracks: [{ id: 'video', kind: 'video' as const, clips: [{ id: 'draft-clip', label: '候选专属画面', start: 0, duration: 2, sourceIn: 3, sourceOut: 5 }] }] } }
    const before = JSON.stringify(draft)
    const html = renderToStaticMarkup(<VisualCandidatePlayback candidate={draft} media={[]} sessionId="session" productionId="production" active />)
    expect(html).toContain('候选专属画面')
    expect(html).toContain('逐片段预演')
    expect(html).toContain('3.00')
    expect(JSON.stringify(draft)).toBe(before)
  })

  it('Given 原生预览任务 When 渲染 Then 区分非正式和冻结范围并显示失败原因', () => {
    const html = renderToStaticMarkup(<VisualNativePreview job={{ id: 'preview', productionId: 'production', episodeId: 'episode', timelineRevision: 2, sourceHashes: [], settings: { ratio: '9:16', fps: 24, includeVoice: true, includeMusic: true, includeCaptions: false }, status: 'failed', message: '音轨素材缺失', createdAt: 1, updatedAt: 1, preview: { productionRevision: 38, candidateIds: ['candidate'], range: { start: 0, end: 10.5 } } }} media={[]} sessionId="session" productionId="production" active />)
    expect(html).toContain('待审声画预览')
    expect(html).toContain('非正式')
    expect(html).toContain('38')
    expect(html).toContain('10.50')
    expect(html).toContain('音轨素材缺失')
  })
  it('Given Agent 候选 When 渲染 Then 显示版本、变更摘要并提供预览入口', () => {
    const html = renderToStaticMarkup(<VisualEditingCandidates candidates={[candidate]} currentRevision={1} onPreview={() => undefined} />)
    expect(html).toContain('候选修改')
    expect(html).toContain('删除片尾停顿')
    expect(html).toContain('预览候选')
  })
})
