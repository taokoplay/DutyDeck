import { describe, expect, it } from 'bun:test'
import type { VisualCandidate, VisualMedia, VisualProductionSnapshot, VisualShot } from '@dutydeck/shared'
import { buildShotFrameSlots, buildShotMediaSlots, findRunningShotJob, visualJobActivityLabel, visualShotStatusLabel } from './shot-media-model'

/** 最小镜头资料，用于验证旧数据与三类候选的展示边界。 */
const shot: VisualShot = { id: 'shot', episodeId: 'episode', title: '镜头', duration: 3, scene: '', motion: '', dialogue: '', assetIds: [], mediaId: 'image' }
/** 媒体只使用元数据，不读取真实文件。 */
const media: VisualMedia[] = (['image', 'video', 'audio'] as const).map(kind => ({ id: kind, kind, name: `${kind}素材`, hash: kind, mime: `${kind}/test`, byteSize: 1, createdAt: 1 }))
/** 创建同一版本的旧格式候选，保留真实整份草稿结构。 */
function fixture(): VisualProductionSnapshot {
  return { document: { schemaVersion: 1, id: 'production', revision: 2, createdAt: 1, updatedAt: 1, title: '作品', kind: 'film', brief: '', ratio: '16:9', fps: 24, voice: '', music: '', episodes: [{ id: 'episode', title: '一' }], assets: [], shots: [shot] }, media, shotStates: {}, assetVersions: {}, candidates: [], jobs: [] }
}
/** 候选来自指定镜头，正式输出不会随预览变化。 */
function candidate(snapshot: VisualProductionSnapshot, kind: 'video' | 'audio', patch: Partial<VisualCandidate> = {}): VisualCandidate {
  return { id: kind, baseRevision: 2, draft: { ...snapshot.document, shots: [kind === 'audio' ? { ...shot, outputs: { image: 'image', video: null, audio: 'audio' } } : { ...shot, mediaId: kind }] }, summary: `${kind}结果`, status: 'ready', jobId: `job-${kind}`, createdAt: 2, ...patch }
}

describe('分镜独立素材位', () => {
  it('Given 旧画面和待采用影片音频 When 展示 Then 三类位置齐全且候选不冒充正式素材', () => {
    const snapshot = fixture()
    snapshot.candidates = [candidate(snapshot, 'video'), candidate(snapshot, 'audio')]
    const slots = buildShotMediaSlots(snapshot, shot)
    expect(slots.map(slot => slot.kind)).toEqual(['image', 'video', 'audio'])
    expect(slots[0]!.adopted?.id).toBe('image')
    expect(slots[1]!.adopted).toBeUndefined()
    expect(slots[1]!.preview?.id).toBe('video')
    expect(slots[1]!.candidates.map(item => item.id)).toEqual(['video'])
    expect(slots[2]!.preview?.id).toBe('audio')
    expect(snapshot.document.shots[0]!.mediaId).toBe('image')
  })
  it('Given 过期、跨镜头和未改变输出的候选 When 展示 Then 不标成可采用的新素材', () => {
    const snapshot = fixture()
    snapshot.candidates = [candidate(snapshot, 'video', { status: 'stale' }), candidate(snapshot, 'audio', { baseRevision: 1 }), candidate(snapshot, 'video', { draft: { ...snapshot.document, shots: [{ ...shot, id: 'other', mediaId: 'video' }] } })]
    expect(buildShotMediaSlots(snapshot, shot).map(slot => slot.candidates.length)).toEqual([0, 0, 0])
  })
  it('Given 已采用三类素材和新影片候选 When 展示 Then 保留正式预览并只为变化的影片计数', () => {
    const snapshot = fixture()
    const current = { ...shot, mediaId: 'video', outputs: { image: 'image', video: 'video', audio: 'audio' } }
    snapshot.document.shots = [current]
    snapshot.media.push({ ...media[1]!, id: 'video-new' })
    snapshot.candidates = [candidate(snapshot, 'video', { draft: { ...snapshot.document, shots: [{ ...current, mediaId: 'video-new', outputs: { ...current.outputs, video: 'video-new' } }] } })]
    const slots = buildShotMediaSlots(snapshot, current)
    expect(slots.map(slot => slot.adopted?.id)).toEqual(['image', 'video', 'audio'])
    expect(slots.map(slot => slot.candidates.length)).toEqual([0, 1, 0])
    expect(slots[1]!.preview?.id).toBe('video')
  })
  it('Given 只有静帧 When 展示分镜 Then 影片主槽保持空状态且画面仍是独立参考', () => {
    const snapshot = fixture()
    const slots = buildShotMediaSlots(snapshot, shot)
    expect(slots.find(item => item.kind === 'video')?.preview).toBeUndefined()
    expect(slots.find(item => item.kind === 'image')?.preview?.id).toBe('image')
  })
})

describe('镜头制作任务状态', () => {
  it('Given 同一镜头有多个任务 When 查找运行中任务 Then 只返回最新运行任务和真实媒体阶段', () => {
    const snapshot = fixture()
    snapshot.jobs = [
      { id: 'older', sessionId: 'session', baseRevision: 2, shotId: shot.id, instruction: '旧任务', status: 'running', stage: 'preparing', createdAt: 1 },
      {
        id: 'newer',
        sessionId: 'session',
        baseRevision: 2,
        shotId: shot.id,
        instruction: '新任务',
        status: 'running',
        stage: 'generating',
        createdAt: 2,
        mediaExecutions: [{
          runId: 'run',
          engine: 'workflow',
          name: '视频工作流',
          kind: 'video',
          source: { type: 'workflow', connectionId: 'comfy', workflowId: 'h3', workflowRevision: 1 },
          parameters: {},
          referenceAssets: [],
          phase: 'uploading',
          createdAt: 3,
        }],
      },
      { id: 'candidate', sessionId: 'session', baseRevision: 2, shotId: shot.id, instruction: '已提交', status: 'candidate', createdAt: 4 },
    ]

    const running = findRunningShotJob(snapshot, shot.id)
    expect(running?.id).toBe('newer')
    expect(visualJobActivityLabel(running!)).toBe('上传素材')
  })

  it('Given 镜头已有静帧但影片正在生成 When 构造镜头状态 Then 优先显示真实生成阶段', () => {
    const snapshot = fixture()
    snapshot.jobs = [{
      id: 'job', sessionId: 'session', baseRevision: 2, shotId: shot.id, instruction: '生成影片',
      status: 'running', stage: 'generating', createdAt: 1,
      mediaExecutions: [{
        runId: 'run', engine: 'workflow', name: '视频工作流', kind: 'video',
        source: { type: 'workflow', connectionId: 'comfy', workflowId: 'h3', workflowRevision: 1 },
        parameters: {}, referenceAssets: [], phase: 'running', createdAt: 2,
      }],
    }]

    expect(visualShotStatusLabel(snapshot, shot)).toBe('生成中')
  })
})

describe('视频生成首尾帧', () => {
  it('Given 首尾帧计划使用当前画面和尾帧资产 When 构造生成帧 Then 首尾帧都解析为可展示媒体', () => {
    const snapshot = fixture()
    const current = {
      ...shot,
      id: 'framed-shot',
      mediaId: 'image',
      outputs: { image: 'image', video: null, audio: null },
      assetIds: ['tail'],
      videoPlan: {
        mode: 'first-last-frame' as const,
        firstFrameAssetId: null,
        lastFrameAssetId: 'tail',
        transitionIn: 'hard-cut' as const,
        rationale: '用首尾帧约束动作终点。',
      },
    }
    snapshot.document.shots = [current]
    snapshot.media.push({ ...media[0]!, id: 'tail-image', name: '抬头看左尾帧.png' })
    snapshot.document.assets = [{ id: 'tail', name: '抬头看左尾帧', type: '场景', description: '', locked: false, mediaId: 'tail-image' }]

    expect(buildShotFrameSlots(snapshot, current)).toMatchObject([
      { role: 'first', label: '首帧', sourceLabel: '当前已采用画面', state: 'ready', media: { id: 'image' } },
      { role: 'last', label: '尾帧', sourceLabel: '抬头看左尾帧', state: 'ready', media: { id: 'tail-image' } },
    ])
  })

  it('Given 尾帧资产没有媒体 When 构造生成帧 Then 明确标记尾帧缺失', () => {
    const snapshot = fixture()
    const current = {
      ...shot,
      mediaId: null,
      outputs: { image: null, video: null, audio: null },
      assetIds: ['tail'],
      videoPlan: {
        mode: 'first-last-frame' as const,
        firstFrameAssetId: null,
        lastFrameAssetId: 'tail',
        transitionIn: 'hard-cut' as const,
        rationale: '用首尾帧约束动作终点。',
      },
    }
    snapshot.document.assets = [{ id: 'tail', name: '未制作尾帧', type: '场景', description: '', locked: false, mediaId: null }]

    expect(buildShotFrameSlots(snapshot, current)).toMatchObject([
      { role: 'first', state: 'missing' },
      { role: 'last', label: '尾帧', sourceLabel: '未制作尾帧', state: 'missing' },
    ])
  })
})
