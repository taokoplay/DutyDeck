import * as React from 'react'
import { createRoot } from 'react-dom/client'
import type { VisualEditingTimelineSnapshot, VisualProductionSnapshot } from '@dutydeck/shared'
import { VisualEditingWorkspace } from '../src/renderer/components/visual-production/VisualEditingWorkspace'

/** 由烟测脚本注入的离线测试视频，不读取用户媒体。 */
declare const __EDITING_SMOKE_VIDEO__: number[]
/** 所有模拟读取用于检查隐藏预览是否仍请求媒体。 */
const calls: string[] = []
/** 最小作品快照；正式与待审媒体使用不同身份。 */
const snapshot: VisualProductionSnapshot = {
  document: { schemaVersion: 1, id: 'production', revision: 3, title: '预览切换测试', kind: 'film', brief: '', ratio: '16:9', fps: 24, voice: '', music: '', episodes: [{ id: 'episode', title: '第一集' }, { id: 'other', title: '第二集' }], assets: [], shots: [], createdAt: 1, updatedAt: 1 },
  media: ['formal', 'review'].map(id => ({ id, name: id, hash: 'a'.repeat(64), mime: 'video/mp4', kind: 'video', byteSize: __EDITING_SMOKE_VIDEO__.length, createdAt: 1 })),
  assetVersions: {}, shotStates: {}, candidates: [], jobs: [],
}
/** 可变测试回执仅模拟后台任务变化，不执行真实写入。 */
const timeline: VisualEditingTimelineSnapshot = {
  timeline: { schemaVersion: 1, id: 'timeline', productionId: 'production', episodeId: 'episode', revision: 2, baseProductionRevision: 3, tracks: [{ id: 'video', kind: 'video', clips: ['one', 'two'].map((id, index) => ({ id, label: id, source: { type: 'shot-media', shotId: id, mediaId: 'formal', mediaHash: 'a'.repeat(64), shotOutputVersion: 1 }, start: index * 2, duration: 2, sourceIn: 0, sourceOut: 2 })) }], duration: 4, createdAt: 1, updatedAt: 1 },
  candidates: [], needsReplacementClipIds: [],
  exportJobs: [{ id: 'preview', productionId: 'production', episodeId: 'episode', timelineRevision: 2, sourceHashes: [], settings: { ratio: '16:9', fps: 24, includeVoice: true, includeMusic: true, includeCaptions: false }, status: 'completed', artifactMediaId: 'review', createdAt: 1, updatedAt: 1, preview: { productionRevision: 3, candidateIds: ['candidate'], range: { start: 0, end: 2 } } }],
}
/** 模拟 IPC 只允许读取，错误调用立即暴露。 */
Object.defineProperty(window, 'electronAPI', { value: { visualProduction: { invoke: async (method: string, input: { mediaId?: string }): Promise<unknown> => {
  calls.push(method === 'mediaContent' ? `media:${input.mediaId}` : method)
  if (method === 'loadTimeline') return structuredClone(timeline)
  if (method === 'mediaContent') return { mime: 'video/mp4', bytes: __EDITING_SMOKE_VIDEO__ }
  throw new Error(`不应调用写操作：${method}`)
} } } })
/** 独立挂载完整工作台，暴露最小测试控制以模拟后台回执和切集。 */
function Fixture(): React.ReactElement {
  /** 模拟用户切集、面板隐藏及后台快照刷新。 */
  const [episodeId, setEpisodeId] = React.useState('episode')
  const [active, setActive] = React.useState(true)
  const [revision, setRevision] = React.useState(0)
  Object.assign(window, { editingSmoke: { calls, timeline, setEpisodeId, setActive, refresh: () => setRevision(value => value + 1) } })
  return <VisualEditingWorkspace sessionId="session" productionId="production" snapshot={{ ...snapshot, document: { ...snapshot.document, revision: 3 + revision } }} episodeId={episodeId} active={active} onEpisodeChange={setEpisodeId} />
}

createRoot(document.getElementById('root')!).render(<Fixture />)
