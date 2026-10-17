import { describe, expect, it } from 'bun:test'
import * as React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import type { VisualEditingDocument } from '@dutydeck/shared'
import { VisualEditingTimeline } from './VisualEditingTimeline'

/** 供静态渲染测试使用的最小时间线。 */
const timeline: VisualEditingDocument = { schemaVersion: 1, id: 'timeline', productionId: 'production', episodeId: 'episode', revision: 1, baseProductionRevision: 2, tracks: [{ id: 'video', kind: 'video', clips: [{ id: 'clip', source: { type: 'shot-media', shotId: 'shot', mediaId: 'media', mediaHash: 'a'.repeat(64), shotOutputVersion: 1 }, start: 0, duration: 3, sourceIn: 0, sourceOut: 3, label: '开场' }] }], duration: 3, createdAt: 1, updatedAt: 1 }

describe('影像剪辑时间线视图', () => {
  it('Given 时间线和失效片段 When 渲染 Then 展示轨道、时长和替换提示', () => {
    const html = renderToStaticMarkup(<VisualEditingTimeline timeline={timeline} selectedClipId="clip" needsReplacementClipIds={['clip']} onSelect={() => undefined} />)
    expect(html).toContain('时间线')
    expect(html).toContain('3.0 秒')
    expect(html).toContain('需替换')
    expect(html).toContain('源镜头有新版本')
  })
})
