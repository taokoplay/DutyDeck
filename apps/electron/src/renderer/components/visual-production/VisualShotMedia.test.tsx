import { describe, expect, it } from 'bun:test'
import * as React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import type { VisualProductionSnapshot, VisualShot } from '@dutydeck/shared'
import { VisualShotMedia } from './VisualShotMedia'

/** 最小镜头与作品用于验证生成设计在真实工作台中可见。 */
const shot: VisualShot = {
  id: 'shot', episodeId: 'episode', title: '连续动作', duration: 5, scene: '', motion: '', dialogue: '',
  assetIds: [], mediaId: null, outputs: { image: null, video: null, audio: null },
  continuityPlan: { entryState: '角色左掌贴住盘面', exitState: '白光从盘面亮起', anchors: [{ phase: 'contact', state: '手掌与盘面接触', assetId: null }], audioTransition: 'prelap', rationale: '接触瞬间由声音先入提示能量启动。' },
  videoPlan: { mode: 'first-last-frame', firstFrameAssetId: null, lastFrameAssetId: 'tail', transitionIn: 'match-cut', rationale: '动作终点必须与下一镜一致。' },
}
const snapshot: VisualProductionSnapshot = {
  document: { schemaVersion: 1, id: 'production', revision: 1, createdAt: 1, updatedAt: 1, title: '作品', kind: 'film', brief: '', ratio: '16:9', fps: 24, voice: '', music: '', episodes: [{ id: 'episode', title: '第一集' }], assets: [], shots: [shot] },
  media: [], assetVersions: {}, shotStates: {}, candidates: [], jobs: [],
}

describe('分镜视频生成设计', () => {
  it('Given Agent 选择首尾帧和匹配剪辑 When 渲染主舞台 Then 同时展示生成方式和转场依据', () => {
    const html = renderToStaticMarkup(<VisualShotMedia sessionId="session" snapshot={snapshot} shot={shot} active={false} playing={false} onEnded={() => undefined} onError={() => undefined} onAudioPlay={() => undefined} onPause={() => undefined} onPreviewCandidate={() => undefined} onEditSound={() => undefined} />)
    expect(html).toContain('首尾帧驱动 · 入场匹配剪辑')
    expect(html).toContain('动作终点必须与下一镜一致。')
    expect(html).toContain('角色左掌贴住盘面')
    expect(html).toContain('声音先入 · 1 个动作锚点')
  })

  it('Given 新影片候选尚未审核 When 渲染主舞台 Then 提示审核后才能采用', () => {
    const candidateShot = { ...shot, outputs: { image: null, video: 'video', audio: null }, mediaId: 'video' }
    const candidateSnapshot = {
      ...snapshot,
      document: { ...snapshot.document, shots: [shot] },
      media: [{ id: 'video', name: '视频', hash: 'a'.repeat(64), mime: 'video/mp4', kind: 'video' as const, byteSize: 1, createdAt: 1 }],
      jobs: [{ id: 'job', sessionId: 'session', baseRevision: 1, shotId: shot.id, instruction: '生成', status: 'candidate' as const, createdAt: 1 }],
      candidates: [{ id: 'candidate', baseRevision: 1, jobId: 'job', draft: { ...snapshot.document, shots: [candidateShot] }, summary: '待审视频', status: 'ready' as const, reviewRequired: true, createdAt: 2 }],
    }
    const html = renderToStaticMarkup(<VisualShotMedia sessionId="session" snapshot={candidateSnapshot} shot={shot} active={false} playing={false} onEnded={() => undefined} onError={() => undefined} onAudioPlay={() => undefined} onPause={() => undefined} onPreviewCandidate={() => undefined} onEditSound={() => undefined} />)
    expect(html).toContain('视频待审核')
  })

  it('Given 首尾帧生成设计 When 渲染主舞台 Then 同时展示首帧、尾帧和来源', () => {
    const frameShot: VisualShot = {
      ...shot,
      id: 'framed-shot',
      mediaId: 'first',
      outputs: { image: 'first', video: null, audio: null },
      assetIds: ['tail-asset'],
      videoPlan: {
        mode: 'first-last-frame',
        firstFrameAssetId: null,
        lastFrameAssetId: 'tail-asset',
        transitionIn: 'hard-cut',
        rationale: '用首尾帧约束抬头终点。',
      },
    }
    const frameSnapshot: VisualProductionSnapshot = {
      ...snapshot,
      document: {
        ...snapshot.document,
        shots: [frameShot],
        assets: [{ id: 'tail-asset', name: '抬头看左尾帧', type: '场景', description: '', locked: false, mediaId: 'last' }],
      },
      media: [
        { id: 'first', name: '古代态首帧', hash: 'a'.repeat(64), mime: 'image/png', kind: 'image', byteSize: 1, createdAt: 1 },
        { id: 'last', name: '抬头看左尾帧', hash: 'b'.repeat(64), mime: 'image/png', kind: 'image', byteSize: 1, createdAt: 2 },
      ],
    }
    const html = renderToStaticMarkup(<VisualShotMedia sessionId="session" snapshot={frameSnapshot} shot={frameShot} active={false} playing={false} onEnded={() => undefined} onError={() => undefined} onAudioPlay={() => undefined} onPause={() => undefined} onPreviewCandidate={() => undefined} onEditSound={() => undefined} />)
    expect(html).toContain('首帧')
    expect(html).toContain('尾帧')
    expect(html).toContain('当前已采用画面')
    expect(html).toContain('抬头看左尾帧')
    /** 首帧就是当前采用画面时，画面参考区只保留一张卡，不再重复渲染同一媒体。 */
    expect(html.match(/data-reference-role="first"/g)).toHaveLength(1)
    expect(html.match(/data-reference-role="last"/g)).toHaveLength(1)
    expect(html).not.toContain('data-reference-role="image"')
  })

  it('Given 首帧使用独立资产 When 渲染画面参考 Then 首帧与已采用画面分别展示', () => {
    const independentShot: VisualShot = {
      ...shot,
      id: 'independent-frame-shot',
      mediaId: 'adopted',
      outputs: { image: 'adopted', video: null, audio: null },
      assetIds: ['first-asset', 'tail-asset'],
      videoPlan: {
        mode: 'first-last-frame',
        firstFrameAssetId: 'first-asset',
        lastFrameAssetId: 'tail-asset',
        transitionIn: 'hard-cut',
        rationale: '显式首尾帧与旧画面均需可核对。',
      },
    }
    const independentSnapshot: VisualProductionSnapshot = {
      ...snapshot,
      document: {
        ...snapshot.document,
        shots: [independentShot],
        assets: [
          { id: 'first-asset', name: '显式首帧', type: '场景', description: '', locked: false, mediaId: 'first' },
          { id: 'tail-asset', name: '尾帧', type: '场景', description: '', locked: false, mediaId: 'last' },
        ],
      },
      media: [
        { id: 'adopted', name: '已采用画面', hash: 'a'.repeat(64), mime: 'image/png', kind: 'image', byteSize: 1, createdAt: 1 },
        { id: 'first', name: '显式首帧', hash: 'b'.repeat(64), mime: 'image/png', kind: 'image', byteSize: 1, createdAt: 2 },
        { id: 'last', name: '尾帧', hash: 'c'.repeat(64), mime: 'image/png', kind: 'image', byteSize: 1, createdAt: 3 },
      ],
    }
    const html = renderToStaticMarkup(<VisualShotMedia sessionId="session" snapshot={independentSnapshot} shot={independentShot} active={false} playing={false} onEnded={() => undefined} onError={() => undefined} onAudioPlay={() => undefined} onPause={() => undefined} onPreviewCandidate={() => undefined} onEditSound={() => undefined} />)
    expect(html).toContain('data-reference-role="first"')
    expect(html).toContain('data-reference-role="last"')
    expect(html).toContain('data-reference-role="image"')
  })

  it('Given 当前镜头媒体任务仍在运行 When 渲染主舞台 Then 展示真实阶段并说明候选会自动出现', () => {
    const runningSnapshot = {
      ...snapshot,
      jobs: [{
        id: 'job', sessionId: 'session', baseRevision: 1, shotId: shot.id, instruction: '生成影片',
        status: 'running' as const, stage: 'generating' as const, createdAt: 1,
        mediaExecutions: [{
          runId: 'run', engine: 'workflow' as const, name: '视频工作流', kind: 'video' as const,
          source: { type: 'workflow' as const, connectionId: 'comfy', workflowId: 'h3', workflowRevision: 1 },
          parameters: {}, referenceAssets: [], phase: 'running', createdAt: 2,
        }],
      }],
    }
    const html = renderToStaticMarkup(<VisualShotMedia sessionId="session" snapshot={runningSnapshot} shot={shot} active={false} playing={false} onEnded={() => undefined} onError={() => undefined} onAudioPlay={() => undefined} onPause={() => undefined} onPreviewCandidate={() => undefined} onEditSound={() => undefined} />)
    expect(html).toContain('生成中')
    expect(html).toContain('完成后自动显示为候选')
  })
})
